import * as S from '@stellar/stellar-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { add, cashInMemo, fromDecimal, sameAsset, type AssetId, type Money, type Sep24Callback } from '@corra/shared';
import type { Deposit as ChainCredit, StellarGateway } from '@corra/stellar';
import { createDeposits, DEPOSIT_EXPIRY_MS, InMemoryDepositStore } from './deposits';
import type { SagaError } from './errors';

const ISSUER = S.Keypair.random().publicKey();
const ANCHOR = S.Keypair.random().publicKey();
const MXN: AssetId = { code: 'TESTMXN', issuer: ISSUER };
const PHP: AssetId = { code: 'TESTPHP', issuer: ISSUER };
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;

type Credit = ChainCredit & { from: string; account: string; asset: AssetId; memo?: string };

/** Just enough Horizon: credits filtered the way findDeposit filters them, summed by memo. */
class FakeGateway implements StellarGateway {
  credits: Credit[] = [];
  /** Hash memo per transaction hash, as getTransaction reports it. */
  memos = new Map<string, string>();
  trusts = true;
  calls: { account: string; from: string; asset: AssetId; since: number; memo?: string }[] = [];

  /** Accounts whose credit walk throws, as Horizon does when it is down or times out. */
  failing = new Set<string>();
  async findDeposit(p: { account: string; from: string; asset: AssetId; since: number; memo?: string }) {
    this.calls.push(p);
    if (this.failing.has(p.account)) throw new Error('horizon down');
    const hits = this.credits
      .filter((c) => c.account === p.account && c.from === p.from && sameAsset(c.asset, p.asset) && c.at >= p.since && c.memo === p.memo)
      .sort((a, b) => a.at - b.at);
    if (!hits.length) return null;
    const last = hits[hits.length - 1];
    return { hash: last.hash, at: last.at, amount: hits.slice(0, -1).reduce((s, c) => add(s, c.amount), last.amount) };
  }
  async getTransaction(hash: string) {
    const memo = this.memos.get(hash);
    return memo ? { status: 'SUCCESS' as const, ledger: 1, memoHash: memo } : { status: 'NOT_FOUND' as const };
  }
  async accountTrusts() { return this.trusts; }
  async findStrictReceivePath(): Promise<never> { throw new Error('unused'); }
  async submitPayment(): Promise<never> { throw new Error('unused'); }
  async accountSequence(): Promise<never> { throw new Error('unused'); }
  async paymentAccountOf(): Promise<never> { throw new Error('unused'); }
  async isPaymentAccountOf(): Promise<never> { throw new Error('unused'); }
  async accountBalance(): Promise<never> { throw new Error('unused'); }
}

let t: number;
let gw: FakeGateway;
let store: InMemoryDepositStore;
let deposits: ReturnType<typeof createDeposits>;
let ids: number;
const account = S.Keypair.random().publicKey();
const mxn = (d: string): Money => fromDecimal(MXN, d);

beforeEach(() => {
  t = T0;
  ids = 0;
  gw = new FakeGateway();
  store = new InMemoryDepositStore(() => t);
  deposits = createDeposits({
    store, gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR, asset: MXN,
    now: () => t, newId: (p) => `${p}_${++ids}`,
  });
});

/** The anchor pays `amount` to the deposit's account with its memo. */
let credits = 0;
function credit(d: { account: string; memo: string }, amount = mxn('500'), over: Partial<Credit> = {}) {
  const c: Credit = { hash: `tx_${++credits}`, amount, at: t, from: ANCHOR, account: d.account, asset: MXN, memo: d.memo, ...over };
  gw.credits.push(c);
  gw.memos.set(c.hash, c.memo ?? '');
  return c;
}

const callback = (ref: string, status: Sep24Callback['status'], over: Partial<Sep24Callback> = {}): Sep24Callback =>
  ({ ref, kind: 'deposit', status, at: t, raw: {}, ...over });

const code = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return (e as SagaError).code; }
  return 'NO_ERROR';
};

describe('D1 create', () => {
  it('stores a PENDING deposit with the memo of its id', async () => {
    const d = await deposits.create(account, mxn('500'));
    expect(d.id).toMatch(/^dep_/);
    expect(d.memo).toBe(await cashInMemo(d.id));
    expect(d).toMatchObject({
      status: 'PENDING', anchorRef: null, moreInfoUrl: null, credited: null, txHash: null, matchedBy: null, reason: null,
      requested: mxn('500'), createdAt: T0, updatedAt: T0,
    });
    expect(await deposits.get(d.id)).toEqual(d);
  });

  it('the default id is dep_ and 32 hex characters', async () => {
    const real = createDeposits({ store, gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR, asset: MXN });
    expect((await real.create(account, mxn('1'))).id).toMatch(/^dep_[0-9a-f]{32}$/);
  });

  it('refuses an account without the TESTMXN trustline and stores nothing', async () => {
    gw.trusts = false;
    expect(await code(() => deposits.create(account, mxn('500')))).toBe('ACCOUNT_NOT_READY');
    expect(await deposits.listByAccount(account, 50)).toEqual([]);
  });
});

describe('D2..D6 matching', () => {
  it('D2 link, then a completed callback by ref with the chain credit: CONFIRMED by ref', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    const c = credit(d);
    const out = await deposits.onCallback(callback('ap-1', 'CONFIRMED'));
    expect(out).toMatchObject({ status: 'CONFIRMED', matchedBy: 'ref', credited: mxn('500'), txHash: c.hash, anchorRef: 'ap-1' });
    expect(gw.calls.at(-1)).toEqual({ account, from: ANCHOR, asset: MXN, since: T0 - 60_000, memo: d.memo });
  });

  it('D3 a callback before the credit is visible leaves it PENDING; the reconciler confirms it later', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    expect((await deposits.onCallback(callback('ap-1', 'CONFIRMED')))!.status).toBe('PENDING');
    credit(d);
    t += 31_000;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain' });
  });

  it('D3b lost link: a memo+account callback before the credit is visible binds its ref; the chain confirms later', async () => {
    const d = await deposits.create(account, mxn('500'));
    const early = await deposits.onCallback(callback('ap-early', 'CONFIRMED', { depositMemo: d.memo, account }));
    expect(early).toMatchObject({ status: 'PENDING', anchorRef: 'ap-early' });
    credit(d);
    t += 31_000;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', anchorRef: 'ap-early' });
  });

  it('D3c lost link: a callback with a hash Horizon has not seen yet still binds by its deposit_memo', async () => {
    const d = await deposits.create(account, mxn('500'));
    const early = await deposits.onCallback(callback('ap-both', 'CONFIRMED', {
      stellarTxId: 'tx-not-yet-seen', depositMemo: d.memo, account, moreInfoUrl: 'https://a/both',
    }));
    expect(early).toMatchObject({ status: 'PENDING', anchorRef: 'ap-both', moreInfoUrl: 'https://a/both' });
    credit(d);
    t += 31_000;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', anchorRef: 'ap-both' });
  });

  it('D4 lost callback and no link: the reconciler finds the credit by memo', async () => {
    const d = await deposits.create(account, mxn('500'));
    credit(d);
    t += 10_000;
    expect(await deposits.reconcileDeposits()).toBe(0);
    expect(gw.calls).toHaveLength(0);
    t += 21_000;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', anchorRef: null });
  });

  it("D5 lost link: the callback's stellar_transaction_id carries our memo, and its ref is bound", async () => {
    const d = await deposits.create(account, mxn('500'));
    const c = credit(d);
    const out = await deposits.onCallback(callback('ap-unknown', 'CONFIRMED', { stellarTxId: c.hash, account }));
    expect(out).toMatchObject({ status: 'CONFIRMED', matchedBy: 'callback_tx', anchorRef: 'ap-unknown' });
  });

  it('D5b an anchor that reports no transaction hash: its deposit_memo and account find the deposit', async () => {
    const d = await deposits.create(account, mxn('500'));
    credit(d);
    const out = await deposits.onCallback(callback('ap-memo', 'CONFIRMED', { depositMemo: d.memo, account, moreInfoUrl: 'https://a/1' }));
    expect(out).toMatchObject({ status: 'CONFIRMED', matchedBy: 'callback_tx', anchorRef: 'ap-memo', moreInfoUrl: 'https://a/1' });
    expect(gw.calls).toHaveLength(1); // no transaction to look up, one walk for the credit
  });

  it('D5c a public memo alone names nothing: another account, or no account, is not a match', async () => {
    const d = await deposits.create(account, mxn('500'));
    credit(d);
    const attacker = S.Keypair.random().publicKey();
    expect(await deposits.onCallback(callback('ap-x', 'CONFIRMED', { depositMemo: d.memo, account: attacker, moreInfoUrl: 'https://a/x' }))).toBeNull();
    expect(await deposits.onCallback(callback('ap-y', 'CONFIRMED', { depositMemo: d.memo }))).toBeNull();
    expect(await deposits.get(d.id)).toEqual(d);

    // Nor can it take the ref of a deposit already confirmed and linked.
    await deposits.link(d.id, 'ap-real');
    t += 31_000;
    await deposits.reconcileDeposits();
    const confirmed = await deposits.get(d.id);
    expect(confirmed).toMatchObject({ status: 'CONFIRMED', anchorRef: 'ap-real' });
    await deposits.onCallback(callback('ap-x', 'CONFIRMED', { depositMemo: d.memo, account: attacker }));
    expect(await deposits.get(d.id)).toEqual(confirmed);
  });

  it("D5d a stellar_transaction_id that paid another account with the victim's memo binds nothing", async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-real');
    const before = await deposits.get(d.id);
    const attacker = S.Keypair.random().publicKey();
    // The attacker's own anchor deposit, paid to the attacker's account, carrying the victim's public memo.
    const c = credit({ account: attacker, memo: d.memo });
    expect(await deposits.onCallback(callback('ap-x', 'CONFIRMED', { stellarTxId: c.hash, account: attacker, moreInfoUrl: 'https://a/x' }))).toBeNull();
    expect(await deposits.onCallback(callback('ap-y', 'CONFIRMED', { stellarTxId: c.hash, moreInfoUrl: 'https://a/y' }))).toBeNull();
    expect(await deposits.get(d.id)).toEqual(before);
  });

  it("D5e a callback found by a client-linked ref but paid to another account stores nothing", async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-x'); // the open /link endpoint: anyone can write this ref
    const before = await deposits.get(d.id);
    credit(d);
    const attacker = S.Keypair.random().publicKey();
    expect(await deposits.onCallback(callback('ap-x', 'PENDING', { account: attacker, moreInfoUrl: 'https://a/x' }))).toBeNull();
    expect(await deposits.onCallback(callback('ap-x', 'CONFIRMED', { account: attacker, moreInfoUrl: 'https://a/x' }))).toBeNull();
    expect(await deposits.get(d.id)).toEqual(before);
  });

  it('D6 an unknown ref and an unknown memo: not ours, nothing written', async () => {
    const d = await deposits.create(account, mxn('500'));
    gw.memos.set('tx-foreign', 'someone-elses-memo');
    expect(await deposits.onCallback(callback('nope', 'CONFIRMED', { stellarTxId: 'tx-foreign', moreInfoUrl: 'https://a/x' }))).toBeNull();
    expect(await deposits.get(d.id)).toEqual(d);
  });
});

describe('D7, D8 references', () => {
  it('D7 a client link is write-once', async () => {
    const a = await deposits.create(account, mxn('500'));
    const b = await deposits.create(account, mxn('500'));
    expect((await deposits.link(a.id, 'r1')).anchorRef).toBe('r1');
    expect((await deposits.link(a.id, 'r1')).anchorRef).toBe('r1');
    expect(await code(() => deposits.link(a.id, 'r2'))).toBe('DEPOSIT_ALREADY_LINKED');
    expect(await code(() => deposits.link(b.id, 'r1'))).toBe('DEPOSIT_ALREADY_LINKED');
    expect(await code(() => deposits.link('dep_nope', 'r3'))).toBe('DEPOSIT_NOT_FOUND');

    credit(b);
    t += 31_000;
    await deposits.reconcileDeposits();
    expect((await deposits.get(b.id)).status).toBe('CONFIRMED');
    expect(await deposits.link(b.id, 'late')).toMatchObject({ status: 'CONFIRMED', anchorRef: 'late' });
  });

  it("D8 a squatted ref is corrected by the anchor's signed callback", async () => {
    const a = await deposits.create(account, mxn('500'));
    const b = await deposits.create(account, mxn('500'));
    await store.linkDepositRef(a.id, 'R'); // A held the real ref
    await deposits.link(b.id, 'bogus');    // a third party linked B
    const c = credit(b);
    const out = await deposits.onCallback(callback('R', 'CONFIRMED', { stellarTxId: c.hash, account }));
    expect(out).toMatchObject({ id: b.id, status: 'CONFIRMED', matchedBy: 'callback_tx', anchorRef: 'R' });
    expect((await deposits.get(a.id)).anchorRef).toBeNull();
  });

  it('D8b a squatted ref is corrected by a signed callback that arrives before the credit is visible', async () => {
    const b = await deposits.create(account, mxn('500'));
    await deposits.link(b.id, 'bogus');
    gw.memos.set('tx-lag', b.memo); // the transaction is known, the credit walk lags behind
    const early = await deposits.onCallback(callback('R', 'CONFIRMED', { stellarTxId: 'tx-lag', account }));
    expect(early).toMatchObject({ id: b.id, status: 'PENDING', anchorRef: 'R' });
    credit(b);
    t += 31_000;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(b.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', anchorRef: 'R' });
  });
});

describe('D9..D11 what a callback can and cannot do', () => {
  it('D9 a completed callback without a matching chain credit confirms nothing', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    credit({ account: S.Keypair.random().publicKey(), memo: d.memo });           // another account
    credit(d, fromDecimal(PHP, '500'), { asset: PHP });                         // another asset
    credit(d, mxn('500'), { memo: undefined });                                 // no memo
    credit(d, mxn('500'), { from: S.Keypair.random().publicKey() });            // another sender
    const out = await deposits.onCallback(callback('ap-1', 'CONFIRMED', { moreInfoUrl: 'https://anchor/tx/1' }));
    expect(out).toMatchObject({ status: 'PENDING', credited: null, txHash: null, moreInfoUrl: 'https://anchor/tx/1' });
  });

  it('D10a a short credit is recorded on the PENDING row; a second credit with the memo confirms the sum', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    const first = credit(d, mxn('1')); // e.g. a third party's anchor deposit carrying the public memo
    expect(await deposits.onCallback(callback('ap-1', 'CONFIRMED'))).toMatchObject({
      status: 'PENDING', credited: mxn('1'), txHash: first.hash, matchedBy: null, requested: mxn('500'),
    });
    t += 31_000;
    expect(await deposits.reconcileDeposits()).toBe(0);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'PENDING', credited: mxn('1') });
    const second = credit(d, mxn('500'));
    expect(await deposits.onCallback(callback('ap-1', 'CONFIRMED'))).toMatchObject({
      status: 'CONFIRMED', matchedBy: 'ref', credited: mxn('501'), txHash: second.hash, reason: null,
    });
  });

  it("D10b a short credit alone confirms after 24 h with reason 'short credit' and both figures", async () => {
    const d = await deposits.create(account, mxn('500'));
    credit(d, mxn('400'));
    t += 31_000;
    await deposits.reconcileDeposits();
    expect(await deposits.get(d.id)).toMatchObject({ status: 'PENDING', credited: mxn('400') });
    t = T0 + DEPOSIT_EXPIRY_MS;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({
      status: 'CONFIRMED', matchedBy: 'chain', reason: 'short credit', credited: mxn('400'), requested: mxn('500'),
    });

    // A short credit that arrives after expiry confirms at once.
    const late = await deposits.create(account, mxn('500'));
    t += DEPOSIT_EXPIRY_MS;
    await deposits.reconcileDeposits();
    expect((await deposits.get(late.id)).status).toBe('EXPIRED');
    credit(late, mxn('100'));
    t += HOUR;
    await deposits.reconcileDeposits();
    expect(await deposits.get(late.id)).toMatchObject({ status: 'CONFIRMED', reason: 'short credit after expiry', credited: mxn('100') });
  });

  it('D10c after confirmation, a memo+account callback with another ref does not rebind; a ref-less one binds', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    credit(d);
    const named = { depositMemo: d.memo, account };
    expect(await deposits.onCallback(callback('ap-1', 'CONFIRMED', named))).toMatchObject({ status: 'CONFIRMED', anchorRef: 'ap-1' });
    expect((await deposits.onCallback(callback('ap-2', 'CONFIRMED', named)))!.anchorRef).toBe('ap-1');
    expect((await deposits.onCallback(callback('ap-1', 'CONFIRMED', named)))!.anchorRef).toBe('ap-1');

    const e = await deposits.create(account, mxn('500'));
    credit(e);
    t += 31_000;
    await deposits.reconcileDeposits();
    expect(await deposits.get(e.id)).toMatchObject({ status: 'CONFIRMED', anchorRef: null });
    const bound = await deposits.onCallback(callback('ap-3', 'CONFIRMED', { depositMemo: e.memo, account }));
    expect(bound).toMatchObject({ id: e.id, anchorRef: 'ap-3' });
  });

  it('D11 a pending callback stores the URL without walking the chain; an error callback leaves it PENDING', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    const walks = gw.calls.length;
    const out = await deposits.onCallback(callback('ap-1', 'PENDING', { moreInfoUrl: 'https://anchor/tx/1' }));
    expect(out).toMatchObject({ status: 'PENDING', moreInfoUrl: 'https://anchor/tx/1' });
    expect(await deposits.onCallback(callback('ap-1', 'FAILED'))).toMatchObject({ status: 'PENDING', reason: null });
    expect(gw.calls).toHaveLength(walks);
  });
});

describe('D12..D14 expiry, cadence, finality', () => {
  it('D12 EXPIRED after 24 h without credit, flipped to CONFIRMED by a late credit; not after 7 days', async () => {
    const d = await deposits.create(account, mxn('500'));
    t += DEPOSIT_EXPIRY_MS;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'EXPIRED', reason: 'no credit within 24h' });
    credit(d);
    t += HOUR;
    expect(await deposits.reconcileDeposits()).toBe(1);
    expect(await deposits.get(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', reason: 'credited after expiry' });

    const old = await deposits.create(account, mxn('500'));
    t += DEPOSIT_EXPIRY_MS;
    await deposits.reconcileDeposits();
    expect((await deposits.get(old.id)).status).toBe('EXPIRED');
    t += 8 * 24 * HOUR;
    const walks = gw.calls.length;
    credit(old);
    expect(await deposits.reconcileDeposits()).toBe(0);
    expect(gw.calls).toHaveLength(walks);
    expect((await deposits.get(old.id)).status).toBe('EXPIRED');
  });

  it('D13 a young PENDING deposit is checked at most every 30 s, an EXPIRED one hourly, at most 5 per pass', async () => {
    const d = await deposits.create(account, mxn('500'));
    t += 31_000;
    await deposits.reconcileDeposits();
    t += 10_000;
    await deposits.reconcileDeposits();
    expect(gw.calls).toHaveLength(1);

    t = T0 + DEPOSIT_EXPIRY_MS;
    await deposits.reconcileDeposits();
    expect((await deposits.get(d.id)).status).toBe('EXPIRED');
    const n = gw.calls.length;
    t += HOUR - 1;
    await deposits.reconcileDeposits();
    expect(gw.calls).toHaveLength(n);
    t += 1;
    await deposits.reconcileDeposits();
    expect(gw.calls).toHaveLength(n + 1);

    gw.calls = [];
    for (let i = 0; i < 30; i++) await deposits.create(S.Keypair.random().publicKey(), mxn('1'));
    t += 31_000;
    await deposits.reconcileDeposits();
    expect(gw.calls).toHaveLength(5);
  });

  it('D13d a flood of young deposits does not starve a due mid-age one (due time, not young first)', async () => {
    const midAccount = S.Keypair.random().publicKey();
    const mid = await deposits.create(midAccount, mxn('500'));
    t = T0 + 17 * 60_000;
    await store.touchDeposit(mid.id); // last checked 3 minutes before "now": due a minute ago at the 2-minute mid cadence
    t = T0 + 20 * 60_000 - 31_000;
    for (let i = 0; i < 20; i++) await deposits.create(S.Keypair.random().publicKey(), mxn('1'));
    t = T0 + 20 * 60_000;
    // 20 young due rows cycle every 30 s at 5 a pass: young-first ordering never reached the mid one.
    for (let pass = 0; pass < 6 && !gw.calls.some((c) => c.account === midAccount); pass++) {
      const before = gw.calls.length;
      await deposits.reconcileDeposits();
      expect(gw.calls.length - before).toBeLessThanOrEqual(5);
      t += 10_000;
    }
    expect(gw.calls.some((c) => c.account === midAccount)).toBe(true);
  });

  it('D13b deposits whose check throws do not starve the others, and still expire at 24 h', async () => {
    const bad: string[] = [];
    for (let i = 0; i < 25; i++) {
      const a = S.Keypair.random().publicKey();
      gw.failing.add(a);
      bad.push((await deposits.create(a, mxn('1'))).id);
    }
    const good = await deposits.create(account, mxn('500'));
    credit(good);
    // 26 due, 5 a pass: a throwing check is still a turn, so the good one is reached within 6 passes.
    for (let pass = 0; pass < 6 && (await deposits.get(good.id)).status !== 'CONFIRMED'; pass++) {
      t += 31_000;
      await deposits.reconcileDeposits();
    }
    expect((await deposits.get(good.id)).status).toBe('CONFIRMED');
    expect((await deposits.get(bad[0])).updatedAt).toBeGreaterThan(T0);

    t = T0 + DEPOSIT_EXPIRY_MS;
    let expired = 0;
    for (let pass = 0; pass < 5; pass++) expired += await deposits.reconcileDeposits();
    expect(expired).toBe(25);
    for (const id of bad) expect(await deposits.get(id)).toMatchObject({ status: 'EXPIRED', reason: 'no credit within 24h' });
  });

  describe('reconcile cadence by age (J34, J42)', () => {
    const MIN = 60_000;
    /** Creates a deposit at T0 - age (now is T0) and makes it look checked just now. */
    async function aged(ageMs: number) {
      t = T0 - ageMs;
      const d = await deposits.create(S.Keypair.random().publicKey(), mxn('1'));
      t = T0;
      return d;
    }
    const checks = async (atMs: number) => {
      t = T0 + atMs;
      gw.calls = [];
      await deposits.reconcileDeposits();
      return gw.calls.length;
    };

    it('D-U6-1 a young deposit is due at 31 s, not at 29 s', async () => {
      await aged(0);
      expect(await checks(29_000)).toBe(0);
      expect(await checks(31_000)).toBe(1);
    });

    it('D-U6-2 a 1 h old deposit is due 2 minutes after its last check, not after 1 minute', async () => {
      const d = await aged(HOUR);
      await store.touchDeposit(d.id);
      expect(await checks(MIN)).toBe(0);
      expect(await checks(2 * MIN)).toBe(1);
    });

    it('D-U6-3 a 3 h old deposit is due 10 minutes after its last check, not after 9', async () => {
      const d = await aged(3 * HOUR);
      await store.touchDeposit(d.id);
      expect(await checks(9 * MIN)).toBe(0);
      expect(await checks(10 * MIN)).toBe(1);
    });

    it('D-U6-4 of 8 due deposits (2 young) a pass checks the 5 due longest, whatever their age', async () => {
      const old = [];
      for (let i = 0; i < 6; i++) old.push(await aged(3 * HOUR + i * MIN));
      const young = [await aged(MIN), await aged(2 * MIN)];
      gw.calls = [];
      await deposits.reconcileDeposits();
      const checked = gw.calls.map((c) => c.account);
      expect(checked).toHaveLength(5);
      // due time = updated_at + idle: the old ones fell due hours ago, the young ones seconds ago
      expect(checked).toEqual([old[5].account, old[4].account, old[3].account, old[2].account, old[1].account]);
      gw.calls = [];
      await deposits.reconcileDeposits();
      expect(gw.calls.map((c) => c.account)).toEqual([old[0].account, young[1].account, young[0].account]);
    });

    it('D-U6-5 a pass never makes more than 5 findDeposit calls', async () => {
      for (let i = 0; i < 12; i++) await aged(i * 20 * MIN);
      for (const at of [31_000, 3 * MIN, 11 * MIN, 30 * MIN]) expect(await checks(at)).toBeLessThanOrEqual(5);
    });
  });

  it('D13c a late link whose check throws still expires the deposit past 24 h', async () => {
    const a = S.Keypair.random().publicKey();
    gw.failing.add(a);
    const d = await deposits.create(a, mxn('500'));
    t += DEPOSIT_EXPIRY_MS;
    expect(await deposits.link(d.id, 'ap-x')).toMatchObject({ status: 'EXPIRED', anchorRef: 'ap-x', reason: 'no credit within 24h' });
  });

  describe('with a stalled Horizon', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('D13d a link whose chain check never returns still resolves with the ref after 10 s', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const d = await deposits.create(account, mxn('500'));
      gw.findDeposit = () => new Promise(() => {});
      const linked = deposits.link(d.id, 'ap-stall');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await linked).toMatchObject({ status: 'PENDING', anchorRef: 'ap-stall' });
    });
  });

  it('D14 a CONFIRMED deposit is never re-checked or rewritten', async () => {
    const d = await deposits.create(account, mxn('500'));
    await deposits.link(d.id, 'ap-1');
    const c = credit(d);
    const first = await deposits.onCallback(callback('ap-1', 'CONFIRMED', { stellarTxId: c.hash }));
    expect(first).toMatchObject({ status: 'CONFIRMED', matchedBy: 'ref' });
    const walks = gw.calls.length;
    credit(d, mxn('1')); // a top-up after confirmation
    expect(await deposits.onCallback(callback('ap-1', 'CONFIRMED', { stellarTxId: c.hash }))).toEqual(first);
    t += 2 * DEPOSIT_EXPIRY_MS;
    expect(await deposits.reconcileDeposits()).toBe(0);
    expect(gw.calls).toHaveLength(walks);
    expect(await deposits.get(d.id)).toEqual(first);
  });
});
