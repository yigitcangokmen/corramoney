import {
  cashInMemo,
  compare,
  sameAsset,
  toDecimal,
  type AssetId,
  type Deposit,
  type DepositMatchedBy,
  type Money,
  type Sep24Callback,
} from '@corra/shared';
import type { Deposit as ChainCredit, StellarGateway } from '@corra/stellar';
import { depositAlreadyLinked, depositNotFound, accountNotReady } from './errors';
import { withTimeout } from './saga';

/**
 * Persistence for unbound deposits. Every status change is conditional, so two writers racing
 * on one deposit end with one outcome; the database trigger backstops a CONFIRMED row.
 */
export interface DepositStore {
  createDeposit(d: Deposit): Promise<void>;
  getDeposit(id: string): Promise<Deposit | null>;
  findDepositByRef(anchorId: string, ref: string): Promise<Deposit | null>;
  findDepositByMemo(memo: string): Promise<Deposit | null>;
  /** Newest first. */
  listDepositsByAccount(account: string, limit: number): Promise<Deposit[]>;
  /** Client claim, write-once. Same ref: no-op. Another ref on this deposit, or a ref held by another deposit: depositAlreadyLinked. Unknown id: depositNotFound. Allowed in every status. */
  linkDepositRef(id: string, ref: string): Promise<Deposit>;
  /** Anchor-proven binding: clears `ref` from any other deposit and sets it here, in one transaction. */
  bindDepositRef(id: string, ref: string): Promise<Deposit>;
  /** Conditional on status <> 'CONFIRMED'; returns the row after (unchanged if it was already CONFIRMED). */
  confirmDeposit(id: string, p: { credited: Money; txHash: string; matchedBy: DepositMatchedBy; reason: string | null }): Promise<Deposit>;
  /** A credit short of the request, kept on the still-PENDING row. Conditional on status = 'PENDING'; returns the row after. */
  recordShortCredit(id: string, p: { credited: Money; txHash: string }): Promise<Deposit>;
  /** Conditional on status = 'PENDING'; returns the row after. */
  expireDeposit(id: string, reason: string): Promise<Deposit>;
  /** From the signed callback only. Any status. */
  setMoreInfoUrl(id: string, url: string): Promise<void>;
  /** Bumps updated_at after an unproductive chain check. */
  touchDeposit(id: string): Promise<void>;
  /**
   * Deposits whose turn has come: PENDING idle by age (younger than youngMs: youngIdleMs; younger than
   * midMs: midIdleMs; else oldIdleMs), or EXPIRED with updated_at <= now - expiredIdleMs and
   * created_at >= now - expiredMaxAgeMs. Ordered by due time, updated_at + its idle (then id), at most `limit`:
   * no class goes first, so a flood of young deposits cannot starve an older or EXPIRED one (a checked
   * row's due time moves past every row already due).
   */
  listOpenDeposits(now: number, p: OpenDepositsQuery): Promise<Deposit[]>;
}

export type OpenDepositsQuery = {
  youngMs: number; youngIdleMs: number; midMs: number; midIdleMs: number; oldIdleMs: number;
  expiredIdleMs: number; expiredMaxAgeMs: number; limit: number;
};

export class InMemoryDepositStore implements DepositStore {
  private deposits = new Map<string, Deposit>();

  constructor(private now: () => number = Date.now) {}

  private row(id: string) {
    const d = this.deposits.get(id);
    if (!d) throw depositNotFound();
    return d;
  }

  private byRef(anchorId: string, ref: string) {
    return [...this.deposits.values()].find((d) => d.anchorId === anchorId && d.anchorRef === ref);
  }

  async createDeposit(d: Deposit) {
    if (this.deposits.has(d.id) || [...this.deposits.values()].some((o) => o.memo === d.memo)) {
      throw new Error(`deposit ${d.id} already exists`);
    }
    this.deposits.set(d.id, structuredClone(d));
  }

  async getDeposit(id: string) {
    const d = this.deposits.get(id);
    return d ? structuredClone(d) : null;
  }

  async findDepositByRef(anchorId: string, ref: string) {
    const d = this.byRef(anchorId, ref);
    return d ? structuredClone(d) : null;
  }

  async findDepositByMemo(memo: string) {
    const d = [...this.deposits.values()].find((x) => x.memo === memo);
    return d ? structuredClone(d) : null;
  }

  async listDepositsByAccount(account: string, limit: number) {
    return [...this.deposits.values()]
      .filter((d) => d.account === account)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }

  async linkDepositRef(id: string, ref: string) {
    const d = this.row(id);
    if (d.anchorRef !== null && d.anchorRef !== ref) throw depositAlreadyLinked();
    const owner = this.byRef(d.anchorId, ref);
    if (owner && owner.id !== id) throw depositAlreadyLinked('this anchor reference belongs to another deposit');
    d.anchorRef = ref;
    d.updatedAt = this.now();
    return structuredClone(d);
  }

  async bindDepositRef(id: string, ref: string) {
    const d = this.row(id);
    for (const o of this.deposits.values()) {
      if (o.id !== id && o.anchorId === d.anchorId && o.anchorRef === ref) {
        o.anchorRef = null;
        o.updatedAt = this.now();
      }
    }
    d.anchorRef = ref;
    d.updatedAt = this.now();
    return structuredClone(d);
  }

  async confirmDeposit(id: string, p: { credited: Money; txHash: string; matchedBy: DepositMatchedBy; reason: string | null }) {
    const d = this.row(id);
    if (d.status !== 'CONFIRMED') {
      Object.assign(d, { status: 'CONFIRMED', credited: p.credited, txHash: p.txHash, matchedBy: p.matchedBy, reason: p.reason, updatedAt: this.now() });
    }
    return structuredClone(d);
  }

  async recordShortCredit(id: string, p: { credited: Money; txHash: string }) {
    const d = this.row(id);
    if (d.status === 'PENDING') Object.assign(d, { credited: p.credited, txHash: p.txHash, updatedAt: this.now() });
    return structuredClone(d);
  }

  async expireDeposit(id: string, reason: string) {
    const d = this.row(id);
    if (d.status === 'PENDING') Object.assign(d, { status: 'EXPIRED', reason, updatedAt: this.now() });
    return structuredClone(d);
  }

  async setMoreInfoUrl(id: string, url: string) {
    const d = this.deposits.get(id);
    if (!d) return;
    d.moreInfoUrl = url;
    d.updatedAt = this.now();
  }

  async touchDeposit(id: string) {
    const d = this.deposits.get(id);
    if (d && d.status !== 'CONFIRMED') d.updatedAt = this.now();
  }

  async listOpenDeposits(now: number, p: OpenDepositsQuery) {
    const young = (d: Deposit) => d.status === 'PENDING' && d.createdAt > now - p.youngMs;
    const idle = (d: Deposit) => (young(d) ? p.youngIdleMs : d.createdAt > now - p.midMs ? p.midIdleMs : p.oldIdleMs);
    const due = (d: Deposit) => d.updatedAt + (d.status === 'EXPIRED' ? p.expiredIdleMs : idle(d));
    return [...this.deposits.values()]
      .filter((d) =>
        (d.status === 'PENDING' && d.updatedAt <= now - idle(d)) ||
        (d.status === 'EXPIRED' && d.updatedAt <= now - p.expiredIdleMs && d.createdAt >= now - p.expiredMaxAgeMs))
      .sort((a, b) => due(a) - due(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .slice(0, p.limit)
      .map((d) => structuredClone(d));
  }
}

export type DepositsDeps = {
  store: DepositStore;
  gateway: StellarGateway;
  anchorId: string;
  /** Account the anchor pays deposits from. */
  anchorDistribution: string;
  /** TESTMXN with the corridor issuer: fiatAsset('MXN'). */
  asset: AssetId;
  now?: () => number;
  newId?: (prefix: string) => string;
  /** Structured events (deposit.created, deposit.confirmed, ...). Default: none. */
  log?: (line: { evt: string } & Record<string, unknown>) => void;
};

export const DEPOSIT_EXPIRY_MS = 24 * 3_600_000;
/** An EXPIRED deposit is still re-checked, hourly, for this long: a late credit flips it to CONFIRMED. */
export const LATE_CREDIT_WINDOW_MS = 7 * 24 * 3_600_000;
/**
 * How often a PENDING deposit is looked for on chain, by age: an anchor usually pays within
 * minutes, so a young one every 30 s, then every 2 minutes up to 2 hours, then every 10 minutes.
 * EXPIRED ones hourly for LATE_CREDIT_WINDOW_MS. The callback and link paths check at once.
 */
export const DEPOSIT_CADENCE = {
  youngMs: 10 * 60_000, youngIdleMs: 30_000, midMs: 2 * 3_600_000, midIdleMs: 2 * 60_000, oldIdleMs: 10 * 60_000,
  expiredIdleMs: 3_600_000, expiredMaxAgeMs: LATE_CREDIT_WINDOW_MS,
};
/** Bounds the Horizon calls one reconcile pass makes, whatever the number of open deposits. */
export const MAX_CHECKS_PER_PASS = 5;
/** The same look-back as the saga's cash-in search. */
const SINCE_SLACK_MS = 60_000;

const defaultId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

/**
 * Deposits into the user's own account, not bound to any payment. CONFIRMED only ever comes from
 * a chain credit by the anchor's distribution account carrying the deposit's memo; the anchor's
 * reference and callbacks only say where to look.
 */
export function createDeposits(deps: DepositsDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? defaultId;
  const log = deps.log ?? (() => {});
  const { store, gateway } = deps;

  async function reload(id: string) {
    const d = await store.getDeposit(id);
    if (!d) throw depositNotFound();
    return d;
  }

  async function create(account: string, amount: Money): Promise<Deposit> {
    if (!sameAsset(amount.asset, deps.asset)) throw new Error(`deposits are in ${deps.asset.code}, not ${amount.asset.code}`);
    // Without the trustline the anchor's payment can never land.
    if (!(await gateway.accountTrusts(account, deps.asset))) throw accountNotReady();
    const id = newId('dep');
    const t = now();
    const d: Deposit = {
      id, account, anchorId: deps.anchorId, anchorRef: null, moreInfoUrl: null, memo: await cashInMemo(id),
      requested: amount, credited: null, txHash: null, status: 'PENDING', matchedBy: null, reason: null,
      createdAt: t, updatedAt: t,
    };
    await store.createDeposit(d);
    log({ evt: 'deposit.created', id, account, amount: toDecimal(amount) });
    return d;
  }

  const findCredit = (d: Deposit) => gateway.findDeposit({
    account: d.account, from: deps.anchorDistribution, asset: d.requested.asset, since: d.createdAt - SINCE_SLACK_MS, memo: d.memo,
  });

  /**
   * A credit (the sum of every memo credit) confirms when it covers the request. A short one is
   * kept on the PENDING row and re-checked, since a later credit with the memo may complete it;
   * at 24 h, or on an EXPIRED deposit, it confirms as it is: the money is in the account, and
   * both figures are on the wire.
   */
  async function applyCredit(d: Deposit, credit: ChainCredit, via: DepositMatchedBy): Promise<Deposit> {
    const late = d.status === 'EXPIRED';
    const short = compare(credit.amount, d.requested) < 0;
    if (short && !late && now() - d.createdAt < DEPOSIT_EXPIRY_MS) {
      if (d.txHash !== credit.hash) {
        log({ evt: 'deposit.short_credit', id: d.id, credited: toDecimal(credit.amount), requested: toDecimal(d.requested) });
      }
      // Also counts as the check: it bumps updatedAt.
      return store.recordShortCredit(d.id, { credited: credit.amount, txHash: credit.hash });
    }
    const reason = late ? (short ? 'short credit after expiry' : 'credited after expiry') : short ? 'short credit' : null;
    const out = await store.confirmDeposit(d.id, { credited: credit.amount, txHash: credit.hash, matchedBy: via, reason });
    log({ evt: 'deposit.confirmed', id: d.id, matchedBy: out.matchedBy, late, short });
    return out;
  }

  /** One look at the chain: confirm, record a short credit, expire after 24 h, or note that it was checked. */
  async function check(d: Deposit, via: DepositMatchedBy): Promise<Deposit> {
    if (d.status === 'CONFIRMED') return d;
    const credit = await findCredit(d);
    if (credit) return applyCredit(d, credit, via);
    if (d.status === 'PENDING' && now() - d.createdAt >= DEPOSIT_EXPIRY_MS) {
      const out = await store.expireDeposit(d.id, 'no credit within 24h');
      log({ evt: 'deposit.expired', id: d.id });
      return out;
    }
    await store.touchDeposit(d.id);
    return d;
  }

  /**
   * A check that threw or timed out still counts as a turn: the row is bumped, so it leaves the
   * head of the reconciler's queue, and a PENDING one past 24 h is expired (a late credit still
   * flips it). Returns the expired row, or null.
   */
  async function checkFailed(d: Deposit, e: unknown): Promise<Deposit | null> {
    log({ evt: 'deposit.check_failed', id: d.id, error: String(e) });
    try {
      if (d.status === 'PENDING' && now() - d.createdAt >= DEPOSIT_EXPIRY_MS) {
        const out = await store.expireDeposit(d.id, 'no credit within 24h');
        log({ evt: 'deposit.expired', id: d.id });
        return out;
      }
      await store.touchDeposit(d.id);
    } catch (e2) {
      log({ evt: 'deposit.touch_failed', id: d.id, error: String(e2) });
    }
    return null;
  }

  async function link(id: string, ref: string): Promise<Deposit> {
    const row = await store.linkDepositRef(id, ref);
    log({ evt: 'deposit.linked', id, ref });
    // The link stands even when Horizon is down or stalls; the reconciler looks again.
    try {
      await withTimeout(check(row, 'chain'), 10_000);
    } catch (e) {
      await checkFailed(row, e);
    }
    return reload(id);
  }

  /**
   * The deposit a completed callback names: by the memo of its `stellar_transaction_id` on chain,
   * or, when the anchor reports no hash or Horizon does not show it yet, by its `deposit_memo`;
   * either way only when its `to` is the deposit's account (memos are public, so a memo alone is not enough).
   */
  async function namedByAnchor(ev: Sep24Callback): Promise<Deposit | null> {
    if (!ev.account) return null;
    let d: Deposit | null = null;
    if (ev.stellarTxId) {
      const t = await gateway.getTransaction(ev.stellarTxId);
      if (t.status === 'SUCCESS' && t.memoHash) d = await store.findDepositByMemo(t.memoHash);
    }
    if (!d && ev.depositMemo) d = await store.findDepositByMemo(ev.depositMemo);
    return d && d.account === ev.account ? d : null;
  }

  /** SEP-24 callback (signature already verified by the API). A trigger, never an authority. */
  async function onCallback(ev: Sep24Callback): Promise<Deposit | null> {
    const byRef = await store.findDepositByRef(deps.anchorId, ev.ref);
    let d = byRef;
    let via: DepositMatchedBy = 'ref';
    if (ev.status === 'CONFIRMED') {
      // The anchor names its payment, or the memo and account it paid: that finds the deposit even
      // when the client never linked it (lost link), or when someone linked it to a bogus ref.
      const byMemo = await namedByAnchor(ev);
      if (byMemo && byMemo.id !== byRef?.id) {
        d = byMemo;
        via = 'callback_tx';
      }
    }
    if (!d) return null;
    // A callback that paid another account says nothing about this deposit, whatever ref it carries.
    if (ev.account && ev.account !== d.account) return null;
    // The anchor's signed callback names this open deposit: its ref belongs here even before the
    // credit is visible (a lagging Horizon replica), since the reconciler never binds refs.
    if (via === 'callback_tx' && ev.status === 'CONFIRMED' && d.status !== 'CONFIRMED' && d.anchorRef !== ev.ref) {
      log({ evt: 'deposit.ref_bound', id: d.id, ref: ev.ref, replaced: d.anchorRef });
      d = await store.bindDepositRef(d.id, ev.ref);
    }
    if (ev.moreInfoUrl && ev.moreInfoUrl !== d.moreInfoUrl) await store.setMoreInfoUrl(d.id, ev.moreInfoUrl);
    if (ev.status !== 'CONFIRMED') return reload(d.id);

    let out = d;
    let confirmedHere = false;
    if (d.status !== 'CONFIRMED') {
      const credit = await findCredit(d);
      if (!credit) return reload(d.id); // early or forged: the chain decides, the reconciler retries
      out = await applyCredit(d, credit, via);
      if (out.status !== 'CONFIRMED') return out; // short: only a callback that named it bound its ref above
      confirmedHere = out.txHash === credit.hash;
    }
    // The anchor's signed callback names the very credit, or the memo and account, of this
    // confirmed deposit: its ref belongs here. On a deposit confirmed earlier, a memo and account
    // alone may only fill a missing ref; another credit's callback must not flap it.
    const named = ev.stellarTxId ? out.txHash === ev.stellarTxId : ev.depositMemo === out.memo && ev.account === out.account;
    const mayBind = confirmedHere || ev.stellarTxId === out.txHash || out.anchorRef === null;
    if (named && mayBind && out.anchorRef !== ev.ref) {
      log({ evt: 'deposit.ref_bound', id: out.id, ref: ev.ref, replaced: out.anchorRef });
      return store.bindDepositRef(out.id, ev.ref);
    }
    return reload(out.id);
  }

  let reconciling = false;

  /** Checks open deposits whose turn has come. Returns how many changed status. */
  async function reconcileDeposits(): Promise<number> {
    if (reconciling) return 0;
    reconciling = true;
    try {
      const open = await store.listOpenDeposits(now(), { ...DEPOSIT_CADENCE, limit: MAX_CHECKS_PER_PASS });
      let changed = 0;
      for (const d of open) {
        try {
          const after = await withTimeout(check(d, 'chain'), 30_000);
          if (after.status !== d.status) changed++;
        } catch (e) {
          const after = await checkFailed(d, e);
          if (after && after.status !== d.status) changed++;
        }
      }
      if (open.length) log({ evt: 'deposits.reconciled', checked: open.length, changed });
      return changed;
    } finally {
      reconciling = false;
    }
  }

  return {
    create,
    link,
    get: reload,
    listByAccount: (account: string, limit: number) => store.listDepositsByAccount(account, limit),
    onCallback,
    reconcileDeposits,
  };
}

export type Deposits = ReturnType<typeof createDeposits>;
