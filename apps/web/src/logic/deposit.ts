/**
 * Add money: a SEP-24 deposit into the user's own account, not tied to any payment. Corra records
 * it (POST /deposits gives the memo), the user's own anchor session starts it, and the browser
 * reports the anchor's id. Corra marks it CONFIRMED only from a chain credit carrying the memo;
 * the browser never recomputes the memo and never moves value here.
 */
import { parseUnits } from '@corra/shared';
import { api, ApiError } from './api';
import {
  ANCHOR_MAX_DEPOSIT, Aborted, assertFreighterReady, currentGeneration, ensureLogin, ensureSetup, errText, exclusive, guard, WalletError,
} from './remit';
import { safeLink } from './history';
import type { Ctl } from './types';

/** The server's MXN_AMOUNT: whole pesos and up to 2 decimals. */
export const DEPOSIT_RE = /^\d{1,7}(\.\d{1,2})?$/;
export const validDeposit = (s: string) => DEPOSIT_RE.test(s) && Number(s) >= 1 && Number(s) <= ANCHOR_MAX_DEPOSIT;
/** After this long without the anchor's payment, the card says it may take a while. */
export const DEPOSIT_SLOW_MS = 10 * 60_000;
/** The anchor's interactive page token lives 600 s (Anchor Platform default); one minute of margin. */
export const ANCHOR_PAGE_TTL_MS = 9 * 60_000;
/** A remembered deposit older than this is not resumed on connect. */
const RESUME_MS = 24 * 3_600_000;
const KEEP = 20;

type Remembered = { ref?: string; url?: string; linked?: boolean; at: number };

const depositsKey = (pk: string) => 'corra_deposits_' + pk;

export function rememberedDeposits(pk: string): Record<string, Remembered> {
  try {
    const m = JSON.parse(localStorage.getItem(depositsKey(pk)) || '{}');
    if (!m || typeof m !== 'object' || Array.isArray(m)) return {};
    const out: Record<string, Remembered> = {};
    for (const [id, e] of Object.entries(m as Record<string, any>)) {
      if (e && typeof e === 'object' && typeof e.at === 'number') out[id] = e;
    }
    return out;
  } catch {
    return {};
  }
}

/** The anchor ref and page per deposit, so a reload can relink and reopen it. Newest 20 kept. */
export function rememberDeposit(pk: string, id: string, patch: Partial<Remembered>) {
  try {
    const m = rememberedDeposits(pk);
    m[id] = { ...m[id], ...patch, at: patch.at ?? m[id]?.at ?? Date.now() };
    const keep = Object.entries(m).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
    localStorage.setItem(depositsKey(pk), JSON.stringify(Object.fromEntries(keep)));
  } catch {}
}

function forgetDeposit(pk: string, id: string) {
  try {
    const m = rememberedDeposits(pk);
    delete m[id];
    localStorage.setItem(depositsKey(pk), JSON.stringify(m));
  } catch {}
}

/** The anchor's deposit page must be an http(s) link: anything else is never stored, remembered or opened. */
export const UNSAFE_ANCHOR_PAGE = 'The anchor sent a deposit page that is not a web link, so Corra did not open it. Nothing was charged; try again.';

/** Plain words for a failed deposit start, by error code. */
export function depositErrorText(e: unknown): string {
  // A declined SEP-10 prompt or a Freighter error is the user's wallet speaking, not the anchor.
  if (e instanceof WalletError) return errText(e);
  if (!(e instanceof ApiError)) return `The anchor did not answer: ${errText(e)}. Nothing was charged; try again.`;
  if (e.status === 0) return 'Corra\'s server is not reachable. Nothing was started; try again in a moment.';
  if (e.status === 429) return 'Too many deposits from this account or this network in the last 10 minutes. Wait a few minutes, then try again.';
  if (e.code === 'ACCOUNT_NOT_READY') return 'Your account is not set up for TESTMXN yet. Set it up first: one Freighter prompt, no XLM needed.';
  if (e.status === 400) return 'Enter 1.00 to 1,000,000.00 MXN, up to 2 decimals.';
  return errText(e);
}

let stopWatch: (() => void) | null = null;

function stopWatching() {
  stopWatch?.();
  stopWatch = null;
}

function watchDeposit(ctl: Ctl, id: string) {
  stopWatching();
  stopWatch = api.watchDeposit(
    id,
    (d) => {
      ctl.set({ deposit: d });
      if (d.status === 'CONFIRMED') {
        ctl.set({ depositStep: 'credited', depositError: null });
        ctl.refreshBalances().catch(() => {});
      } else if (d.status === 'EXPIRED') {
        ctl.set({ depositStep: 'expired' });
      }
    },
    (e) => ctl.set({ depositError: 'Live status stopped: ' + errText(e) + '. The deposit still confirms when the anchor pays; History shows it.' }),
  );
}

/**
 * Records the deposit with Corra, starts it at the anchor with Corra's memo, and reports the
 * anchor's id. A failed start goes back to the form; the retry reuses the same PENDING record.
 */
export const startAddMoney = (ctl: Ctl) => exclusive(async () => {
  const s = ctl.state;
  const pk = s.pubkey;
  if (!pk || !s.setupDone || !validDeposit(s.depositAmount)) return;
  const gen = currentGeneration();
  ctl.set({ depositError: null });
  try {
    await assertFreighterReady(pk);
  } catch (e) {
    // Wrong network or a switched account: Freighter's own words, nothing was asked of anyone.
    ctl.set({ depositError: errText(e) });
    return;
  }
  try {
    guard(gen);
    ctl.set({ depositStep: 'starting' });
    const token = await ensureLogin(ctl, gen, 'depositBusy');
    const amount = Number(s.depositAmount).toFixed(2);
    const prev = ctl.state.deposit;
    let d = prev && prev.status === 'PENDING' && !prev.anchorRef && prev.account === pk &&
      parseUnits(prev.requested.amount) === parseUnits(amount) ? prev : null;
    if (!d) {
      ctl.set({ depositBusy: 'Recording the deposit with Corra...' });
      d = await api.createDeposit(pk, amount);
      guard(gen);
      ctl.set({ deposit: d });
      rememberDeposit(pk, d.id, { at: d.createdAt });
    }
    ctl.set({ depositBusy: 'Opening the anchor deposit...' });
    const { startDeposit } = await import('./anchor');
    const dep = await startDeposit(token, pk, amount, d.memo);
    guard(gen);
    const url = safeLink(dep.url);
    if (!url) {
      ctl.set({ depositStep: 'form', depositBusy: null, depositError: UNSAFE_ANCHOR_PAGE });
      return;
    }
    // Remembered before linking: if the link call is lost, the next connect reports it again.
    const openedAt = Date.now();
    rememberDeposit(pk, d.id, { ref: dep.id, url, at: openedAt });
    try {
      const linked = await api.linkDeposit(d.id, dep.id);
      guard(gen);
      ctl.set({ deposit: linked });
      rememberDeposit(pk, d.id, { linked: true });
    } catch (e) {
      if (e instanceof Aborted) throw e;
      // Anything else is relinked on the next connect; the anchor's callback (memo + account) binds it anyway.
      if (e instanceof ApiError && e.code === 'DEPOSIT_ALREADY_LINKED') rememberDeposit(pk, d.id, { linked: true });
    }
    guard(gen);
    // No automatic window.open: after several awaits the browser blocks it. The button opens it.
    ctl.set({ depositStep: 'waiting', depositUrl: url, depositUrlAt: openedAt, depositBusy: null, depositPopupBlocked: false });
    watchDeposit(ctl, d.id);
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ depositStep: 'form', depositBusy: null, depositError: depositErrorText(e),
      ...(e instanceof ApiError && e.code === 'ACCOUNT_NOT_READY' ? { setupDone: false } : {}) });
  }
});

/** The one-time sponsored setup (TESTMXN trustline), from the Balance tab. */
export const setupAccount = (ctl: Ctl) => exclusive(async () => {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const gen = currentGeneration();
  ctl.set({ depositError: null });
  try {
    await assertFreighterReady(pk);
    guard(gen);
    await ensureSetup(ctl, gen, 'depositBusy');
    ctl.set({ depositBusy: null });
    await ctl.refreshBalances();
  } catch (e) {
    if (e instanceof Aborted) return;
    ctl.set({ depositBusy: null, depositError: e instanceof ApiError && e.status === 429
      ? 'Too many account setups from this network in the last 10 minutes. Wait a few minutes, then try again.'
      : errText(e) });
  }
});

/** Opens the anchor's deposit page on a real click. A blocked popup falls back to a link. */
export function openAnchorPage(ctl: Ctl) {
  const url = ctl.state.depositUrl;
  if (!url) return;
  // Its own window: the Phase 1 cash-in page ('corra-anchor') may still be open and unpaid.
  const w = window.open(url, 'corra-anchor-deposit', 'width=480,height=720');
  ctl.set({ depositPopupBlocked: !w });
}

/** Reports anchor refs whose link call never got an answer (newest 5, one at a time). */
export async function relinkRemembered(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const open = Object.entries(rememberedDeposits(pk)).filter(([, e]) => e.ref && !e.linked)
    .sort((a, b) => b[1].at - a[1].at).slice(0, 5);
  for (const [id, e] of open) {
    try {
      await api.linkDeposit(id, e.ref!);
      rememberDeposit(pk, id, { linked: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'DEPOSIT_ALREADY_LINKED') rememberDeposit(pk, id, { linked: true });
      else if (err instanceof ApiError && err.status === 404) forgetDeposit(pk, id);
      else return;
    }
  }
}

/** Picks up the newest deposit of the last 24 h if it is still waiting for the anchor. */
export async function resumeDeposit(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!pk) return;
  const newest = Object.entries(rememberedDeposits(pk)).sort((a, b) => b[1].at - a[1].at)[0];
  if (!newest || Date.now() - newest[1].at > RESUME_MS) return;
  const [id, entry] = newest;
  let d;
  try {
    d = await api.deposit(id);
  } catch {
    return;
  }
  const s = ctl.state;
  if (d.status !== 'PENDING' || s.pubkey !== pk || s.depositStep !== 'form' || s.deposit) return;
  if (!entry.ref && !d.anchorRef) {
    // Recorded but never opened at the anchor: back to the form, so the next Add money reuses this row and memo.
    ctl.set({ deposit: d, depositStep: 'form', depositAmount: Number(d.requested.amount).toFixed(2) });
    return;
  }
  ctl.set({ deposit: d, depositStep: 'waiting',
    depositUrl: entry.url && Date.now() - entry.at < ANCHOR_PAGE_TTL_MS ? safeLink(entry.url) : null, depositUrlAt: entry.at });
  watchDeposit(ctl, id);
}

/** Start over: the PENDING record still confirms if the anchor pays it. */
export function resetDeposit(ctl: Ctl) {
  stopWatching();
  ctl.set({ depositStep: 'form', deposit: null, depositUrl: null, depositBusy: null, depositError: null, depositPopupBlocked: false });
}

/** Called on disconnect. */
export function cancelDeposit() {
  stopWatching();
}
