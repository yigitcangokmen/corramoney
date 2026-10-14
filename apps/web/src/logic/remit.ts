import * as StellarSdk from '@stellar/stellar-sdk';
import { getAddress, getNetworkDetails, signTransaction } from '@stellar/freighter-api';
import { cashInMemo, FIAT, moneyFromWire, roundUp, TESTNET, toDecimal, type FiatCode, type PaymentEvent, type PaymentWire, type QuoteWire } from '@corra/shared';
import { buildStrictReceive } from '@corra/stellar';
import { api, ApiError, TERMINAL } from './api';
import { CORR } from './data';
import type { Ctl } from './types';

const horizon = new StellarSdk.Horizon.Server(TESTNET.horizonUrl);
const NP = TESTNET.networkPassphrase;

export type RemitStep = 'form' | 'review' | 'cashin' | 'track';
export type TrackedPayment = PaymentWire & { events: PaymentEvent[] };

let stopWatch: (() => void) | null = null;

/** Bumped on disconnect: a flow that started under an older generation stops at its next await. */
let generation = 0;
class Aborted extends Error {}
const guard = (gen: number) => {
  if (gen !== generation) throw new Aborted('aborted');
};

export const errText = (e: unknown) =>
  e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

export const ACCOUNT_SWITCHED =
  'Freighter is now on a different account than the one you connected. Disconnect and connect again.';

/** freighter-api 6 returns errors as { code, message }; older builds returned a string. */
export function freighterMessage(err: unknown): string {
  if (typeof err === 'string' && err) return err;
  const m = (err as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m ? m : 'Freighter returned an error';
}

export async function freighterSign(xdr: string, address?: string): Promise<string> {
  const r = await signTransaction(xdr, { networkPassphrase: NP, ...(address ? { address } : {}) });
  if (r.error) throw new Error(freighterMessage(r.error));
  if (address && r.signerAddress && r.signerAddress !== address) throw new Error(ACCOUNT_SWITCHED);
  return r.signedTxXdr;
}

/** Refuses to continue on the wrong network or when Freighter switched accounts since connect. */
export async function assertFreighterReady(expected?: string) {
  const net = await getNetworkDetails();
  if (net.error) throw new Error(freighterMessage(net.error));
  if (net.networkPassphrase !== NP) {
    throw new Error(`Switch Freighter to Testnet. It is on ${net.network || 'another network'} now.`);
  }
  if (!expected) return;
  const a = await getAddress();
  if (a.error) throw new Error(freighterMessage(a.error));
  if (a.address && a.address !== expected) throw new Error(ACCOUNT_SWITCHED);
}

const destFiat = (iso: string): FiatCode => {
  const c = CORR.find((x) => x.iso === iso) ?? CORR[0];
  return c.cur as FiatCode;
};

const historyKey = (pk: string) => 'corra_payments_' + pk;
const cashInKey = (pk: string) => 'corra_cashin_' + pk;

export function rememberPayment(pk: string, id: string) {
  try {
    const ids: string[] = JSON.parse(localStorage.getItem(historyKey(pk)) || '[]');
    if (!ids.includes(id)) localStorage.setItem(historyKey(pk), JSON.stringify([id, ...ids].slice(0, 30)));
  } catch {}
}

export function rememberedPayments(pk: string): string[] {
  try {
    const ids = JSON.parse(localStorage.getItem(historyKey(pk)) || '[]');
    return Array.isArray(ids) ? ids.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The anchor's deposit page per payment, so a reload or History can reopen it. */
export function rememberCashIn(pk: string, id: string, url: string) {
  try {
    const m = JSON.parse(localStorage.getItem(cashInKey(pk)) || '{}');
    m[id] = url;
    const keep = rememberedPayments(pk);
    for (const k of Object.keys(m)) if (k !== id && !keep.includes(k)) delete m[k];
    localStorage.setItem(cashInKey(pk), JSON.stringify(m));
  } catch {}
}

export function rememberedCashIn(pk: string, id: string): string | null {
  try {
    const url = JSON.parse(localStorage.getItem(cashInKey(pk)) || '{}')[id];
    return typeof url === 'string' ? url : null;
  } catch {
    return null;
  }
}

/** True when the sender's account exists and trusts TESTMXN, so setup can be skipped. */
async function senderReady(pk: string): Promise<boolean> {
  try {
    const a = await horizon.loadAccount(pk);
    return a.balances.some((b: any) => b.asset_code === FIAT.MXN.code && b.asset_issuer === TESTNET.corridorIssuer);
  } catch {
    return false;
  }
}

/**
 * False only when Horizon says the recipient cannot receive `code`: no account, or no trustline.
 * Checked before any wallet prompt; if Horizon is unreachable, /confirm still checks it.
 */
async function recipientReady(addr: string, code: string): Promise<boolean> {
  try {
    const a = await horizon.loadAccount(addr);
    return a.balances.some((b: any) => b.asset_code === code && b.asset_issuer === TESTNET.corridorIssuer);
  } catch (e: any) {
    return e?.response?.status === 404 ? false : true;
  }
}

/** An idempotency key. crypto.randomUUID needs a secure context; getRandomValues does not. */
const newKey = () => (typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

/** Matches max_amount in infra/anchor/config/assets.yaml.tmpl: the anchor refuses larger deposits. */
export const ANCHOR_MAX_DEPOSIT = 1_000_000;

/** A recipient amount: at least 0.01, at most 2 decimals, no rounding. */
export const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
export const validAmount = (s: string) => AMOUNT_RE.test(s) && Number(s) >= 0.01;

export async function getQuote(ctl: Ctl) {
  const s = ctl.state;
  if (!s.pubkey || !validAmount(s.destDigits)) return;
  const gen = generation;
  const iso = s.pick;
  const fiat = destFiat(iso);
  ctl.set({ remitBusy: 'Finding a route through the USDC hub…', remitError: null });
  try {
    const [quote, ready, recipientOk] = await Promise.all([
      api.quote(
        { from: 'MX/MXN', to: `${iso}/${fiat}` },
        { amount: s.destDigits, asset: FIAT[fiat].code, issuer: TESTNET.corridorIssuer },
      ),
      senderReady(s.pubkey),
      recipientReady(s.addr, FIAT[fiat].code),
    ]);
    guard(gen);
    if (Number(depositAmount(quote.maxSend)) > ANCHOR_MAX_DEPOSIT) {
      ctl.set({ remitBusy: null, remitError: `This payment needs a deposit of ${depositAmount(quote.maxSend)} MXN; the anchor accepts at most ${ANCHOR_MAX_DEPOSIT.toLocaleString('en-US')} MXN. Lower the amount.` });
      return;
    }
    if (!recipientOk) {
      ctl.set({ remitBusy: null, remitError: `The recipient's account cannot receive ${FIAT[fiat].code} yet: it does not exist or has no ${FIAT[fiat].code} trustline. Nothing was signed.` });
      return;
    }
    ctl.set({ quote, setupDone: ready });
    await refreshAnchorQuote(ctl, quote.maxSend, gen);
    ctl.set({ remitStep: 'review', remitBusy: null });
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ remitBusy: null, remitError: errText(e) });
  }
}

/**
 * The anchor's SEP-38 firm quote for depositing exactly the cap (in whole centavos). Needs the
 * anchor session from connect. If the anchor cannot quote, the payment still works without one.
 */
async function refreshAnchorQuote(ctl: Ctl, maxSend: QuoteWire['maxSend'], gen: number) {
  const s = ctl.state;
  if (!s.anchorToken || s.anchorTokenExp < Date.now() + 60_000) {
    ctl.set({ anchorQuote: null });
    return;
  }
  ctl.set({ remitBusy: 'Asking the anchor for a firm SEP-38 quote…' });
  try {
    const { firmQuote } = await import('./anchor');
    const aq = await firmQuote(s.anchorToken, depositAmount(maxSend));
    guard(gen);
    ctl.set({ anchorQuote: aq });
  } catch (e) {
    if (e instanceof Aborted) throw e;
    ctl.set({ anchorQuote: null });
  }
}

/** SPEI moves whole centavos, so the deposit is the signed cap rounded up to 2 decimals. */
export const depositAmount = (maxSend: QuoteWire['maxSend']) => toDecimal(roundUp(moneyFromWire(maxSend), 2));

async function ensureLogin(ctl: Ctl, gen: number): Promise<string> {
  const s = ctl.state;
  if (s.anchorToken && s.anchorTokenExp > Date.now() + 60_000) return s.anchorToken;
  ctl.set({ remitBusy: 'Freighter: your anchor session expired, sign in again (SEP-10, never submitted)' });
  // The wallet SDK is large, so it loads only when it is needed.
  const { anchorLogin } = await import('./anchor');
  const pk = s.pubkey!;
  const { token, exp } = await anchorLogin(pk, (xdr) => freighterSign(xdr, pk));
  guard(gen);
  ctl.set({ anchorToken: token, anchorTokenExp: exp });
  return token;
}

async function ensureSetup(ctl: Ctl, gen: number) {
  if (ctl.state.setupDone) return;
  ctl.set({ remitBusy: 'Freighter: set up your account, one time only (sponsored, you pay no XLM)' });
  const pk = ctl.state.pubkey!;
  const { xdr } = await api.setup(pk, ['MXN']);
  guard(gen);
  const signed = await freighterSign(xdr, pk);
  guard(gen);
  await horizon.submitTransaction(StellarSdk.TransactionBuilder.fromXDR(signed, NP) as StellarSdk.Transaction);
  guard(gen);
  ctl.set({ setupDone: true });
}

/** Refreshes the Corra quote shortly before it expires, and the anchor's firm quote too. */
async function freshQuote(ctl: Ctl, gen: number) {
  const q = ctl.state.quote!;
  const aq = ctl.state.anchorQuote;
  if (q.expiresAt > Date.now() + 10_000) {
    if (!aq || aq.expiresAt < Date.now() + 60_000) await refreshAnchorQuote(ctl, q.maxSend, gen);
    return q;
  }
  ctl.set({ remitBusy: 'Quote expired, refreshing…' });
  const fresh = await api.quote(q.corridor, q.dest);
  guard(gen);
  ctl.set({ quote: fresh });
  if (fresh.maxSend.amount !== q.maxSend.amount || !aq || aq.expiresAt < Date.now() + 60_000) {
    await refreshAnchorQuote(ctl, fresh.maxSend, gen);
  }
  return fresh;
}

async function signPayment(ctl: Ctl, recipient: string, gen: number) {
  const q = await freshQuote(ctl, gen);
  if (Number(depositAmount(q.maxSend)) > ANCHOR_MAX_DEPOSIT) {
    throw new Error(`This payment needs a deposit of ${depositAmount(q.maxSend)} MXN; the anchor accepts at most ${ANCHOR_MAX_DEPOSIT.toLocaleString('en-US')} MXN. Lower the amount.`);
  }
  const pk = ctl.state.pubkey!;
  ctl.set({ remitBusy: 'Freighter: sign the payment. Corra holds it until your cash-in arrives.' });
  const acct = await horizon.loadAccount(pk);
  guard(gen);
  const tx = buildStrictReceive({
    networkPassphrase: NP,
    sender: pk,
    senderSequence: acct.sequence,
    recipient,
    dest: moneyFromWire(q.dest),
    sendMax: moneyFromWire(q.maxSend),
    path: q.path,
    now: Math.floor(Date.now() / 1000),
  });
  const signedXdr = await freighterSign(tx.toXDR(), pk);
  guard(gen);
  return { q, signedXdr };
}

/** Opens the SEP-24 deposit for a payment and links it, so the anchor's callback can find it. */
async function openCashIn(ctl: Ctl, token: string, p: TrackedPayment | PaymentWire, gen: number) {
  ctl.set({ remitBusy: 'Opening the anchor deposit…' });
  const { startDeposit } = await import('./anchor');
  const dep = await startDeposit(token, ctl.state.pubkey!, depositAmount(p.quote.maxSend), await cashInMemo(p.id), p.quote.anchorQuoteId);
  guard(gen);
  try {
    await api.linkCashIn(p.id, dep.id);
  } catch (e) {
    // A ref is write-once. Settlement does not depend on it: the deposit is matched on chain by
    // the payment's memo, so a deposit restarted after a reload still settles this payment.
    if (!(e instanceof ApiError && e.code === 'CASH_IN_ALREADY_LINKED')) throw e;
  }
  guard(gen);
  rememberCashIn(ctl.state.pubkey!, p.id, dep.url);
  // No automatic window.open: after several awaits the browser no longer treats it as a user
  // gesture and blocks the popup. The button opens it on a real click.
  ctl.set({ cashInUrl: dep.url, remitBusy: null, popupBlocked: false });
}

// React state updates are not synchronous, so a double click could read a stale `remitBusy` and
// start two flows. This flag flips before the first await.
let inFlight = false;
async function exclusive(fn: () => Promise<void>) {
  if (inFlight) return;
  inFlight = true;
  try {
    await fn();
  } finally {
    inFlight = false;
  }
}

/**
 * Hands a confirmed payment to the tracking flow, then starts its cash-in. A cash-in failure no
 * longer leaves the user on Review (where another click would sign a second payment): they land
 * on the cash-in step with the error and a retry.
 */
async function afterConfirm(ctl: Ctl, token: string, p: PaymentWire, gen: number, depositNeeded: boolean) {
  rememberPayment(ctl.state.pubkey!, p.id);
  ctl.set({ payment: { ...p, events: [] }, cashInUrl: null, remitStep: 'cashin', remitBusy: null, depositSkipped: !depositNeeded });
  watch(ctl, p.id);
  if (!depositNeeded) return;
  try {
    await openCashIn(ctl, token, p, gen);
  } catch (e) {
    if (e instanceof Aborted) throw e;
    ctl.set({ remitBusy: null, remitError: 'The payment is signed and held, but the deposit did not start: ' + errText(e) });
  }
}

/**
 * A signed payment whose /confirm got no answer (network error or 5xx). The server may have
 * stored it, so a retry sends the same signature with the same idempotency key: it gets the
 * stored payment back, or creates it once. Never re-signs, never creates a second payment.
 */
let unconfirmed: { sender: string; quoteId: string; recipient: string; signedXdr: string; key: string } | null = null;

/** One button: setup if needed, sign the payment once, hand it over, start cash-in. */
export const signAndSend = (ctl: Ctl) => exclusive(async () => {
  const s = ctl.state;
  if (!s.pubkey || !s.quote) return;
  const gen = generation;
  ctl.set({ remitError: null });
  try {
    await assertFreighterReady(s.pubkey);
    guard(gen);
    const token = await ensureLogin(ctl, gen);
    await ensureSetup(ctl, gen);
    // No expiry check: the server answers a known key with the stored payment even after the
    // quote expired, and a key it never saw gets QUOTE_EXPIRED (4xx), which clears this.
    const retry = unconfirmed && unconfirmed.sender === s.pubkey && unconfirmed.recipient === s.addr &&
      unconfirmed.quoteId === s.quote.id ? unconfirmed : null;
    const { q, signedXdr } = retry ? { q: s.quote, signedXdr: retry.signedXdr } : await signPayment(ctl, s.addr, gen);
    const key = retry?.key ?? newKey();
    unconfirmed = { sender: s.pubkey, quoteId: q.id, recipient: s.addr, signedXdr, key };
    ctl.set({ remitBusy: 'Handing the signed payment to Corra…' });
    const aq = ctl.state.anchorQuote;
    let p: PaymentWire;
    try {
      p = await api.confirm(
        { quoteId: q.id, sender: s.pubkey, recipient: s.addr, signedXdr,
          ...(aq ? { anchorQuote: { id: aq.id, expiresAt: aq.expiresAt } } : {}) },
        key,
      );
    } catch (e) {
      // The server answered with a decision: this signature is settled one way or the other.
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) unconfirmed = null;
      throw e;
    }
    unconfirmed = null;
    guard(gen);
    await afterConfirm(ctl, token, p, gen, true);
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ remitBusy: null, remitError: errText(e) });
  }
});

/** Starts (or restarts) the anchor deposit for the payment on screen, e.g. after a reload. */
export const restartDeposit = (ctl: Ctl) => exclusive(async () => {
  const p = ctl.state.payment;
  if (!p || !ctl.state.pubkey || p.state !== 'SIGNED') return;
  const gen = generation;
  ctl.set({ remitError: null });
  try {
    await assertFreighterReady(ctl.state.pubkey);
    guard(gen);
    const token = await ensureLogin(ctl, gen);
    await openCashIn(ctl, token, p, gen);
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ remitBusy: null, remitError: errText(e) });
  }
});

/** True when the failed payment's cash-in already landed, so its TESTMXN is in the sender's account. */
export const cashInLanded = (p: PaymentWire | null) =>
  !!p?.legs.find((l) => l.kind === 'cash_in' && l.status === 'CONFIRMED');

/**
 * A terminal-failed payment is never revived: a new quote and signature open a new saga. When the
 * old cash-in already landed and the wallet holds enough for the new cap, no new deposit is asked.
 */
export const resend = (ctl: Ctl) => exclusive(async () => {
  const old = ctl.state.payment;
  if (!old || !ctl.state.pubkey) return;
  const gen = generation;
  ctl.set({ remitError: null, anchorQuote: null });
  try {
    await assertFreighterReady(ctl.state.pubkey);
    guard(gen);
    const token = await ensureLogin(ctl, gen);
    ctl.set({ quote: { ...old.quote, expiresAt: 0 } });
    const { q, signedXdr } = await signPayment(ctl, old.recipientAccount, gen);
    const aq = ctl.state.anchorQuote;
    const p = await api.resign(
      { supersedesId: old.id, quoteId: q.id, signedXdr, ...(aq ? { anchorQuote: { id: aq.id, expiresAt: aq.expiresAt } } : {}) },
      newKey(),
    );
    guard(gen);
    const covered = cashInLanded(old) && ctl.state.wallet >= Number(depositAmount(q.maxSend));
    await afterConfirm(ctl, token, p, gen, !covered);
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ remitBusy: null, remitError: errText(e) });
  }
});

export function watch(ctl: Ctl, id: string) {
  stopWatch?.();
  stopWatch = api.watch(
    id,
    (p) => {
      const leftSigned = p.state !== 'SIGNED';
      ctl.set((st) => ({
        payment: p,
        trackError: null,
        remitStep: leftSigned && st.remitStep === 'cashin' ? 'track' : st.remitStep,
      }));
      if (TERMINAL.includes(p.state)) ctl.refreshBalances().catch(() => {});
    },
    (e) => ctl.set({ trackError: errText(e) }),
  );
}

export function track(ctl: Ctl, id: string) {
  const pk = ctl.state.pubkey;
  ctl.set({
    tab: 'send', remitStep: 'track', payment: null, remitError: null, trackError: null,
    cashInUrl: pk ? rememberedCashIn(pk, id) : null, popupBlocked: false, depositSkipped: false,
  });
  watch(ctl, id);
}

/** Opens the anchor's deposit page. A blocked popup falls back to a plain link on screen. */
export function openDepositWindow(ctl: Ctl) {
  const url = ctl.state.cashInUrl;
  if (!url) return;
  const w = window.open(url, 'corra-anchor', 'width=480,height=720');
  ctl.set({ popupBlocked: !w });
}

export function resetRemit(ctl: Ctl) {
  stopWatch?.();
  stopWatch = null;
  ctl.set({
    remitStep: 'form', quote: null, anchorQuote: null, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false,
  });
}

/** Called on disconnect: stops the watcher and makes any in-flight flow stop at its next await. */
export function cancelRemit() {
  generation++;
  unconfirmed = null;
  stopWatch?.();
  stopWatch = null;
  inFlight = false;
}
