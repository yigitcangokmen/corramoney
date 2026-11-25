/**
 * Cash out (D3): the recipient withdraws the TESTPHP a payment delivered at the anchor (SEP-24),
 * to a simulated cash pickup. The recipient's own anchor session starts the withdrawal and reads
 * what the anchor asks for; the recipient signs one payment to the anchor's distribution account
 * in Freighter; Corra validates it, pays its fee and submits it. Nothing is posted to Corra before
 * that signed payment exists, and the app never prompts on its own: only the Sign button does.
 */
import { moneyFromWire, parseUnits, TESTNET, type PaymentEvent, type PaymentWire } from '@corra/shared';
import { buildCashOutPayment } from '@corra/stellar';
import { track } from './analytics';
import { api, ApiError } from './api';
import {
  Aborted, assertFreighterReady, currentGeneration, ensureLogin, ensureSetup, errText, exclusive, freighterSign, guard, loadPaymentAccount,
  WalletError,
} from './remit';
import { safeLink } from './history';
import type { CashOutActive, CashOutMemo, Ctl } from './types';

/** A remembered cash-out older than this is not resumed on connect. */
const RESUME_MS = 10 * 60_000;
/** The anchor's interactive page token lives 600 s (Anchor Platform default); one minute of margin. */
export const CASH_OUT_PAGE_TTL_MS = 9 * 60_000;
const ANCHOR_WAIT_MS = 10 * 60_000;
const POLL_MS = 2000;
/** At most this many payments are read with their events (those with a cash-out underway first). */
const MAX_DETAILS = 10;

export type CashOutRowState = 'ready' | 'short' | 'anchor' | 'sign' | 'submitting' | 'onchain' | 'done' | 'failed' | 'unsupported';

export type CashOutRow = {
  id: string; publicId: string; amount: string; asset: string; state: CashOutRowState;
  txHash: string | null; moreInfoUrl: string | null; reason: string | null; receivedAt: number;
  /** 'onchain' only: the chain showed the payment to the anchor (else it is sent, not yet seen). */
  paid: boolean;
  /** 'failed' only: nothing to try again (the anchor holds the money). */
  terminal: boolean;
};

type Received = PaymentWire & { events?: PaymentEvent[] };

export const UNSUPPORTED = 'Withdrawal is enabled for TESTPHP only on testnet.';
export const DID_NOT_LAND = 'The withdrawal payment did not land. Nothing left your account.';
export const ANCHOR_STOPPED = 'The anchor stopped this withdrawal.';
export const PAID_STOPPED = 'Your payment reached the anchor, then the anchor stopped this withdrawal. There is no refund on testnet; contact the Corra team.';
export const STOPPED_START_NEW = 'The anchor stopped this withdrawal. Start a new cash-out.';
export const NOT_EXPECTED = 'The anchor asked for a payment Corra does not expect (account, amount or memo). Nothing was signed.';

const legOf = (p: Received) => p.legs.find((l) => l.kind === 'cash_out');
const isMock = (ref?: string) => !!ref && ref.startsWith('mock-payout:');
const lastCashOutEvent = (p: Received) => p.events?.filter((e) => e.type.startsWith('CASH_OUT_')).at(-1);

/**
 * The payment reached the anchor and the anchor stopped (or Corra saw a mismatch): final, nothing to retry.
 * A stop recorded while the chain did not answer says paid: false; the leg's own CASH_OUT_ONCHAIN still proves it paid.
 */
function paidAndStopped(p: Received): boolean {
  const last = lastCashOutEvent(p);
  if (last?.type === 'CASH_OUT_MISMATCH' || (last?.type === 'CASH_OUT_ANCHOR_FAILED' && (last.data as any)?.paid === true)) return true;
  const leg = legOf(p);
  return !!leg?.txHash && !!leg.externalRef && seenOnchain(p, leg.txHash) &&
    !!p.events?.some((e) => e.type === 'CASH_OUT_ANCHOR_FAILED' && (e.data as any)?.ref === leg.externalRef);
}

/** The chain showed the leg's recorded transaction (CASH_OUT_ONCHAIN after its CASH_OUT_SUBMITTED). */
function seenOnchain(p: Received, txHash: string): boolean {
  const ev = p.events ?? [];
  let at = ev.length - 1;
  while (at >= 0 && !(ev[at].type === 'CASH_OUT_SUBMITTED' && (ev[at].data as any)?.txHash === txHash)) at--;
  return at >= 0 && ev.slice(at + 1).some((e) => e.type === 'CASH_OUT_ONCHAIN');
}

/** One received payment as the Cash out tab shows it; null when it is not listed (a Phase 1 mock payout, no cash-out leg). Pure. */
export function cashOutRowOf(p: Received, phpSpendable: string, active: CashOutActive | null): CashOutRow | null {
  const leg = legOf(p);
  if (!leg || p.state !== 'CREDITED') return null;
  if (leg.status === 'CONFIRMED' && isMock(leg.externalRef)) return null;
  const done = p.events?.filter((e) => e.type === 'CASHED_OUT').at(-1)?.data as Record<string, any> | undefined;
  const row: CashOutRow = {
    id: p.id, publicId: p.publicId, amount: leg.amount.amount, asset: leg.amount.asset, state: 'ready',
    txHash: leg.txHash ?? null, moreInfoUrl: null, reason: null, receivedAt: p.createdAt, paid: false, terminal: false,
  };
  if (leg.amount.asset !== 'TESTPHP') return { ...row, state: 'unsupported', reason: UNSUPPORTED };
  if (leg.status === 'CONFIRMED') {
    return { ...row, state: 'done', txHash: done?.txHash ?? leg.txHash ?? null, moreInfoUrl: safeLink(done?.moreInfoUrl ?? null) };
  }
  if (paidAndStopped(p)) return { ...row, state: 'failed', reason: PAID_STOPPED, terminal: true };
  // A 200 from the submit (it carries the ledger) means the payment landed.
  const paid = !!leg.txHash && seenOnchain(p, leg.txHash);
  if (active?.paymentId === p.id) {
    return { ...row, state: active.step, txHash: active.txHash ?? row.txHash, paid: paid || active.ledger != null };
  }
  if (leg.txHash) return { ...row, state: 'onchain', paid };
  // The latest word on this leg: a dead blob, or the anchor stopping the withdrawal.
  const last = lastCashOutEvent(p);
  if (last?.type === 'CASH_OUT_FAILED') return { ...row, state: 'failed', reason: DID_NOT_LAND };
  if (last?.type === 'CASH_OUT_ANCHOR_FAILED') return { ...row, state: 'failed', reason: ANCHOR_STOPPED };
  if (parseUnits(phpSpendable) < moneyFromWire(leg.amount).raw) return { ...row, state: 'short' };
  return row;
}

/** Plain words for a failed cash-out step, by error code. */
export function cashOutErrorText(e: unknown): string {
  if (e instanceof WalletError) return errText(e);
  if (!(e instanceof ApiError)) return errText(e);
  if (e.status === 0 || e.status >= 500 || e.code === 'SEND_FAILED') {
    return 'Corra did not answer. Your signature is kept; press again to retry it, it will not be signed twice.';
  }
  switch (e.code) {
    case 'CASH_OUT_IN_PROGRESS': return 'Your earlier withdrawal payment may still land. Wait a few minutes, then try again.';
    case 'CASH_OUT_ALREADY_PAID': return 'The anchor was already paid for this payment; waiting for its confirmation.';
    case 'CASH_OUT_ANCHOR_STOPPED': return STOPPED_START_NEW;
    case 'INSUFFICIENT_BALANCE': return 'Your TESTPHP balance no longer covers this payment. Nothing was sent.';
    case 'CASH_OUT_FAILED': return `The payment to the anchor did not land (${(/\(([^)]+)\)/.exec(e.message) ?? [])[1] ?? e.code}). Nothing moved; press Sign the withdrawal again.`;
    case 'CASH_OUT_NOT_AVAILABLE': return UNSUPPORTED;
    case 'RATE_LIMITED': return 'Too many cash-out attempts from this network; wait a few minutes.';
  }
  if (e.code === 'UNBOUND_TRANSACTION' && e.message.includes('sequence')) {
    return 'Your payment account moved on; press again to sign a fresh one. Nothing was sent.';
  }
  return errText(e);
}

const cashOutKey = (pk: string) => 'corra_cashout_' + pk;
type Remembered = { paymentId: string; ref: string; url: string | null; at: number };

function remembered(pk: string): Remembered | null {
  try {
    const e = JSON.parse(localStorage.getItem(cashOutKey(pk)) || 'null');
    return e && typeof e.paymentId === 'string' && typeof e.ref === 'string' && typeof e.at === 'number' ? e : null;
  } catch {
    return null;
  }
}
function remember(pk: string, e: Remembered) {
  try { localStorage.setItem(cashOutKey(pk), JSON.stringify(e)); } catch {}
}
function forget(pk: string) {
  try { localStorage.removeItem(cashOutKey(pk)); } catch {}
}

/** Bumped by cancelCashOut and by each new wait: a stale poll loop stops at its next tick. */
let watchGen = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SEP-24 withdrawal statuses after the anchor saw the payment arrive. */
const PAID_STATUSES = new Set(['pending_user_transfer_complete', 'pending_external', 'pending_anchor', 'pending_stellar', 'pending_trust', 'pending_user', 'completed']);

/**
 * A signed withdrawal whose submit got no answer (status 0, 5xx, SEND_FAILED): it may still land,
 * so the next press sends the same blob again, never asks the wallet for a second one.
 */
let kept: { pk: string; paymentId: string; ref: string; signedXdr: string } | null = null;

/** The received CREDITED payments, with events for the TESTPHP ones whose cash-out has a reference. */
export async function refreshCashOuts(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  if (ctl.state.cashOutRead === 'idle') ctl.set({ cashOutRead: 'reading' });
  try {
    const { payments } = await api.accountPayments(pk, 'recipient', 50);
    const credited: Received[] = payments.filter((p) => p.state === 'CREDITED');
    // Unfinished legs first (their state depends on the events), newest first; CONFIRMED ones only fill what is left.
    const confirmed = (p: Received) => (legOf(p)?.status === 'CONFIRMED' ? 1 : 0);
    const detailed = credited.filter((p) => legOf(p)?.amount.asset === 'TESTPHP' && legOf(p)?.externalRef)
      .sort((x, y) => confirmed(x) - confirmed(y) || y.createdAt - x.createdAt).slice(0, MAX_DETAILS);
    const full = await Promise.all(detailed.map((p) => api.payment(p.id).catch(() => p)));
    const byId = new Map(full.map((p) => [p.id, p]));
    if (ctl.state.pubkey !== pk) return;
    const rows = credited.map((p) => byId.get(p.id) ?? p);
    ctl.set({ cashOutRows: rows, cashOutRead: 'ready' });
    const a = ctl.state.cashOutActive;
    const mine = a && rows.find((p) => p.id === a.paymentId);
    if (mine && isFinished(mine)) endActive(ctl, pk, mine.id);
  } catch {
    if (ctl.state.pubkey === pk) ctl.set({ cashOutRead: ctl.state.cashOutRows.length ? 'ready' : 'error' });
  }
}

/** The leg needs nothing more from the recipient: confirmed, or paid and stopped. */
const isFinished = (p: Received) => legOf(p)?.status === 'CONFIRMED' || paidAndStopped(p);

/** Drops the active cash-out of `paymentId` (and the remembered one): its row falls back to the server's state. */
function endActive(ctl: Ctl, pk: string, paymentId: string) {
  if (ctl.state.cashOutActive?.paymentId !== paymentId) return;
  forget(pk);
  ctl.set({ cashOutActive: null });
}

const patchRow = (ctl: Ctl, p: Received) =>
  ctl.set((s) => ({ cashOutRows: s.cashOutRows.some((r) => r.id === p.id) ? s.cashOutRows.map((r) => (r.id === p.id ? p : r)) : [p, ...s.cashOutRows] }));

/**
 * Starts the cash-out of one received payment: the TESTPHP line and the payment account if
 * missing, the anchor session, the SEP-24 withdrawal. The anchor's page opens from its own button.
 */
export const startCashOut = (ctl: Ctl, paymentId: string) => exclusive(async () => {
  const s = ctl.state;
  const pk = s.pubkey;
  const p = s.cashOutRows.find((r) => r.id === paymentId);
  if (!pk || !p || s.cashOutActive) return;
  const leg = legOf(p);
  if (!leg || leg.amount.asset !== 'TESTPHP' || leg.status === 'CONFIRMED' || leg.txHash) return;
  const amount = moneyFromWire(leg.amount);
  ctl.set({ cashOutError: null });
  if (parseUnits(s.phpSpendable) < amount.raw) {
    ctl.set({ cashOutError: `Your account holds ${s.phpSpendable} TESTPHP; this payment's ${leg.amount.amount} is no longer all there.` });
    return;
  }
  const gen = currentGeneration();
  try {
    await assertFreighterReady(pk);
    guard(gen);
    await ensureSetup(ctl, gen, 'cashOutBusy', ['PHP']);
    guard(gen);
    const token = await ensureLogin(ctl, gen, 'cashOutBusy');
    ctl.set({ cashOutBusy: 'Opening the withdrawal at the anchor...' });
    const { startWithdraw } = await import('./anchor');
    const w = await startWithdraw(token, pk, leg.amount.amount);
    guard(gen);
    const url = safeLink(w.url);
    if (!url) {
      ctl.set({ cashOutBusy: null, cashOutError: 'The anchor sent a page that is not a web link, so Corra did not open it. Nothing was signed; try again.' });
      return;
    }
    const at = Date.now();
    remember(pk, { paymentId, ref: w.id, url, at });
    ctl.set({ cashOutBusy: null, cashOutPopupBlocked: false, cashOutActive: { paymentId, ref: w.id, url, urlAt: at, step: 'anchor' } });
    waitForAnchor(ctl, token, paymentId, w.id).catch(() => {});
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ cashOutBusy: null, cashOutError: e instanceof ApiError && e.status === 429
      ? 'Too many account setups from this network in the last 10 minutes. Wait a few minutes, then try again.'
      : cashOutErrorText(e) });
  }
});

/** The Set up for cash-out button: the TESTPHP line (one prompt, only if missing) and the payment account (no prompt). */
export const setupCashOut = (ctl: Ctl) => exclusive(async () => {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const gen = currentGeneration();
  ctl.set({ cashOutError: null });
  try {
    await assertFreighterReady(pk);
    guard(gen);
    await ensureSetup(ctl, gen, 'cashOutBusy', ['PHP']);
    ctl.set({ cashOutBusy: null });
    await ctl.refreshBalances();
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ cashOutBusy: null, cashOutError: e instanceof ApiError && e.status === 429
      ? 'Too many account setups from this network in the last 10 minutes. Wait a few minutes, then try again.'
      : cashOutErrorText(e) });
  }
});

/** Opens the anchor's withdrawal page on a real click. A blocked popup falls back to a link. */
export function openCashOutPage(ctl: Ctl) {
  const a = ctl.state.cashOutActive;
  if (!a?.url || Date.now() - a.urlAt >= CASH_OUT_PAGE_TTL_MS) return;
  const w = window.open(a.url, 'corra-anchor-withdraw', 'width=480,height=720');
  ctl.set({ cashOutPopupBlocked: !w });
}

/** What the anchor asks for is what Corra expects: the disclosed distribution account, exactly the payment's amount, a memo. */
function asksExpected(t: { amountIn: string | null; anchorAccount: string | null; memo: CashOutMemo | null }, leg: { amount: PaymentWire['legs'][number]['amount'] }): boolean {
  let sameAmount = false;
  try { sameAmount = !!t.amountIn && parseUnits(t.amountIn) === moneyFromWire(leg.amount).raw; } catch {}
  return t.anchorAccount === TESTNET.anchorDistribution && sameAmount && !!t.memo;
}

/**
 * Polls the anchor every 2 s until the recipient confirmed on its page (pending_user_transfer_start),
 * the anchor stopped it, or 10 minutes passed. What the anchor asks for is checked before the
 * Sign button appears: the disclosed distribution account, exactly the payment's amount, a memo.
 */
export async function waitForAnchor(ctl: Ctl, token: string, paymentId: string, ref: string) {
  const mine = ++watchGen;
  const pk = ctl.state.pubkey;
  const p = ctl.state.cashOutRows.find((r) => r.id === paymentId);
  const leg = p && legOf(p);
  if (!pk || !leg) return;
  const { withdrawTransaction } = await import('./anchor');
  const live = () => mine === watchGen && ctl.state.pubkey === pk && ctl.state.cashOutActive?.ref === ref;
  for (const until = Date.now() + ANCHOR_WAIT_MS; Date.now() < until; await sleep(POLL_MS)) {
    if (!live()) return;
    let t;
    try {
      t = await withdrawTransaction(token, ref);
    } catch {
      continue;
    }
    if (!live()) return;
    if (t.status === 'error' || t.status === 'expired') {
      forget(pk);
      ctl.set({ cashOutActive: null, cashOutError: ANCHOR_STOPPED + (t.message ? ' ' + t.message : '') });
      return;
    }
    if (t.status !== 'pending_user_transfer_start') continue;
    if (!asksExpected(t, leg)) {
      forget(pk);
      ctl.set({ cashOutActive: null, cashOutError: NOT_EXPECTED });
      return;
    }
    ctl.set((s) => ({ cashOutActive: s.cashOutActive && { ...s.cashOutActive, step: 'sign', memo: t.memo! } }));
    return;
  }
  if (live()) ctl.set({ cashOutActive: null, cashOutError: 'The anchor\'s page was not confirmed within 10 minutes. Start the cash-out again.' });
}

/**
 * The Sign the withdrawal button: one Freighter prompt for the payment the anchor asked for,
 * sourced by the recipient's payment account so Corra pays the fee. An unanswered submit keeps
 * the signed blob; the next press replays it without a prompt.
 */
export const signCashOut = (ctl: Ctl) => exclusive(async () => {
  const s = ctl.state;
  const pk = s.pubkey;
  const a = s.cashOutActive;
  const p = a && s.cashOutRows.find((r) => r.id === a.paymentId);
  const leg = p && legOf(p);
  if (!pk || !a || a.step !== 'sign' || !a.memo || !leg) return;
  const gen = currentGeneration();
  ctl.set({ cashOutError: null });
  try {
    let signedXdr: string;
    const reuse = kept && kept.pk === pk && kept.paymentId === a.paymentId && kept.ref === a.ref ? kept.signedXdr : null;
    if (!reuse) {
      await assertFreighterReady(pk);
      guard(gen);
    }
    // The anchor may have stopped (expired, error) since the Sign button appeared, or while a kept
    // blob waited for a retry: read it again; prompt or resend only for a withdrawal still waiting.
    const token = await ensureLogin(ctl, gen, 'cashOutBusy');
    ctl.set({ cashOutBusy: 'Checking the withdrawal at the anchor...' });
    const { withdrawTransaction } = await import('./anchor');
    const t = await withdrawTransaction(token, a.ref);
    guard(gen);
    const waiting = t.status === 'pending_user_transfer_start';
    if (reuse) {
      if (!waiting) {
        kept = null;
        if (PAID_STATUSES.has(t.status)) {
          // The kept blob already reached the anchor: wait for its confirmation, never send again.
          ctl.set({ cashOutBusy: null, cashOutActive: { ...a, step: 'onchain' } });
          pollCashOut(ctl, a.paymentId).catch(() => {});
          return;
        }
        // Stopped before the kept blob landed: sending it now would pay the anchor for nothing (I-u4-22).
        forget(pk);
        ctl.set({ cashOutBusy: null, cashOutActive: null, cashOutError: ANCHOR_STOPPED + (t.message ? ' ' + t.message : '') });
        return;
      }
      signedXdr = reuse;
    } else {
      if (!waiting || !asksExpected(t, leg) || t.memo!.type !== a.memo.type || t.memo!.value !== a.memo.value) {
        forget(pk);
        ctl.set({ cashOutBusy: null, cashOutActive: null,
          cashOutError: waiting ? NOT_EXPECTED : ANCHOR_STOPPED + (t.message ? ' ' + t.message : '') });
        return;
      }
      const pa = await loadPaymentAccount(ctl, pk);
      guard(gen);
      const tx = buildCashOutPayment({
        networkPassphrase: TESTNET.networkPassphrase, recipient: pk, paymentAccount: pa.id, paymentSequence: pa.sequence,
        destination: TESTNET.anchorDistribution, amount: moneyFromWire(leg.amount), memo: a.memo, now: Math.floor(Date.now() / 1000),
      });
      ctl.set({ cashOutBusy: `Freighter: sign the payment of ${leg.amount.amount} TESTPHP to the anchor. Corra pays the fee.` });
      signedXdr = await freighterSign(tx.toXDR(), pk);
      track('sign');
      guard(gen);
      kept = { pk, paymentId: a.paymentId, ref: a.ref, signedXdr };
    }
    ctl.set({ cashOutBusy: 'Handing the signed withdrawal to Corra...', cashOutActive: { ...a, step: 'submitting' } });
    let r;
    try {
      r = await api.cashOutSubmit(a.paymentId, { ref: a.ref, signedXdr });
    } catch (e) {
      // A definite answer (4xx) ends this blob; no answer keeps it for the next press.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) kept = null;
      throw e;
    }
    kept = null;
    guard(gen);
    patchRow(ctl, r.payment);
    ctl.set({ cashOutBusy: null, cashOutActive: { ...a, step: 'onchain', txHash: r.txHash, ledger: r.ledger } });
    pollCashOut(ctl, a.paymentId).catch(() => {});
  } catch (e) {
    if (e instanceof Aborted) return;
    if (e instanceof ApiError && e.code === 'CASH_OUT_ALREADY_PAID') {
      // The anchor already has this payment's money: wait for its confirmation, never sign again.
      ctl.set({ cashOutBusy: null, cashOutError: null,
        cashOutActive: ctl.state.cashOutActive && { ...ctl.state.cashOutActive, step: 'onchain' } });
      pollCashOut(ctl, a.paymentId).catch(() => {});
      return;
    }
    if (e instanceof ApiError && e.code === 'CASH_OUT_ANCHOR_STOPPED') {
      forget(pk);
      ctl.set({ cashOutBusy: null, cashOutError: cashOutErrorText(e), cashOutActive: null });
      return;
    }
    ctl.set({ cashOutBusy: null, cashOutError: cashOutErrorText(e),
      cashOutActive: ctl.state.cashOutActive && { ...ctl.state.cashOutActive, step: 'sign' } });
  }
});

/** After the payment landed: every 3 s for 2 minutes, then every 10 s, until the anchor's confirmation (10 minutes at most). */
async function pollCashOut(ctl: Ctl, paymentId: string) {
  const mine = ++watchGen;
  const pk = ctl.state.pubkey;
  const start = Date.now();
  while (mine === watchGen && ctl.state.pubkey === pk && Date.now() - start < 10 * 60_000) {
    await sleep(Date.now() - start < 2 * 60_000 ? 3000 : 10_000);
    if (mine !== watchGen || ctl.state.pubkey !== pk) return;
    let p;
    try {
      p = await api.payment(paymentId);
    } catch {
      continue;
    }
    if (mine !== watchGen || ctl.state.pubkey !== pk) return;
    patchRow(ctl, p);
    if (isFinished(p)) {
      if (pk) endActive(ctl, pk, paymentId);
      if (legOf(p)?.status === 'CONFIRMED') ctl.refreshBalances().catch(() => {});
      return;
    }
    // The reconciler cleared the blob (it never landed): the row says so and offers Try again.
    if (!legOf(p)?.txHash && lastCashOutEvent(p)?.type === 'CASH_OUT_FAILED') {
      if (pk) endActive(ctl, pk, paymentId);
      return;
    }
  }
  // Timed out: the row falls back to the server's state, and the other rows can start again.
  if (mine === watchGen && pk && ctl.state.pubkey === pk) endActive(ctl, pk, paymentId);
}

/** On connect: a cash-out started in the last 10 minutes goes back to waiting for the anchor, or to its on-chain payment. */
export async function resumeCashOut(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const e = remembered(pk);
  if (!e || Date.now() - e.at > RESUME_MS) return;
  let p;
  try {
    p = await api.payment(e.paymentId);
  } catch {
    return;
  }
  const leg = legOf(p);
  if (ctl.state.pubkey !== pk || ctl.state.cashOutActive || !leg || p.recipientAccount !== pk) return;
  if (isFinished(p)) {
    forget(pk);
    patchRow(ctl, p);
    return;
  }
  patchRow(ctl, p);
  if (leg.txHash) {
    ctl.set({ cashOutActive: { paymentId: e.paymentId, ref: e.ref, url: null, urlAt: e.at, step: 'onchain', txHash: leg.txHash } });
    pollCashOut(ctl, e.paymentId).catch(() => {});
    return;
  }
  const s = ctl.state;
  if (!s.anchorToken || s.anchorTokenExp < Date.now() + 60_000) return;
  ctl.set({ cashOutActive: { paymentId: e.paymentId, ref: e.ref, url: Date.now() - e.at < CASH_OUT_PAGE_TTL_MS ? safeLink(e.url) : null,
    urlAt: e.at, step: 'anchor' } });
  waitForAnchor(ctl, s.anchorToken, e.paymentId, e.ref).catch(() => {});
}

/** Back to the list after a failure or to cash out another payment. */
export function resetCashOut(ctl: Ctl) {
  watchGen++;
  const pk = ctl.state.pubkey;
  if (pk && ctl.state.cashOutActive?.step !== 'onchain') forget(pk);
  ctl.set({ cashOutActive: null, cashOutBusy: null, cashOutError: null, cashOutPopupBlocked: false });
}

/** Called on disconnect. */
export function cancelCashOut() {
  watchGen++;
  kept = null;
}
