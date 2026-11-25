import * as StellarSdk from '@stellar/stellar-sdk';
import { getAddress, getNetworkDetails, signTransaction } from '@stellar/freighter-api';
import { cashInMemo, FIAT, moneyFromWire, parseUnits, roundUp, TESTNET, toDecimal, type FiatCode, type PaymentEvent, type PaymentWire, type QuoteWire } from '@corra/shared';
import { assertPaymentAccountSetup, buildStrictReceive, isPaymentAccount } from '@corra/stellar';
// A namespace import: this module has its own track() (a payment's status stream).
import * as analytics from './analytics';
import { api, ApiError, TERMINAL } from './api';
import { CORR } from './data';
import { readAccount, readPaymentAccount } from './stellar';
import type { Ctl } from './types';

const horizon = new StellarSdk.Horizon.Server(TESTNET.horizonUrl);
const NP = TESTNET.networkPassphrase;

export type RemitStep = 'form' | 'review' | 'cashin' | 'track';
export type TrackedPayment = PaymentWire & { events: PaymentEvent[] };

let stopWatch: (() => void) | null = null;

/** Bumped on disconnect: a flow that started under an older generation stops at its next await. */
let generation = 0;
export class Aborted extends Error {}
export const currentGeneration = () => generation;
export const guard = (gen: number) => {
  if (gen !== generation) throw new Aborted('aborted');
};

export const errText = (e: unknown) =>
  e instanceof ApiError ? `${e.message} (${e.code})` : e instanceof Error ? e.message : String(e);

/** Freighter refused or failed (a declined prompt, a switched account): the user's wallet, not the anchor. */
export class WalletError extends Error {}

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
  if (r.error) throw new WalletError(freighterMessage(r.error));
  if (address && r.signerAddress && r.signerAddress !== address) throw new WalletError(ACCOUNT_SWITCHED);
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
export const newKey = () => (typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));

/** Matches max_amount in infra/anchor/config/assets.yaml.tmpl: the anchor refuses larger deposits. */
export const ANCHOR_MAX_DEPOSIT = 1_000_000;

/** A recipient amount: at least 0.01, at most 2 decimals, no rounding. */
export const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;
export const validAmount = (s: string) => AMOUNT_RE.test(s) && Number(s) >= 0.01;

/** Exact: spendable >= maxSend. Never a float compare. */
export const coversCap = (spendable: string, maxSend: QuoteWire['maxSend']) =>
  parseUnits(spendable) >= moneyFromWire(maxSend).raw;

const tmxn = (v: string) => Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function getQuote(ctl: Ctl) {
  const s = ctl.state;
  if (!s.pubkey || !validAmount(s.destDigits)) return;
  const gen = generation;
  const iso = s.pick;
  const fiat = destFiat(iso);
  ctl.set({ remitBusy: 'Finding a route through the USDC hub…', remitError: null });
  try {
    const [quote, view, recipientOk, sent] = await Promise.all([
      api.quote(
        { from: 'MX/MXN', to: `${iso}/${fiat}` },
        { amount: s.destDigits, asset: FIAT[fiat].code, issuer: TESTNET.corridorIssuer },
      ),
      readAccount(s.pubkey),
      recipientReady(s.addr, FIAT[fiat].code),
      // The sender's recent payments: a lost /send that landed, a recent one to this recipient, a SIGNED one waiting.
      api.accountPayments(s.pubkey, 'sender', 20).then((r) => r.payments).catch(() => null),
    ]);
    guard(gen);
    if (await resolveKept(ctl, sent, gen)) return;
    // A signed Phase 1 payment still waiting for its cash-in: paying from the balance may leave it short.
    const signedWaiting = !!sent?.some((p) => p.kind === 'cash_in' && p.state === 'SIGNED');
    // After a reload or a disconnect the kept blob is gone: a recent balance payment to this recipient is the hint left.
    const recent = sent?.find((p) => p.kind === 'balance' && p.recipientAccount === s.addr &&
      RECENT_STATES.includes(p.state) && Date.now() - p.createdAt < RECENT_MS);
    if (Number(depositAmount(quote.maxSend)) > ANCHOR_MAX_DEPOSIT) {
      ctl.set({ remitBusy: null, remitError: `This payment needs a deposit of ${depositAmount(quote.maxSend)} MXN; the anchor accepts at most ${ANCHOR_MAX_DEPOSIT.toLocaleString('en-US')} MXN. Lower the amount.` });
      return;
    }
    if (!recipientOk) {
      ctl.set({ remitBusy: null, remitError: `The recipient's account cannot receive ${FIAT[fiat].code} yet: it does not exist or has no ${FIAT[fiat].code} trustline. Nothing was signed.` });
      return;
    }
    const spendable = view?.spendable ?? s.walletSpendable;
    // Only raises setupDone: a Horizon blip (null) or a lagging replica never undoes a finished setup.
    ctl.set({ quote, setupDone: ctl.state.setupDone || (!!view?.exists && !!view?.mxnTrusted && !!view?.paymentAccount),
      paymentAccount: view?.paymentAccount ?? ctl.state.paymentAccount, walletSpendable: spendable, signedWaiting,
      payFrom: coversCap(spendable, quote.maxSend) ? 'balance' : 'anchor' });
    analytics.track('quote');
    await refreshAnchorQuote(ctl, quote.maxSend, gen);
    ctl.set({ remitStep: 'review', remitBusy: null,
      remitError: recent ? `You sent ${recent.publicId} from your balance to this recipient in the last 5 minutes. Check History before sending again.` : null });
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

/** `busy` names the field the prompt text goes to: the Balance tab has its own. */
export async function ensureLogin(ctl: Ctl, gen: number, busy: 'remitBusy' | 'depositBusy' | 'cashOutBusy' = 'remitBusy'): Promise<string> {
  const s = ctl.state;
  if (s.anchorToken && s.anchorTokenExp > Date.now() + 60_000) return s.anchorToken;
  ctl.set({ [busy]: 'Freighter: your anchor session expired, sign in again (SEP-10, never submitted)' });
  // The wallet SDK is large, so it loads only when it is needed.
  const { anchorLogin } = await import('./anchor');
  const pk = s.pubkey!;
  const { token, exp } = await anchorLogin(pk, (xdr) => freighterSign(xdr, pk));
  guard(gen);
  ctl.set({ anchorToken: token, anchorTokenExp: exp });
  return token;
}

/**
 * The account, its TESTMXN trustline and its payment account, each only if missing. The payment
 * account comes first, with no wallet prompt: a throwaway key made here signs its own creation,
 * which sets that key's weight to 0 and the sender as the only signer. The key is checked against
 * that shape before it signs, sent nowhere but in that signature, and dropped. Then the sender's
 * own setup, one Freighter prompt, as in Phase 1.
 */
export async function ensureSetup(
  ctl: Ctl, gen: number, busy: 'remitBusy' | 'depositBusy' | 'cashOutBusy' = 'remitBusy', trust: FiatCode[] = ['MXN'],
) {
  // TESTPHP is the recipient's cash-out (D3): its line and the payment account that signs the withdrawal.
  const php = trust.includes('PHP');
  if (php ? ctl.state.phpTrusted && !!ctl.state.paymentAccount : ctl.state.setupDone) return;
  ctl.set({ [busy]: 'Setting up your account (sponsored, no Freighter prompt)…' });
  const pk = ctl.state.pubkey!;
  const z = ctl.state.paymentAccount ? null : StellarSdk.Keypair.random();
  let out: { xdr?: string; paymentAccountXdr?: string };
  try {
    out = await api.setup(pk, trust, z?.publicKey());
  } catch (e) {
    // Already done (a replica behind, or a setup that finished elsewhere): nothing to sign.
    if (!(e instanceof ApiError && e.code === 'NOTHING_TO_SET_UP')) throw e;
    out = {};
  }
  guard(gen);
  if (out.paymentAccountXdr) {
    if (!z) throw new Error('Corra sent a payment account setup this app did not ask for. Nothing was signed.');
    assertPaymentAccountSetup(out.paymentAccountXdr, pk, z.publicKey(), NP, TESTNET.feeSponsor);
    const tx = StellarSdk.TransactionBuilder.fromXDR(out.paymentAccountXdr, NP) as StellarSdk.Transaction;
    tx.sign(z);
    // First: the account's own setup takes the next sequence of the same source (a channel or the sponsor).
    const res = await horizon.submitTransaction(tx);
    // A new account starts at its creating ledger << 32: the first payment needs no read of it.
    created = { id: z.publicKey(), sequence: (BigInt(res.ledger) << 32n).toString() };
    guard(gen);
    // Kept even if the wallet prompt below is declined: a retry reuses it rather than making another.
    ctl.set({ paymentAccount: z.publicKey() });
  }
  if (out.xdr) {
    ctl.set({ [busy]: 'Freighter: set up your account, one time only (sponsored, you pay no XLM)' });
    const signed = await freighterSign(out.xdr, pk);
    guard(gen);
    await horizon.submitTransaction(StellarSdk.TransactionBuilder.fromXDR(signed, NP) as StellarSdk.Transaction);
    guard(gen);
  }
  // The payment account just created stays in state, not a re-read: Horizon's ?signer= can lag a ledger behind.
  ctl.set(php ? { phpTrusted: true } : { setupDone: true, mxnTrusted: true });
}

/** The payment account this page just created and its starting sequence, until Horizon first returns it. */
let created: { id: string; sequence: string } | null = null;

export const PAYMENT_ACCOUNT_GONE = 'Your payment account is gone or no longer usable (it was closed or changed on chain). Press again to set up a new one, with no Freighter prompt. Nothing was signed.';

/**
 * The sender's payment account and its current sequence, read just before signing: the one this
 * app knows, or the one Horizon finds. A closed (merged) one, or one changed on chain so it is no
 * longer a payment account (the server would refuse it), is forgotten, so the next press sets up a new one.
 */
export async function loadPaymentAccount(ctl: Ctl, pk: string): Promise<{ id: string; sequence: string }> {
  const known = ctl.state.paymentAccount;
  if (known) {
    try {
      const rec = await horizon.loadAccount(known);
      if (created?.id === known) created = null;
      if (isPaymentAccount(rec as any, pk, TESTNET.feeSponsor)) return { id: known, sequence: rec.sequence };
    } catch (e: any) {
      if (e?.response?.status !== 404) throw e;
      // Just created here: a replica behind has not seen it yet (S3), it was not merged.
      if (created?.id === known) return created;
    }
  } else {
    const found = await readPaymentAccount(pk);
    if (found) {
      ctl.set({ paymentAccount: found.id });
      return found;
    }
  }
  ctl.set({ paymentAccount: null, setupDone: false });
  throw new Error(PAYMENT_ACCOUNT_GONE);
}

/**
 * Refreshes the Corra quote shortly before it expires, and the anchor's firm quote too.
 * `withAnchor` false (a payment from the balance) never asks the anchor.
 */
async function freshQuote(ctl: Ctl, gen: number, withAnchor = true) {
  const q = ctl.state.quote!;
  const aq = ctl.state.anchorQuote;
  if (q.expiresAt > Date.now() + 10_000) {
    if (withAnchor && (!aq || aq.expiresAt < Date.now() + 60_000)) await refreshAnchorQuote(ctl, q.maxSend, gen);
    return q;
  }
  ctl.set({ remitBusy: 'Quote expired, refreshing…' });
  const fresh = await api.quote(q.corridor, q.dest);
  guard(gen);
  ctl.set({ quote: fresh });
  if (withAnchor && (fresh.maxSend.amount !== q.maxSend.amount || !aq || aq.expiresAt < Date.now() + 60_000)) {
    await refreshAnchorQuote(ctl, fresh.maxSend, gen);
  }
  return fresh;
}

/**
 * 'presigned' (Phase 1): Corra holds the blob until the cash-in lands. 'balance': the payment
 * account's next sequence, valid 5 minutes, submitted at once; refused before the prompt if the balance no longer
 * covers a refreshed cap.
 */
async function signPayment(ctl: Ctl, recipient: string, gen: number, mode: 'presigned' | 'balance' = 'presigned', onTrack = false) {
  const q = await freshQuote(ctl, gen, mode === 'presigned');
  if (Number(depositAmount(q.maxSend)) > ANCHOR_MAX_DEPOSIT) {
    throw new Error(`This payment needs a deposit of ${depositAmount(q.maxSend)} MXN; the anchor accepts at most ${ANCHOR_MAX_DEPOSIT.toLocaleString('en-US')} MXN. Lower the amount.`);
  }
  if (mode === 'balance' && !coversCap(ctl.state.walletSpendable, q.maxSend)) {
    throw new Error(`Your balance ${tmxn(ctl.state.walletSpendable)} TESTMXN no longer covers the new cap ${tmxn(q.maxSend.amount)} TESTMXN. ${onTrack ? TRACK_WAY_OUT : 'Add money on the Balance tab, or pay at the anchor instead.'} Nothing was signed.`);
  }
  const pk = ctl.state.pubkey!;
  // A covering balance implies the trustline, not the payment account: set it up first if missing (no prompt).
  await ensureSetup(ctl, gen);
  ctl.set({ remitBusy: mode === 'balance'
    ? 'Freighter: sign the payment from your balance. Corra submits it at once.'
    : 'Freighter: sign the payment. Corra holds it until your cash-in arrives.' });
  const pa = await loadPaymentAccount(ctl, pk);
  guard(gen);
  const tx = buildStrictReceive({
    networkPassphrase: NP,
    sender: pk,
    paymentAccount: pa.id,
    paymentSequence: pa.sequence,
    recipient,
    dest: moneyFromWire(q.dest),
    sendMax: moneyFromWire(q.maxSend),
    path: q.path,
    now: Math.floor(Date.now() / 1000),
    mode,
  });
  const signedXdr = await freighterSign(tx.toXDR(), pk);
  analytics.track('sign');
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
export async function exclusive(fn: () => Promise<void>) {
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
type Kept = {
  kind: 'cash_in' | 'balance'; sender: string; quoteId: string; quote: QuoteWire; recipient: string; signedXdr: string; key: string;
  /** Set when the blob re-signs this failed balance payment: it is replayed to /resign, never to /send. */
  supersedesId?: string;
};
let unconfirmed: Kept | null = null;

/** Replays a kept balance blob with its own key, to the endpoint it was first sent to. */
const submitKept = (k: Kept) => k.supersedesId
  ? api.resign({ supersedesId: k.supersedesId, quoteId: k.quoteId, signedXdr: k.signedXdr }, k.key)
  : api.send({ quoteId: k.quoteId, sender: k.sender, recipient: k.recipient, signedXdr: k.signedXdr }, k.key);

/** A balance signature whose /send got no answer, for this sender, recipient and quote: it may still land. */
export const balanceRetryPending = (s: { pubkey: string | null; addr: string; quote: QuoteWire | null }) =>
  !!unconfirmed && unconfirmed.kind === 'balance' && unconfirmed.sender === s.pubkey &&
  unconfirmed.recipient === s.addr && unconfirmed.quoteId === s.quote?.id;

/** A balance blob whose /send got no answer, for this sender, whatever the quote or recipient on screen now. */
const keptBalance = (pk: string | null) => (unconfirmed?.kind === 'balance' && unconfirmed.sender === pk ? unconfirmed : null);

/** A signed anchor payment whose /confirm got no answer, on another quote or recipient: it may be waiting for its cash-in. */
export const CASH_IN_MAY_HAVE_LANDED = 'Your earlier signed payment got no answer from Corra and may be waiting for its cash-in. Check History before paying from your balance.';
const MAY_BE_ON_ITS_WAY = 'Your payment from the balance may already be on its way; press Sign and send to finish it, or check History.';
const LANDED = 'Your earlier payment from the balance reached Corra, so no new quote was taken. Check it here before sending again.';
const RECENT_STATES = ['CASH_IN', 'ONCHAIN', 'CREDITED'];
const RECENT_MS = 5 * 60_000;

/** Back to the kept payment's Review: the next Sign and send retries its blob, never signs a new payment. */
function showKept(ctl: Ctl, kept: Kept) {
  ctl.set({ quote: kept.quote, addr: kept.recipient, payFrom: 'balance', remitStep: 'review', remitBusy: null, remitError: MAY_BE_ON_ITS_WAY });
}

/**
 * Before a new quote, settles a kept balance blob of this sender: found in its payments -> shown on
 * track; kept quote still live -> back to it; expired -> replayed with its key (the server answers
 * with the stored payment, or a 4xx when it never got it). True when getQuote must stop.
 */
async function resolveKept(ctl: Ctl, sent: PaymentWire[] | null, gen: number): Promise<boolean> {
  const kept = keptBalance(ctl.state.pubkey);
  if (!kept) return false;
  const landed = sent?.find((p) => p.quote.id === kept.quoteId);
  if (landed) {
    unconfirmed = null;
    landBalancePayment(ctl, landed, gen);
    ctl.set({ remitError: LANDED });
    return true;
  }
  if (kept.quote.expiresAt > Date.now()) {
    showKept(ctl, kept);
    return true;
  }
  ctl.set({ remitBusy: 'Checking your earlier payment from the balance...' });
  let p: PaymentWire;
  try {
    p = await submitKept(kept);
  } catch (e) {
    guard(gen);
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
      // The server never stored it, and its quote is dead: it can no longer land.
      unconfirmed = null;
      return false;
    }
    ctl.set({ remitBusy: null, remitError: errText(e) + ' Corra could not check your earlier payment from the balance. Check History before sending again.' });
    return true;
  }
  unconfirmed = null;
  landBalancePayment(ctl, p, gen);
  ctl.set({ remitError: LANDED });
  return true;
}

/** The way out from a refused balance resend, in the Track screen's own buttons. */
const TRACK_WAY_OUT = 'Add money on the Balance tab and press Sign a new payment again, or press Send another to pay at the anchor.';

/** Plain words for a refused /send (or /resign of a balance payment), by error code. */
/**
 * `q` fills the cap and asset into the copy; `kept` says whether a retry reuses the signature;
 * `onTrack` is the balance resend on the Track screen, whose buttons are Sign a new payment and Send another.
 */
export function sendErrorText(e: unknown, q: QuoteWire | null = null, kept = true, onTrack = false): string {
  if (!(e instanceof ApiError)) return errText(e);
  if (e.status === 0 || e.status >= 500) {
    return errText(e) + (kept ? ` Your signature is kept; pressing ${onTrack ? 'Sign a new payment' : 'Sign and send'} again retries it without a new prompt.` : '') +
      ' Check History before sending again.';
  }
  if (e.status === 429) return 'Too many sends from this account or this network in the last 10 minutes. Wait a few minutes, then try again.';
  switch (e.code) {
    case 'PAYMENT_IN_PROGRESS':
      return 'Another payment from your account is still settling. Wait until it is credited or fails, then press Sign and send again.';
    case 'SIGNED_PAYMENT_WAITING':
      return 'You have a signed payment waiting for its cash-in, so paying from your balance stays blocked until it is credited or expires. Finish its deposit, or pay at the anchor instead.';
    case 'INSUFFICIENT_BALANCE':
      return `Your balance no longer covers this payment (it needs up to ${q ? tmxn(q.maxSend.amount) : '?'} TESTMXN). ${onTrack ? TRACK_WAY_OUT : 'Add money on the Balance tab, or pay at the anchor instead.'}`;
    case 'QUOTE_EXPIRED':
    case 'QUOTE_NOT_FOUND':
      return 'The quote expired before Corra received your signature. Press Sign and send to sign against a fresh quote.';
    case 'QUOTE_USED':
    case 'DUPLICATE_TRANSACTION':
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'This quote was already used. Go back and get a new quote.';
    case 'UNBOUND_TRANSACTION':
      return /sequence is not the .*next/.test(e.message)
        ? 'Another Corra payment or pool step used your payment account\'s next sequence number after you signed, so this signature cannot be used. Press Sign and send to sign again.'
        : errText(e);
    case 'RECIPIENT_NO_TRUSTLINE':
      return `The recipient's account cannot receive ${q?.dest.asset ?? 'this asset'} yet: it does not exist or has no ${q?.dest.asset ?? 'such'} trustline. Nothing was sent.`;
    default:
      return errText(e);
  }
}

/** One button: setup if needed, sign the payment once, hand it over, start cash-in. */
export const signAndSend = (ctl: Ctl) => exclusive(async () => {
  const s = ctl.state;
  if (!s.pubkey || !s.quote) return;
  const gen = generation;
  ctl.set({ remitError: null });
  try {
    await assertFreighterReady(s.pubkey);
    guard(gen);
    // The balance path runs only while the screen offers it (it covers the cap), or to retry a kept balance signature.
    const pending = balanceRetryPending(s);
    // An unanswered /confirm may have stored a SIGNED payment that a balance payment would pay a second time:
    // the same quote and recipient replay that /confirm below, whatever tile is on; any other is refused.
    const keptCashIn = unconfirmed?.kind === 'cash_in' && unconfirmed.sender === s.pubkey ? unconfirmed : null;
    if (s.payFrom === 'balance' && keptCashIn && (keptCashIn.recipient !== s.addr || keptCashIn.quoteId !== s.quote.id)) {
      ctl.set({ remitError: CASH_IN_MAY_HAVE_LANDED });
      return;
    }
    if (s.payFrom === 'balance' && !keptCashIn && (coversCap(s.walletSpendable, s.quote.maxSend) || pending)) return await sendFromBalance(ctl, gen);
    // An unanswered /send (this quote or an older one) may have landed: a new payment now could pay twice.
    const kept = keptBalance(s.pubkey);
    if (kept) {
      showKept(ctl, kept);
      return;
    }
    const token = await ensureLogin(ctl, gen);
    await ensureSetup(ctl, gen);
    // No expiry check: the server answers a known key with the stored payment even after the
    // quote expired, and a key it never saw gets QUOTE_EXPIRED (4xx), which clears this.
    const retry = unconfirmed && unconfirmed.kind === 'cash_in' && unconfirmed.sender === s.pubkey && unconfirmed.recipient === s.addr &&
      unconfirmed.quoteId === s.quote.id ? unconfirmed : null;
    const { q, signedXdr } = retry ? { q: s.quote, signedXdr: retry.signedXdr } : await signPayment(ctl, s.addr, gen);
    const key = retry?.key ?? newKey();
    unconfirmed = { kind: 'cash_in', sender: s.pubkey, quoteId: q.id, quote: q, recipient: s.addr, signedXdr, key };
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

/**
 * A payment from TESTMXN already in the account: one prompt (no anchor login, no setup: a covering
 * balance implies the trustline), handed to /send, which submits it at once. An unanswered /send
 * keeps the blob and key for the next press, as /confirm does.
 */
async function sendFromBalance(ctl: Ctl, gen: number) {
  const s = ctl.state;
  const pk = s.pubkey!;
  const recipient = s.addr;
  try {
    const retry = balanceRetryPending(s) ? unconfirmed : null;
    const { q, signedXdr } = retry ? { q: s.quote!, signedXdr: retry.signedXdr } : await signPayment(ctl, recipient, gen, 'balance');
    const key = retry?.key ?? newKey();
    unconfirmed = { kind: 'balance', sender: pk, quoteId: q.id, quote: q, recipient, signedXdr, key, supersedesId: retry?.supersedesId };
    ctl.set({ remitBusy: 'Handing the signed payment to Corra...' });
    let p: PaymentWire;
    try {
      p = await submitKept(unconfirmed);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) unconfirmed = null;
      throw e;
    }
    unconfirmed = null;
    landBalancePayment(ctl, p, gen);
  } catch (e) {
    if (e instanceof Aborted) return;
    const q = ctl.state.quote;
    if (e instanceof ApiError && (e.code === 'QUOTE_EXPIRED' || e.code === 'QUOTE_NOT_FOUND') && q) {
      ctl.set({ quote: { ...q, expiresAt: 0 } });
    }
    if (e instanceof ApiError && e.code === 'INSUFFICIENT_BALANCE') await ctl.refreshBalances().catch(() => {});
    // The balance tiles hide once it no longer covers the cap; the next press is the anchor path the screen shows.
    // A kept signature keeps the balance choice: the next press retries it.
    if (q && !coversCap(ctl.state.walletSpendable, q.maxSend) && !balanceRetryPending(ctl.state)) ctl.set({ payFrom: 'anchor' });
    ctl.set({ remitBusy: null, remitError: sendErrorText(e, q, !!keptBalance(pk)) });
  }
}

/** A balance payment needs no cash-in: straight to tracking. */
function landBalancePayment(ctl: Ctl, p: PaymentWire, gen: number) {
  guard(gen);
  rememberPayment(ctl.state.pubkey!, p.id);
  ctl.set({ payment: { ...p, events: [] }, remitStep: 'track', remitBusy: null, cashInUrl: null, depositSkipped: false });
  watch(ctl, p.id);
}

/** Starts (or restarts) the anchor deposit for the payment on screen, e.g. after a reload. */
export const restartDeposit = (ctl: Ctl) => exclusive(async () => {
  const p = ctl.state.payment;
  // Only the sender deposits for a payment; a received one opens the same Track screen.
  if (!p || !ctl.state.pubkey || p.state !== 'SIGNED' || p.senderAccount !== ctl.state.pubkey) return;
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
  if (!old || !ctl.state.pubkey || old.senderAccount !== ctl.state.pubkey) return;
  const gen = generation;
  const kept = keptBalance(ctl.state.pubkey);
  // A kept /resign of this very payment is replayed below; any other kept blob goes first.
  if (kept && !(old.kind === 'balance' && kept.supersedesId === old.id)) {
    showKept(ctl, kept);
    return;
  }
  if (old.kind === 'balance') return resendFromBalance(ctl, old, gen);
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

/**
 * A failed balance payment is re-signed from the balance: /resign, no anchor quote, no deposit.
 * An unanswered /resign keeps the blob and key: the next press replays them, never signs again,
 * since the first one may still land and a second would pay the recipient twice.
 */
async function resendFromBalance(ctl: Ctl, old: TrackedPayment, gen: number) {
  if (old.senderAccount !== ctl.state.pubkey) return;
  const pk = ctl.state.pubkey!;
  const retry = keptBalance(pk)?.supersedesId === old.id ? unconfirmed : null;
  ctl.set({ remitError: null, anchorQuote: null });
  try {
    await assertFreighterReady(pk);
    guard(gen);
    let kept: Kept;
    if (retry) {
      kept = retry;
    } else {
      ctl.set({ quote: { ...old.quote, expiresAt: 0 }, payFrom: 'balance' });
      await ctl.refreshBalances();
      guard(gen);
      const { q, signedXdr } = await signPayment(ctl, old.recipientAccount, gen, 'balance', true);
      kept = { kind: 'balance', sender: pk, quoteId: q.id, quote: q, recipient: old.recipientAccount, signedXdr, key: newKey(), supersedesId: old.id };
      unconfirmed = kept;
    }
    ctl.set({ remitBusy: 'Handing the signed payment to Corra...' });
    let p: PaymentWire;
    try {
      p = await submitKept(kept);
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) unconfirmed = null;
      throw e;
    }
    unconfirmed = null;
    landBalancePayment(ctl, p, gen);
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ remitBusy: null, remitError: sendErrorText(e, ctl.state.quote, !!keptBalance(pk), true) });
  }
}

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
    payFrom: 'anchor', signedWaiting: false,
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
