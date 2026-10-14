import {
  add,
  cashInMemo,
  compare,
  FIAT,
  sameAsset,
  withSlippage,
  type AssetId,
  type Corridor,
  type Payment,
  type PaymentState,
  type QuoteRequest,
  type Quote,
  type Sep24Callback,
} from '@corra/shared';
import { assertBoundPayment, signedSequence, UnboundTransactionError, type Deposit, type StellarGateway } from '@corra/stellar';
import * as E from './errors';
import { SagaError } from './errors';
import { isAllowedTransition, isTerminal } from './transitions';
import type { SagaStore } from './store';

export type AnchorQuote = { id: string; expiresAt: number };

/**
 * The cash-out leg. CREDITED means the recipient's account holds the asset AND this handler
 * acknowledged the payout. In Phase 1 it is a mock (createMockPayout); a licensed anchor's payout
 * API takes its place in Phase 2.
 */
export type PayoutHandler = { acknowledge(p: Payment): Promise<{ ref: string }> };

/** Acknowledges every payout without moving anything, and says so in its reference. */
export const createMockPayout = (): PayoutHandler => ({
  acknowledge: async (p) => ({ ref: `mock-payout:${p.publicId}` }),
});

export type SagaDeps = {
  store: SagaStore;
  gateway: StellarGateway;
  networkPassphrase: string;
  /** Issuer of the corridor test assets. */
  corridorIssuer: string;
  /** Account the anchor pays cash-in deposits from. */
  anchorDistribution: string;
  anchorId: string;
  /** Optional SEP-38 firm quote, passed through unchanged. */
  anchorQuote?: (q: { source: Quote['source']; dest: Quote['dest'] }) => Promise<AnchorQuote | null>;
  /** Defaults to the mock payout handler. */
  payout?: PayoutHandler;
  now?: () => number;
  newId?: (prefix: string) => string;
  slippageBps?: number;
  quoteTtlMs?: number;
};

export type ConfirmInput = {
  sender: string;
  recipient: string;
  signedXdr: string;
  idemKey: string;
  /** The anchor's SEP-38 firm quote for the cash-in leg, recorded unchanged. */
  anchorQuote?: AnchorQuote;
};

const defaultId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;

/** Unambiguous alphabet (no 0/O, 1/I/L). 31^6 is about 887 million ids. */
const B32 = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function publicId(): string {
  const out: string[] = [];
  while (out.length < 6) {
    for (const b of crypto.getRandomValues(new Uint8Array(8))) {
      // Rejection sampling: 248 = 8 * 31, so every symbol is equally likely.
      if (b < 248 && out.length < 6) out.push(B32[b % 31]);
    }
  }
  return 'CORRA-' + out.join('');
}

/**
 * How long after maxTime a payment must stay unseen on chain before it is declared EXPIRED.
 * A transaction cannot enter a ledger after its maxTime, so the only risk is reading from a
 * Horizon that has not ingested the last ledgers yet; this margin covers that lag.
 */
export const EXPIRY_GRACE_SEC = 120;
/** The reason recorded when the sender's own transactions used up the payment's sequence window. */
export const SEQUENCE_GONE = 'sender sequence left the signing window';
/** How many re-signs back a payment looks for a deposit it can reuse. */
const MAX_RESIGN_CHAIN = 5;

type Outcome = 'success' | 'cap_exceeded' | 'failed';
const outcomeOf = (codes?: string): Outcome =>
  codes === 'op_over_source_max' || codes === 'op_over_sendmax' ? 'cap_exceeded' : 'failed';
const firstOpCode = (codes: unknown): string | undefined => {
  const c = codes as { operations?: string[]; inner_transaction?: string; transaction?: string } | undefined;
  return c?.operations?.find((x) => x !== 'op_success') ?? c?.inner_transaction ?? c?.transaction;
};

export function createSaga(deps: SagaDeps) {
  const now = deps.now ?? Date.now;
  const payout = deps.payout ?? createMockPayout();
  const nowSec = () => Math.floor(now() / 1000);
  const newId = deps.newId ?? defaultId;
  const slippageBps = deps.slippageBps ?? 150;
  const quoteTtlMs = deps.quoteTtlMs ?? 120_000;
  const { store, gateway } = deps;

  const assetFor = (currency: string): AssetId => {
    const f = Object.values(FIAT).find((x) => x.currency === currency);
    if (!f) throw E.noPath();
    return { code: f.code, issuer: deps.corridorIssuer };
  };

  // One advance at a time per payment inside this process; the store's conditional
  // transition protects across processes.
  const inflight = new Map<string, Promise<Payment>>();

  /** Every state change goes through here, so the transition table is enforced, not just documented. */
  function move(p: Payment, to: PaymentState, patch: Parameters<SagaStore['transition']>[3], data?: Record<string, unknown>) {
    if (!isAllowedTransition(p.state, to)) throw E.illegalTransition(p.state, to);
    return store.transition(p.id, p.state, to, patch, { type: to, from: p.state, to, ...(data ? { data } : {}) });
  }

  async function quote(req: QuoteRequest): Promise<Quote> {
    const sourceAsset = assetFor(req.corridor.from.currency);
    if (!sameAsset(req.destAmount.asset, assetFor(req.corridor.to.currency))) throw E.noPath();
    const route = await gateway.findStrictReceivePath({ sourceAsset, dest: req.destAmount });
    if (!route) throw E.noPath();
    const anchor = deps.anchorQuote ? await deps.anchorQuote({ source: route.source, dest: req.destAmount }) : null;
    const q: Quote = {
      id: newId('qt'),
      mode: 'strict_receive',
      corridor: req.corridor,
      source: route.source,
      dest: req.destAmount,
      path: route.path,
      maxSend: withSlippage(route.source, slippageBps),
      slippageBps,
      expiresAt: now() + quoteTtlMs,
      ...(anchor ? { anchorQuoteId: anchor.id, anchorQuoteExpiresAt: anchor.expiresAt } : {}),
    };
    await store.saveQuote(q);
    return q;
  }

  async function createSigned(base: Quote, input: ConfirmInput, supersedesId: string | null): Promise<Payment> {
    const q: Quote = input.anchorQuote
      ? { ...base, anchorQuoteId: input.anchorQuote.id, anchorQuoteExpiresAt: input.anchorQuote.expiresAt }
      : base;
    let bound;
    try {
      bound = assertBoundPayment(
        input.signedXdr,
        { sender: input.sender, recipient: input.recipient, dest: q.dest, sendMax: q.maxSend, path: q.path },
        deps.networkPassphrase,
        nowSec(),
      );
    } catch (e) {
      if (e instanceof UnboundTransactionError) throw E.unbound(e.message);
      throw e;
    }
    if (!(await gateway.accountTrusts(input.recipient, q.dest.asset))) throw E.recipientNotReady();
    // A blob that already landed can never be settled by a new deposit: refuse before cash-in.
    if ((await gateway.getTransaction(bound.hash)).status !== 'NOT_FOUND') throw E.duplicateTransaction();

    // Two pending payments from one sender share a sequence window, so only one could ever land.
    // One already being settled blocks a new one; one still waiting for cash-in is superseded.
    const pending = await store.listBySender(input.sender, ['SIGNED', 'CASH_IN', 'ONCHAIN']);
    if (pending.some((o) => o.state !== 'SIGNED')) throw E.paymentInProgress();

    const t = now();
    let payment: Payment | undefined;
    for (let attempt = 0; !payment; attempt++) {
      const p: Payment = {
        id: newId('pmt'),
        publicId: publicId(),
        senderAccount: input.sender,
        recipientAccount: input.recipient,
        corridor: q.corridor,
        quote: q,
        state: 'SIGNED',
        legs: [{ kind: 'cash_in', status: 'PENDING', amount: q.maxSend, anchorId: deps.anchorId }],
        idemKey: input.idemKey,
        signedXdr: input.signedXdr,
        innerTxHash: bound.hash,
        maxTime: bound.maxTime,
        supersedesId,
        createdAt: t,
        updatedAt: t,
      };
      try {
        ({ payment } = await store.createPayment(p, [
          { type: 'QUOTED', from: null, to: 'QUOTED', data: { quoteId: q.id } },
          { type: 'SIGNED', from: 'QUOTED', to: 'SIGNED', data: { innerTxHash: bound.hash, maxTime: bound.maxTime } },
        ]));
      } catch (e) {
        if (!(e instanceof SagaError && e.code === 'PUBLIC_ID_TAKEN') || attempt >= 3) throw e;
      }
    }

    for (const old of pending) {
      if (old.id === payment.id) continue;
      await expire(old, 'superseded by a newer payment', { supersededBy: payment.id });
    }
    return payment;
  }

  async function liveQuote(quoteId: string) {
    const q = await store.getQuote(quoteId);
    if (!q) throw E.quoteNotFound();
    if (now() > q.expiresAt) throw E.quoteExpired();
    return q;
  }

  /** A replay must be the same request; the same key for a different one is refused. */
  function replayOf(existing: Payment, quoteId: string, input: ConfirmInput): Payment {
    const same = existing.quote.id === quoteId &&
      existing.senderAccount === input.sender && existing.recipientAccount === input.recipient;
    if (!same) throw E.idempotencyReused();
    return existing;
  }

  async function confirm(quoteId: string, input: ConfirmInput): Promise<Payment> {
    // A replay with the same idempotency key returns the same payment, even after the quote TTL.
    const existing = await store.getPaymentByIdemKey(input.idemKey);
    if (existing) return replayOf(existing, quoteId, input);
    return createSigned(await liveQuote(quoteId), input, null);
  }

  async function resign(supersedesId: string, quoteId: string, signedXdr: string, idemKey: string, anchorQuote?: AnchorQuote) {
    const old = await store.getPayment(supersedesId);
    if (!old) throw E.paymentNotFound();
    const input = { sender: old.senderAccount, recipient: old.recipientAccount, signedXdr, idemKey, anchorQuote };
    const existing = await store.getPaymentByIdemKey(idemKey);
    if (existing) return replayOf(existing, quoteId, input);
    if (old.state !== 'EXPIRED' && old.state !== 'CAP_EXCEEDED' && old.state !== 'FAILED') throw E.notResignable();
    return createSigned(await liveQuote(quoteId), input, old.id);
  }

  async function linkCashIn(paymentId: string, ref: string) {
    const p = await store.getPayment(paymentId);
    if (!p) throw E.paymentNotFound();
    const leg = p.legs.find((l) => l.kind === 'cash_in');
    if (leg?.externalRef === ref) return;
    if (leg?.externalRef || isTerminal(p.state)) throw E.cashInAlreadyLinked();
    await store.linkCashIn(p.id, deps.anchorId, ref);
  }

  /** SEP-24 callback (signature already verified by the API). A trigger, never an authority. */
  async function onCashIn(ev: Sep24Callback): Promise<Payment | null> {
    const p = await store.findPaymentByCashInRef(deps.anchorId, ev.ref);
    if (!p) return null;
    return advance(p.id);
  }

  /** Advances a payment from chain state only. Safe to call any number of times. */
  function advance(paymentId: string): Promise<Payment> {
    const running = inflight.get(paymentId);
    if (running) return running;
    const run = step(paymentId).finally(() => inflight.delete(paymentId));
    inflight.set(paymentId, run);
    return run;
  }

  const pastDeadline = (p: Payment) => nowSec() >= p.maxTime + EXPIRY_GRACE_SEC;

  async function step(paymentId: string): Promise<Payment> {
    let p = await store.getPayment(paymentId);
    if (!p) throw E.paymentNotFound();
    if (isTerminal(p.state)) return p;

    // The chain outranks the ledger: whoever submitted the signed blob (us, a concurrent
    // process, or the sender, who holds it too), a landed transaction decides the outcome.
    const landed = await gateway.getTransaction(p.innerTxHash);
    if (landed.status !== 'NOT_FOUND') {
      return settle(p, landed.status === 'SUCCESS' ? 'success' : outcomeOf(landed.codes), landed.hash ?? p.innerTxHash, landed.codes);
    }

    if (p.state === 'SIGNED') {
      if (nowSec() >= p.maxTime) {
        if (!pastDeadline(p)) return p;
        return (await expire(p, 'maxTime passed before cash-in')) ?? reload(paymentId);
      }
      // Dead before the cash-in: say so now, not after the user has paid in.
      if (await sequenceLeftWindow(p)) return (await expire(p, SEQUENCE_GONE)) ?? reload(paymentId);
      const dep = await cashInFor(p);
      if (!dep || compare(dep.amount, p.quote.maxSend) < 0) return p;
      const moved = await move(p, 'CASH_IN', { legs: [{ kind: 'cash_in', status: 'CONFIRMED', txHash: dep.hash }] },
        { depositTx: dep.hash });
      if (!moved) return reload(paymentId);
      p = moved;
    }

    if (p.state === 'ONCHAIN') return p; // only written once the transaction is known to have landed
    if (pastDeadline(p)) return (await expire(p, 'maxTime passed before the payment landed')) ?? reload(paymentId);
    if (nowSec() >= p.maxTime || !p.signedXdr) return p;

    const out = await gateway.submitPayment(p.signedXdr);
    if (out.kind === 'success') return settle(p, 'success', out.hash, undefined);
    if ((out.kind === 'cap_exceeded' || out.kind === 'failed') && out.hash) {
      const code = firstOpCode(out.codes);
      return settle(p, out.kind === 'cap_exceeded' ? 'cap_exceeded' : outcomeOf(code), out.hash, code);
    }
    if (out.kind === 'bad_seq' && (await sequenceLeftWindow(p))) {
      return (await expire(p, SEQUENCE_GONE)) ?? reload(paymentId);
    }
    // expired, bad_seq or a transient rejection: nothing landed. Retry until the deadline, then
    // expire after confirming once more that nothing landed (a concurrent submission may have won).
    return p;
  }

  /**
   * True once the sender's account has used the sequence number the signed payment needs (it
   * submitted other transactions in between): the payment can never land. expire() still takes
   * a last look at the chain, in case it was this very payment that used it.
   */
  /** When this process first saw a payment's sequence used up (per payment id). */
  const seqGoneSince = new Map<string, number>();

  async function sequenceLeftWindow(p: Payment): Promise<boolean> {
    if (!p.signedXdr) return false;
    const current = await gateway.accountSequence(p.senderAccount);
    if (current === null || current < signedSequence(p.signedXdr, deps.networkPassphrase)) {
      seqGoneSince.delete(p.id);
      return false;
    }
    // Horizon nodes can disagree for a moment (one sees the sequence used, another not yet the
    // transaction that used it), so the same grace as the maxTime expiry applies.
    const since = seqGoneSince.get(p.id) ?? now();
    seqGoneSince.set(p.id, since);
    if (now() - since < EXPIRY_GRACE_SEC * 1000) return false;
    seqGoneSince.delete(p.id);
    return true;
  }

  /**
   * Only deposits carrying the SEP-24 memo of this payment count, so a deposit meant for another
   * pending payment of the same sender can never settle this one. A re-sign also counts the
   * deposits of the payments it replaces: none of them landed, so that money is still in the
   * sender's account, and a re-sign must not make the user pay in twice.
   */
  async function cashInFor(p: Payment): Promise<Deposit | null> {
    let total: Deposit | null = null;
    let cur: Payment | null = p;
    for (let depth = 0; cur && depth < MAX_RESIGN_CHAIN; depth++) {
      const dep = await gateway.findDeposit({
        account: p.senderAccount,
        from: deps.anchorDistribution,
        asset: p.quote.maxSend.asset,
        since: cur.createdAt - 60_000,
        memo: await cashInMemo(cur.id),
      });
      if (dep) total = total ? { ...(total.at >= dep.at ? total : dep), amount: add(total.amount, dep.amount) } : dep;
      cur = cur.supersedesId ? await store.getPayment(cur.supersedesId) : null;
      // An ancestor that is not a terminal failure (CREDITED or still pending) spent or holds its own money.
      if (cur && cur.state !== 'EXPIRED' && cur.state !== 'CAP_EXCEEDED' && cur.state !== 'FAILED') break;
      // The ledger can be wrong about an EXPIRED ancestor; the chain is not. If its blob landed,
      // its deposit was spent and must not pay for this payment too.
      if (cur && cur.state === 'EXPIRED' && (await gateway.getTransaction(cur.innerTxHash)).status === 'SUCCESS') break;
    }
    return total;
  }

  async function settle(p: Payment, outcome: Outcome, hash: string, codes: string | undefined): Promise<Payment> {
    let cur = p;
    if (cur.state === 'SIGNED') {
      // The blob landed without a matched anchor deposit (e.g. the sender submitted it).
      const moved = await move(cur, 'CASH_IN', { legs: [{ kind: 'cash_in', status: 'FAILED' }] },
        { note: 'transaction landed before any matched cash-in' });
      if (!moved) return reload(cur.id);
      cur = moved;
    }
    if (cur.state === 'CASH_IN') {
      const moved = await move(cur, 'ONCHAIN',
        { legs: [{ kind: 'onchain', status: 'PENDING', amount: cur.quote.dest, txHash: hash }] }, { txHash: hash });
      if (!moved) return reload(cur.id);
      cur = moved;
    }
    if (outcome === 'success') {
      // The recipient holds the asset; CREDITED also needs the payout handler's acknowledgement.
      // If it fails, the payment stays ONCHAIN and the next reconcile pass asks again.
      const ack = await payout.acknowledge(cur);
      const done = await move(cur, 'CREDITED', {
        signedXdr: null,
        legs: [
          { kind: 'onchain', status: 'CONFIRMED', txHash: hash },
          { kind: 'cash_out', status: 'CONFIRMED', amount: cur.quote.dest, externalRef: ack.ref },
        ],
      }, { txHash: hash, payoutRef: ack.ref });
      return done ?? reload(cur.id);
    }
    const to: PaymentState = outcome === 'cap_exceeded' ? 'CAP_EXCEEDED' : 'FAILED';
    const done = await move(cur, to,
      { signedXdr: null, legs: [{ kind: 'onchain', status: 'FAILED', txHash: hash }] },
      { txHash: hash, codes: codes ?? null });
    return done ?? reload(cur.id);
  }

  async function expire(p: Payment, reason: string, extra: Record<string, unknown> = {}) {
    // Last look at the chain before calling it dead.
    const landed = await gateway.getTransaction(p.innerTxHash);
    if (landed.status !== 'NOT_FOUND') {
      return settle(p, landed.status === 'SUCCESS' ? 'success' : outcomeOf(landed.codes), landed.hash ?? p.innerTxHash, landed.codes);
    }
    return move(p, 'EXPIRED', { signedXdr: null, legs: [{ kind: 'cash_in', status: p.state === 'SIGNED' ? 'FAILED' : 'CONFIRMED' }] },
      { reason, ...extra });
  }

  async function reload(id: string) {
    const p = await store.getPayment(id);
    if (!p) throw E.paymentNotFound();
    return p;
  }

  let reconciling = false;

  /** Advances every pending payment idle for at least `idleMs`. Returns how many changed state. */
  async function reconcileAll(idleMs = 30_000): Promise<number> {
    if (reconciling) return 0; // a slow pass must not stack passes on top of itself
    reconciling = true;
    try {
      const pending = await store.listPending(idleMs, now());
      let changed = 0;
      for (const p of pending) {
        try {
          const after = await withTimeout(advance(p.id), 30_000);
          if (after.state !== p.state) changed++;
        } catch (e) {
          console.error(`reconcile ${p.id} failed:`, e);
        }
      }
      return changed;
    } finally {
      reconciling = false;
    }
  }

  return {
    quote,
    confirm,
    resign,
    linkCashIn,
    onCashIn,
    reconcile: advance,
    reconcileAll,
    getPayment: reload,
    findByIdemKey: (idemKey: string) => store.getPaymentByIdemKey(idemKey),
    events: (id: string) => store.events(id),
    isTerminal,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

export type Saga = ReturnType<typeof createSaga>;
export type { Corridor };
