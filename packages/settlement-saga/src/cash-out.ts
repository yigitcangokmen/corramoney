import { sameAsset, type AssetId, type Leg, type Payment, type PaymentEvent, type Sep24Callback } from '@corra/shared';
import {
  assertCashOutPayment,
  cashOutFactsOf,
  sameMemo,
  SponsorRefusal,
  UnboundTransactionError,
  type BoundCashOut,
  type CashOutMemo,
  type StellarGateway,
} from '@corra/stellar';
import * as E from './errors';
import { EXPIRY_GRACE_SEC, withTimeout } from './saga';
import type { CashOutUnless, NewEvent, SagaStore } from './store';

/**
 * The recipient's cash-out (D3): a SEP-24 withdrawal of the TESTPHP a CREDITED payment delivered.
 * The recipient signs one payment to the anchor's distribution account; Corra validates it,
 * records it on the payment's cash_out leg, fee-bumps and submits it. The leg is CONFIRMED only
 * when the anchor's signed `completed` callback and the chain agree on that very payment. Every
 * write appends an event with from = to = 'CREDITED': the payment's state never changes.
 */
export type CashOutsDeps = {
  store: SagaStore;
  gateway: StellarGateway;
  networkPassphrase: string;
  anchorId: string;
  /** The anchor's disclosed distribution account, the only destination a withdrawal payment may have. */
  anchorDistribution: string;
  /** TESTPHP with the corridor issuer: the only asset with a withdrawal on testnet. */
  asset: AssetId;
  now?: () => number;
  /** Structured events (cashout.submitted, cashout.confirmed, ...). Default: none. */
  log?: (line: { evt: string } & Record<string, unknown>) => void;
};

export type CashOutSubmit = {
  paymentId: string;
  /** The anchor's SEP-24 withdrawal id. */
  ref: string;
  signedXdr: string;
  /** The caller's per-IP rate limit, taken only for a new blob proven to be the recipient's; false refuses 429. */
  admit?: () => boolean;
};

export type CashOutResult = { payment: Payment; events: PaymentEvent[]; txHash: string | null; ledger: number | null; replay: boolean };

/** Landed failed transactions (the sponsor paid their fees) after which a leg takes no more blobs. */
const MAX_FAILED_ATTEMPTS = 3;

const firstOpCode = (codes: unknown): string => {
  const c = codes as { operations?: string[]; inner_transaction?: string; transaction?: string } | undefined;
  return c?.operations?.find((x) => x !== 'op_success') ?? c?.inner_transaction ?? c?.transaction ?? 'unknown';
};

const hasResultCode = (codes: unknown): boolean => {
  const c = codes as { operations?: string[]; inner_transaction?: string; transaction?: string } | undefined;
  return !!(c?.transaction || c?.inner_transaction || c?.operations?.length);
};

const cashOutLeg = (p: Payment): Leg | undefined => p.legs.find((l) => l.kind === 'cash_out');

export function createCashOuts(deps: CashOutsDeps) {
  const now = deps.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const log = deps.log ?? (() => {});
  const { store, gateway } = deps;

  const event = (type: string, data: Record<string, unknown>): NewEvent => ({ type, from: 'CREDITED', to: 'CREDITED', data });

  /** The last event of `type` whose data matches `where`. */
  async function lastEvent(id: string, type: string, where: (d: Record<string, unknown>) => boolean) {
    return (await store.events(id)).filter((e) => e.type === type && where(e.data ?? {})).at(-1) ?? null;
  }

  async function reload(id: string) {
    const p = await store.getPayment(id);
    if (!p) throw E.paymentNotFound();
    return p;
  }

  /** Clears the leg's dead blob; the ref stays. False when another writer got there first. */
  async function clear(p: Payment, txHash: string, reason: 'failed' | 'rejected' | 'expired', codes?: string) {
    const ref = cashOutLeg(p)?.externalRef;
    const done = await store.recordCashOut(p.id, txHash, { txHash: null },
      event('CASH_OUT_FAILED', { ref, txHash, reason, ...(codes ? { codes } : {}) }));
    if (done) log({ evt: 'cashout.failed', id: p.id, ref, txHash, reason, codes });
    return !!done;
  }

  /** Appends CASH_OUT_ONCHAIN once per leg transaction (keyed by its landed envelope hash). */
  async function recordOnchain(p: Payment, innerHash: string, envelopeHash: string, ledger: number | undefined) {
    const ref = cashOutLeg(p)?.externalRef;
    const done = await store.recordCashOut(p.id, innerHash, {}, event('CASH_OUT_ONCHAIN', { ref, txHash: envelopeHash, ledger: ledger ?? null }),
      { type: 'CASH_OUT_ONCHAIN', match: { txHash: envelopeHash } });
    if (done) log({ evt: 'cashout.onchain', id: p.id, ref, txHash: envelopeHash, ledger });
    return !!done;
  }

  // One submit at a time per payment inside this process; the store's CAS on tx_hash protects across processes.
  const inflight = new Map<string, Promise<CashOutResult>>();

  function submit(input: CashOutSubmit): Promise<CashOutResult> {
    const prev = inflight.get(input.paymentId);
    const run = (prev ? prev.catch(() => {}) : Promise.resolve()).then(() => submitOnce(input));
    inflight.set(input.paymentId, run);
    const done = () => { if (inflight.get(input.paymentId) === run) inflight.delete(input.paymentId); };
    run.then(done, done);
    return run;
  }

  /** Every refusal happens before any write. */
  async function submitOnce(input: CashOutSubmit): Promise<CashOutResult> {
    const p = await store.getPayment(input.paymentId);
    if (!p) throw E.paymentNotFound();
    if (p.state !== 'CREDITED') throw E.cashOutNotReady();
    const leg = cashOutLeg(p);
    // A Phase 1 leg (CONFIRMED 'mock-payout:...') counts as cashed out: it is never a candidate.
    if (!leg || leg.status === 'CONFIRMED') throw E.alreadyCashedOut();
    if (!sameAsset(leg.amount.asset, deps.asset)) throw E.cashOutNotAvailable(leg.amount.asset.code);

    let bound: BoundCashOut;
    try {
      bound = assertCashOutPayment(input.signedXdr,
        { recipient: p.recipientAccount, destination: deps.anchorDistribution, amount: leg.amount }, deps.networkPassphrase, nowSec(),
        // The leg's own recorded blob is a replay even past its maxTime: the chain, not the clock, decides it.
        leg.txHash ?? undefined);
    } catch (e) {
      if (e instanceof UnboundTransactionError) throw E.unbound(e.message);
      throw e;
    }

    // The same blob again: a client retry after a lost answer. No new record, no rate-limit token.
    if (leg.txHash === bound.hash) {
      if (leg.externalRef !== input.ref) throw E.cashOutRefMismatch();
      const t = await gateway.getTransaction(bound.hash);
      if (t.status === 'SUCCESS') {
        return { payment: p, events: await store.events(p.id), txHash: t.hash ?? null, ledger: t.ledger ?? null, replay: true };
      }
      if (t.status === 'FAILED') {
        await clear(p, bound.hash, 'failed', t.codes);
        throw E.cashOutFailed(t.codes ?? 'unknown');
      }
      // Not on chain, and the anchor already stopped this withdrawal: a resend would pay it for nothing
      // (no refund on testnet). The record stays; the reconciler clears it after maxTime (I-u4-22).
      if ((await store.events(p.id)).some((e) => e.type === 'CASH_OUT_ANCHOR_FAILED' && e.data?.ref === leg.externalRef)) {
        throw E.cashOutAnchorStopped();
      }
      return send(p, input.ref, bound, input.signedXdr, true);
    }
    // Another blob is recorded: while it landed or may still land, the recipient must not pay twice.
    if (leg.txHash) {
      const t = await gateway.getTransaction(leg.txHash);
      throw t.status === 'SUCCESS' ? E.cashOutAlreadyPaid() : E.cashOutInProgress();
    }
    const history = await store.events(p.id);
    // The anchor already stopped this withdrawal: a payment for it now would reach the anchor for nothing.
    if (history.some((e) => e.type === 'CASH_OUT_ANCHOR_FAILED' && e.data?.ref === input.ref)) throw E.cashOutAnchorStopped();
    // The anchor already completed this withdrawal: a second payment for it would be lost.
    if (history.some((e) => e.type === 'CASH_OUT_ANCHOR_COMPLETED' && e.data?.ref === input.ref)) {
      log({ evt: 'cashout.mismatch', id: p.id, ref: input.ref, reason: 'a new payment for a withdrawal the anchor already completed' });
      throw E.cashOutAlreadyPaid();
    }
    const failed = history.filter((e) => e.type === 'CASH_OUT_FAILED' && e.data?.reason === 'failed');
    if (failed.length >= MAX_FAILED_ATTEMPTS) throw E.cashOutAttempts();
    const source = bound.sequenceAccount;
    if (source === p.recipientAccount || !(await gateway.isPaymentAccountOf(source, p.recipientAccount))) {
      throw E.unbound("source is not the recipient's payment account: set up the account first if you have none");
    }
    if (input.admit && !input.admit()) throw E.rateLimited();
    const bal = await gateway.accountBalance(p.recipientAccount, deps.asset);
    if (!bal || bal.raw < leg.amount.raw) throw E.insufficientBalance(bal, leg.amount);
    const cur = await gateway.accountSequence(source);
    if (cur === null || bound.sequence !== cur + 1n) throw E.unbound("sequence is not the payment account's next");

    // Recorded before the network call: a lost answer or a crash leaves a known hash, never an unknown payment.
    // The stop check above ran outside the lock; `unless` repeats it under the lock, so a stop callback
    // recorded during the Horizon reads above still refuses the submit (I-u4-23).
    const recorded = await store.recordCashOut(p.id, null, { externalRef: input.ref, txHash: bound.hash },
      event('CASH_OUT_SUBMITTED', { ref: input.ref, txHash: bound.hash, maxTime: bound.maxTime }),
      { type: 'CASH_OUT_ANCHOR_FAILED', match: { ref: input.ref } });
    if (!recorded) {
      if ((await store.events(p.id)).some((e) => e.type === 'CASH_OUT_ANCHOR_FAILED' && e.data?.ref === input.ref)) throw E.cashOutAnchorStopped();
      throw E.cashOutInProgress();
    }
    log({ evt: 'cashout.submitted', id: p.id, ref: input.ref, txHash: bound.hash });
    return send(recorded, input.ref, bound, input.signedXdr, false);
  }

  async function send(p: Payment, ref: string, bound: BoundCashOut, signedXdr: string, replay: boolean): Promise<CashOutResult> {
    let out;
    try {
      out = await gateway.submitPayment(signedXdr);
    } catch (e) {
      if (e instanceof SponsorRefusal) {
        await clear(p, bound.hash, 'rejected', e.message);
        throw e;
      }
      // No answer: the blob may still land. The record stays; the reconciler or a replay finds out.
      log({ evt: 'cashout.send_error', id: p.id, ref, txHash: bound.hash, error: String(e) });
      throw E.sendFailed();
    }
    if (out.kind === 'success') {
      await recordOnchain(p, bound.hash, out.hash, out.ledger);
      // An early completed callback may already be recorded.
      const after = await tryConfirm(await reload(p.id));
      return { payment: after, events: await store.events(p.id), txHash: out.hash, ledger: out.ledger, replay };
    }
    const codes = firstOpCode(out.codes);
    // tx_too_late on a first send: the network's clock passed maxTime, so the blob can never enter a
    // ledger. On a replay it may already have landed (core checks time bounds before the sequence): ask the chain.
    if (out.kind === 'expired' && !replay) {
      await clear(p, bound.hash, 'rejected', codes);
      throw E.cashOutFailed(codes);
    }
    // bad_seq, failed, cap_exceeded: the error body alone does not prove the blob never landed (a
    // replay after a lost answer meets its own landed sequence; a 504 carries no codes). Ask the chain.
    const t = await gateway.getTransaction(bound.hash);
    if (t.status === 'SUCCESS') {
      await recordOnchain(p, bound.hash, t.hash ?? bound.hash, t.ledger);
      const after = await tryConfirm(await reload(p.id));
      return { payment: after, events: await store.events(p.id), txHash: t.hash ?? null, ledger: t.ledger ?? null, replay };
    }
    // Landed failed (op_no_trust, op_underfunded, ...): the sponsor paid the fee, it counts as an attempt.
    if (t.status === 'FAILED') {
      await clear(p, bound.hash, 'failed', t.codes ?? codes);
      throw E.cashOutFailed(t.codes ?? codes);
    }
    // Not on chain: a first send that core refused with a result code (tx_insufficient_fee, ...)
    // never entered the queue. Anything else may still land; the reconciler clears it after maxTime.
    if (!replay && out.kind !== 'bad_seq' && hasResultCode(out.codes)) {
      await clear(p, bound.hash, 'rejected', codes);
      throw E.cashOutFailed(codes);
    }
    log({ evt: 'cashout.send_unsettled', id: p.id, ref, txHash: bound.hash, kind: out.kind, codes, replay });
    throw E.sendFailed('the network has not shown this withdrawal payment yet; Corra keeps checking it');
  }

  /**
   * Appends an event at the leg's current tx_hash, reloading and retrying once when another writer
   * moved it. Null when the leg is gone or confirmed, or when the `unless` event already exists.
   */
  async function appendAtLeg(p: Payment, e: NewEvent, unless: CashOutUnless): Promise<Payment | null> {
    let cur = p;
    for (let attempt = 0; attempt < 2; attempt++) {
      const leg = cashOutLeg(cur);
      if (!leg || leg.status === 'CONFIRMED') return null;
      const done = await store.recordCashOut(cur.id, leg.txHash ?? null, {}, e, unless);
      if (done) return done;
      cur = await reload(cur.id);
    }
    return null;
  }

  /**
   * SEP-24 withdrawal callback (signature already verified by the API). A `completed` or a stop is
   * the only source of CASH_OUT_ANCHOR_COMPLETED / CASH_OUT_ANCHOR_FAILED, so the API awaits it and
   * answers 5xx on a throw for the anchor to resend; it is never the only authority for CONFIRMED.
   */
  async function onCallback(ev: Sep24Callback): Promise<Payment | null> {
    const p = await store.findPaymentByCashOutRef(deps.anchorId, ev.ref);
    if (!p) {
      log({ evt: 'cashout.unknown_ref', ref: ev.ref, status: ev.anchorStatus });
      return null;
    }
    const leg = cashOutLeg(p);
    if (!leg || leg.status === 'CONFIRMED') return p;

    if (ev.status === 'FAILED') {
      const anchorStatus = ev.anchorStatus ?? null;
      // Fast path only (it saves the chain lookup); the store's `unless` keeps it once under concurrent callbacks.
      if (await lastEvent(p.id, 'CASH_OUT_ANCHOR_FAILED', (d) => d.ref === ev.ref && d.anchorStatus === anchorStatus)) return p;
      // Money already with the anchor stays frozen on the leg (no refund on testnet, risks.md); a dead blob is cleared by the reconciler.
      // A failed chain lookup must not lose the anchor's word: recorded as not paid (the web reads a later CASH_OUT_ONCHAIN).
      let paid = false;
      if (leg.txHash) {
        try {
          paid = (await gateway.getTransaction(leg.txHash)).status === 'SUCCESS';
        } catch (e) {
          log({ evt: 'cashout.check_failed', id: p.id, ref: ev.ref, error: String(e) });
        }
      }
      const done = await appendAtLeg(p, event('CASH_OUT_ANCHOR_FAILED', { ref: ev.ref, anchorStatus, paid }),
        { type: 'CASH_OUT_ANCHOR_FAILED', match: { ref: ev.ref, anchorStatus } });
      if (done) log({ evt: 'cashout.anchor_failed', id: p.id, ref: ev.ref, anchorStatus: ev.anchorStatus, paid });
      return done ?? reload(p.id);
    }
    // Intermediate states: the app reads them from the anchor with the recipient's own session.
    if (ev.status === 'PENDING') return p;

    // CONFIRMED: only with the anchor's memo, so the confirmation binds ref -> memo -> chain payment.
    if (!ev.withdrawMemo) {
      log({ evt: 'cashout.mismatch', id: p.id, ref: ev.ref, reason: 'completed callback without withdraw_memo' });
      return p;
    }
    const cur = (await appendAtLeg(p, event('CASH_OUT_ANCHOR_COMPLETED', {
      ref: ev.ref,
      withdrawMemo: ev.withdrawMemo,
      ...(ev.stellarTxId ? { stellarTxId: ev.stellarTxId } : {}),
      ...(ev.externalId ? { externalId: ev.externalId } : {}),
      ...(ev.moreInfoUrl ? { moreInfoUrl: ev.moreInfoUrl } : {}),
    }), { type: 'CASH_OUT_ANCHOR_COMPLETED', match: { ref: ev.ref } })) ?? (await reload(p.id));
    return tryConfirm(cur);
  }

  /**
   * CONFIRMED needs both witnesses: the anchor's signed `completed` for the leg's ref, and the chain
   * showing Corra's own recorded payment with the recipient, destination, asset, amount and the
   * anchor's memo. Without a recorded leg transaction nothing confirms. Returns the payment after.
   */
  async function tryConfirm(p: Payment): Promise<Payment> {
    const leg = cashOutLeg(p);
    if (!leg || leg.status !== 'PENDING' || !leg.txHash || !leg.externalRef) return p;
    const completed = await lastEvent(p.id, 'CASH_OUT_ANCHOR_COMPLETED', (d) => d.ref === leg.externalRef);
    if (!completed) return p;
    const t = await gateway.getTransaction(leg.txHash);
    // Not visible yet (Horizon lag), or landed failed (the reconciler clears it): nothing to compare.
    if (t.status !== 'SUCCESS') return p;
    const c = completed.data as { withdrawMemo: CashOutMemo; stellarTxId?: string; externalId?: string; moreInfoUrl?: string };
    const f = t.envelopeXdr ? cashOutFactsOf(t.envelopeXdr, deps.networkPassphrase) : null;
    const reason = !f ? 'the landed transaction is not one payment'
      : f.from !== p.recipientAccount ? 'paid from another account'
      : f.destination !== deps.anchorDistribution ? "not paid to the anchor's distribution account"
      : !sameAsset(f.asset, deps.asset) ? 'another asset'
      : f.amountRaw !== leg.amount.raw ? 'another amount'
      : !f.memo || !sameMemo(f.memo, c.withdrawMemo) ? "the memo is not the one the anchor's callback names"
      : c.stellarTxId && c.stellarTxId !== t.hash && c.stellarTxId !== leg.txHash ? 'the anchor names another transaction'
      : null;
    if (reason) {
      await store.recordCashOut(p.id, leg.txHash, {}, event('CASH_OUT_MISMATCH', { ref: leg.externalRef, reason }),
        { type: 'CASH_OUT_MISMATCH', match: { ref: leg.externalRef } });
      log({ evt: 'cashout.mismatch', id: p.id, ref: leg.externalRef, txHash: leg.txHash, reason });
      return reload(p.id);
    }
    const done = await store.recordCashOut(p.id, leg.txHash, { status: 'CONFIRMED' }, event('CASHED_OUT', {
      ref: leg.externalRef, txHash: t.hash ?? null, ledger: t.ledger ?? null, payout: c.externalId ?? null, moreInfoUrl: c.moreInfoUrl ?? null,
    }));
    if (done) log({ evt: 'cashout.confirmed', id: p.id, ref: leg.externalRef, txHash: t.hash, payout: c.externalId });
    return done ?? reload(p.id);
  }

  /** One leg with a recorded blob: finish the join, record what landed, or clear what never will. True when something was written. */
  async function check(p: Payment): Promise<boolean> {
    const leg = cashOutLeg(p);
    if (!leg?.txHash) return false;
    const t = await gateway.getTransaction(leg.txHash);
    if (t.status === 'SUCCESS') {
      if (await lastEvent(p.id, 'CASH_OUT_ANCHOR_COMPLETED', (d) => d.ref === leg.externalRef)) {
        const before = (await store.events(p.id)).length;
        await tryConfirm(p);
        if ((await store.events(p.id)).length > before) return true;
      } else if (await recordOnchain(p, leg.txHash, t.hash ?? leg.txHash, t.ledger)) {
        return true;
      }
      await store.touchCashOut(p.id);
      return false;
    }
    if (t.status === 'FAILED') return clear(p, leg.txHash, 'failed', t.codes);
    const submitted = await lastEvent(p.id, 'CASH_OUT_SUBMITTED', (d) => d.txHash === leg.txHash);
    const maxTime = Number(submitted?.data?.maxTime ?? 0);
    // A transaction cannot enter a ledger after its maxTime; the grace covers a lagging Horizon.
    if (maxTime && nowSec() >= maxTime + EXPIRY_GRACE_SEC) return clear(p, leg.txHash, 'expired');
    await store.touchCashOut(p.id);
    return false;
  }

  let reconciling = false;

  /** Checks cash-out legs with a recorded blob, idle for at least `idleMs`. Returns how many changed. */
  async function reconcile(idleMs = 30_000, limit = 25): Promise<number> {
    if (reconciling) return 0;
    reconciling = true;
    try {
      const open = await store.listOpenCashOuts(idleMs, now(), limit);
      let changed = 0;
      for (const p of open) {
        try {
          if (await withTimeout(check(p), 30_000)) changed++;
        } catch (e) {
          log({ evt: 'cashout.check_failed', id: p.id, error: String(e) });
        }
      }
      return changed;
    } finally {
      reconciling = false;
    }
  }

  return { submit, onCallback, reconcile };
}

export type CashOuts = ReturnType<typeof createCashOuts>;
