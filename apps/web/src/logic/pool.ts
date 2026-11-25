/**
 * The Blend lending pool on the Balance tab: read the user's position from the pool contract, and
 * move TESTMXN in or out with one Freighter signature on a Blend `submit` that Corra validates,
 * fee-bumps and sends. Corra never signs for the user and never holds the TESTMXN: the position
 * is the pool contract's record of the user's own account.
 */
import { formatUnits, parseUnits, TESTNET, TESTNET_BLEND, type PoolOpWire } from '@corra/shared';
import { MAX_POOL_AMOUNT_RAW, MAX_SOROBAN_RESOURCE_FEE } from '@corra/stellar';
import { track } from './analytics';
import { api, ApiError } from './api';
import { Aborted, assertFreighterReady, currentGeneration, errText, exclusive, freighterSign, guard, loadPaymentAccount, newKey, PAYMENT_ACCOUNT_GONE, WalletError } from './remit';
import type { PoolCfg } from './blend';
import type { AppState, Ctl } from './types';

/** The pool the app reads and moves into: the generated testnet ids, or null when none is deployed. */
export const POOL_CFG: PoolCfg | null = TESTNET_BLEND
  ? { rpcUrl: TESTNET.rpcUrl, networkPassphrase: TESTNET.networkPassphrase, poolId: TESTNET_BLEND.pool, asset: TESTNET_BLEND.asset }
  : null;
export const POOL_PLAN = TESTNET_BLEND?.plan ?? null;
export const POOL_ASSET_CODE = TESTNET_BLEND?.assetCode ?? 'TESTMXN';
/** Up to 7 whole digits and 7 decimals. */
export const POOL_AMOUNT_RE = /^\d{1,7}(\.\d{1,7})?$/;

export const STATUS_LABEL: Record<number, string> = {
  0: 'Active', 1: 'Active', 2: 'On-Ice (admin)', 3: 'On-Ice', 4: 'Frozen (admin)', 5: 'Frozen', 6: 'Setup',
};

/** The pool's status and take rate change rarely: read them once a minute. */
const CONFIG_TTL_MS = 60_000;
/** After a failed read the next one waits this long. */
const ERROR_BACKOFF_MS = 30_000;
const POLL_MS = 3000;
const POLL_FOR_MS = 60_000;
const BAD_SEQ_RETRY_MS = 2000;

let config: { at: number; value: { status: number; backstopRate: number } } | null = null;
let backoffUntil = 0;
let reading = false;
/** Bumped by each read and by cancelPool: only the latest read may clear `reading` or run `again`. */
let readSeq = 0;
/** A read was asked for while one was in flight: run one more when it ends (its answer may predate a move). */
let again = false;
/** A signed submit Corra never answered: replayed with the same key, never signed again. */
let kept: { pk: string; kind: 'supply' | 'withdraw'; amount: string; shown: string; signed: string; key: string; maxTime: number } | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** TESTMXN for people: 2 decimals at least, up to 7 when typed. */
export const poolMoney = (raw: bigint) =>
  Number(formatUnits(raw)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 7 });

/**
 * The sender's payment from the balance is waiting for its ledger: it was signed at the payment
 * account's next sequence, so a pool move now would take it (J83). A presigned cash_in payment is built at
 * current+SEQ_WINDOW with minAccountSequence=current, so a pool move at current+1 leaves its
 * sequence valid; its TESTMXN is held back by poolSupplyMax instead.
 */
export const poolBlocked = (s: Pick<AppState, 'payment' | 'pubkey'>) => {
  const p = s.payment;
  return !!p && p.senderAccount === s.pubkey && p.kind === 'balance' && (p.state === 'CASH_IN' || p.state === 'ONCHAIN');
};

/**
 * What a supply may take: the spendable TESTMXN less the most this sender's presigned cash_in
 * payment in SIGNED, CASH_IN or ONCHAIN will spend. The anchor deposit that pays for it lands in the
 * same balance, so supplying it would leave the signed payment op_underfunded. SIGNED counts too:
 * the deposit can land before the saga sees it and moves the payment to CASH_IN.
 */
export const poolSupplyMax = (s: Pick<AppState, 'payment' | 'pubkey' | 'walletSpendable'>) => {
  const p = s.payment;
  const held = !!p && p.senderAccount === s.pubkey && p.kind === 'cash_in' && (p.state === 'SIGNED' || p.state === 'CASH_IN' || p.state === 'ONCHAIN')
    ? parseUnits(p.quote.maxSend.amount) : 0n;
  const max = parseUnits(s.walletSpendable) - held;
  return max > 0n ? max : 0n;
};

/** Reads the position. A switched account drops the answer; an error keeps the last values. */
export async function refreshPool(ctl: Ctl) {
  const pk = ctl.state.pubkey;
  if (!POOL_CFG || !pk || Date.now() < backoffUntil) return;
  if (reading) {
    again = true;
    return;
  }
  reading = true;
  const mine = ++readSeq;
  if (ctl.state.poolRead === 'idle') ctl.set({ poolRead: 'reading' });
  let blend: typeof import('./blend') | undefined;
  try {
    blend = await import('./blend');
    const cached = config && Date.now() - config.at < CONFIG_TTL_MS ? config.value : undefined;
    const r = await blend.readPool(POOL_CFG, pk, cached ? { config: cached } : undefined);
    if (!cached) config = { at: Date.now(), value: { status: r.status, backstopRate: r.backstopRate } };
    if (ctl.state.pubkey !== pk) return;
    ctl.set({
      poolRead: 'ready', poolReadAt: Date.now(), poolReadError: null,
      pool: { status: r.status, bTokens: r.bTokens, underlying: formatUnits(r.underlyingRaw), underlyingRaw: r.underlyingRaw, supplyApr: r.supplyApr },
    });
  } catch (e) {
    backoffUntil = Date.now() + ERROR_BACKOFF_MS;
    if (ctl.state.pubkey !== pk) return;
    if (blend && e instanceof blend.PoolMissing) ctl.set({ poolRead: 'unavailable', pool: null });
    else ctl.set({ poolReadError: errText(e), ...(ctl.state.poolReadAt ? {} : { poolRead: 'error' as const }) });
  } finally {
    // A read cancelPool left behind must not end the reader that followed it.
    if (mine === readSeq) {
      reading = false;
      if (again) {
        again = false;
        refreshPool(ctl).catch(() => {});
      }
    }
  }
}

/** Plain words for a failed pool move. */
export function poolErrorText(e: unknown): string {
  if (e instanceof WalletError) return errText(e);
  if (e instanceof ApiError) {
    if (e.status === 0) return 'Corra\'s server is not reachable.';
    if (e.status === 422 && e.code === 'REFUSED') return `Corra refused to pay the fee for this transaction: ${e.message}. Nothing was submitted.`;
    if (e.status === 429) return 'Too many pool transactions from this account or this network in the last 10 minutes. Wait a few minutes, then try again.';
    if (e.status === 409) return 'Corra already has this transaction. Check the position and History before trying again.';
    if (e.status === 503) return 'The pool is not deployed on this testnet yet.';
    return errText(e);
  }
  const code = (e as { code?: unknown })?.code;
  if ((e as Error)?.name === 'PoolSimError') {
    if (code === 1206) return 'The pool is not taking deposits right now. Withdrawals always work.';
    if (code === 1223) return 'This asset is switched off in the pool.';
    if (code === 1220) return 'The pool is full. Try a smaller amount.';
    if (code === 1208) return 'Your pool position limit is reached.';
    if (code === 10) return 'Not enough TESTMXN in your account.';
    if (code === 13) return 'Your account has no TESTMXN trustline. Set it up first.';
    if (code === 'restore') return 'A pool record is archived on testnet. The team restores it; try again later. Nothing was signed.';
    // The simulation's own words can run to many lines of diagnostics: the first line says it.
    return `The pool refused the transaction in simulation: ${String((e as Error).message).split('\n')[0].slice(0, 200)}. Nothing was signed.`;
  }
  return errText(e);
}

/** A failure, by its result code; 'not_found' never reached the network, 'unknown' is an op the network could no longer vouch for. */
export const poolFailedText = (code: string | null) => code === 'tx_too_late'
  ? 'The 3-minute signature window passed. Nothing moved; try again.'
  : code === 'unknown' ? POOL_UNKNOWN_TEXT
  : code === 'not_found' ? 'It never reached the network. Nothing moved; try again.'
  : `The transaction failed on chain (${code ?? 'unknown'}). Nothing moved.`;

export const POOL_UNKNOWN_TEXT = 'Corra could not find out whether this landed. Check the position.';

export const KEPT_OTHER = 'Your earlier pool transaction got no answer from Corra and may still land. Press the same button with the same amount to finish it, or check the position first.';
const keptText = (error: string) => `${error} Your signature is kept: press again to retry it without signing again. Check the position first.`;

/** Polls the account's pool ops until `id` is SUCCESS or FAILED, or the time is up. */
async function settle(pk: string, op: PoolOpWire, gen: number): Promise<PoolOpWire> {
  const until = Date.now() + POLL_FOR_MS;
  let cur = op;
  while (cur.status === 'SUBMITTED' && Date.now() < until) {
    await sleep(POLL_MS);
    guard(gen);
    try {
      cur = (await api.accountPoolOps(pk, 10)).ops.find((o) => o.id === op.id) ?? cur;
    } catch {
      // the next poll looks again
    }
    guard(gen);
  }
  return cur;
}

/**
 * A signed pool move Corra never answered, for this account, button and amount, still inside its
 * time bound: the press replays it, whatever the balances say now (it may have landed already).
 */
export const poolRetryPending = (s: Pick<AppState, 'pubkey' | 'poolAmount'>, kind: 'supply' | 'withdraw') =>
  !!kept && kept.pk === s.pubkey && kept.kind === kind && kept.amount === s.poolAmount && kept.maxTime > Math.floor(Date.now() / 1000);

/** Validated amount in stroops, or the reason it is not one. */
function amountOf(s: AppState, kind: 'supply' | 'withdraw'): bigint | string {
  const underlying = s.pool?.underlyingRaw ?? 0n;
  if (kind === 'withdraw' && s.poolAmount === 'all') {
    if (underlying <= 0n) return 'Nothing in the pool to take back.';
    // The pool clamps a withdraw to the position, so 1% over takes everything despite interest since the read.
    const all = (underlying * 101n + 99n) / 100n;
    return all > MAX_POOL_AMOUNT_RAW ? 'Corra pays the fee for at most 1,000,000 TESTMXN per pool transaction.' : all;
  }
  if (!POOL_AMOUNT_RE.test(s.poolAmount) || parseUnits(s.poolAmount) <= 0n) return 'Enter an amount above 0, with up to 7 decimals.';
  const raw = parseUnits(s.poolAmount);
  if (raw > MAX_POOL_AMOUNT_RAW) return 'Corra pays the fee for at most 1,000,000 TESTMXN per pool transaction.';
  if (kind === 'supply' && raw > poolSupplyMax(s)) return poolSupplyMax(s) < parseUnits(s.walletSpendable)
    ? `That is more than ${poolMoney(poolSupplyMax(s))} TESTMXN: the rest pays for your signed payment.`
    : `That is more than your spendable ${poolMoney(parseUnits(s.walletSpendable))} TESTMXN.`;
  if (kind === 'withdraw' && raw > underlying) return `That is more than your ${poolMoney(underlying)} TESTMXN in the pool.`;
  return raw;
}

/**
 * Supply or withdraw: build and simulate the user's next transaction, one Freighter prompt, then
 * Corra validates, fee-bumps and sends it. A lost answer keeps the signed blob for a replay with
 * the same key; a tx_bad_seq (another transaction of the account landed first) rebuilds once.
 */
export const movePool = (ctl: Ctl, kind: 'supply' | 'withdraw') => exclusive(async () => {
  const s = ctl.state;
  const pk = s.pubkey;
  if (!pk || !s.setupDone || !POOL_CFG || poolBlocked(s)) return;
  const gen = currentGeneration();
  ctl.set({ poolError: null });
  if (kept && (kept.pk !== pk || kept.maxTime <= Math.floor(Date.now() / 1000))) kept = null;
  // A lost answer that landed changed the balances: the replay must not be judged by them.
  const replaying = poolRetryPending(s, kind);
  const amount = replaying ? 0n : amountOf(s, kind);
  if (typeof amount === 'string') {
    ctl.set({ poolError: amount });
    return;
  }
  const shown = replaying ? kept!.shown
    : kind === 'withdraw' && s.poolAmount === 'all' ? poolMoney(s.pool!.underlyingRaw) : poolMoney(amount);
  try {
    await assertFreighterReady(pk);
  } catch (e) {
    // Wrong network or a switched account: Freighter's own words, nothing was asked of anyone.
    ctl.set({ poolError: errText(e) });
    return;
  }
  if (kept && !replaying) {
    ctl.set({ poolError: KEPT_OTHER });
    return;
  }

  let current: { signed: string; key: string; maxTime: number } | null = kept ? { signed: kept.signed, key: kept.key, maxTime: kept.maxTime } : null;
  try {
    guard(gen);
    ctl.set({ poolStep: 'working' });
    for (let attempt = 0; ; attempt++) {
      if (!current) {
        ctl.set({ poolBusy: 'Preparing the transaction...' });
        const { buildSubmit, SUBMIT_TTL_SEC } = await import('./blend');
        const builtAt = Math.floor(Date.now() / 1000);
        // The transaction source: the payment account (its sequence), so the user's wallet is not the fee source.
        const pa = await loadPaymentAccount(ctl, pk);
        guard(gen);
        const built = await buildSubmit(POOL_CFG, pk, pa.id, pa.sequence, kind, amount, builtAt);
        guard(gen);
        if (built.resourceFee > MAX_SOROBAN_RESOURCE_FEE) {
          ctl.set({ poolStep: 'form', poolBusy: null,
            poolError: 'This transaction needs more network resources than Corra pays for. Nothing was signed.' });
          return;
        }
        ctl.set({ poolBusy: kind === 'supply'
          ? `Freighter: approve moving ${shown} ${POOL_ASSET_CODE} into the pool. One prompt; Corra pays the fee.`
          : `Freighter: approve moving ${shown} ${POOL_ASSET_CODE} out of the pool. One prompt; Corra pays the fee.` });
        const signed = await freighterSign(built.xdr, pk);
        track('sign');
        guard(gen);
        // The blob's own maxTime: a kept blob is dropped when the chain would refuse it anyway.
        current = { signed, key: newKey(), maxTime: builtAt + SUBMIT_TTL_SEC };
      }
      // An approval after the window (or a kept blob about to expire): Corra would refuse it, so send nothing.
      // A kept blob's first send may have landed: claim nothing about it and read the position.
      if (current.maxTime <= Math.floor(Date.now() / 1000) + 5) {
        kept = null;
        ctl.set({ poolStep: 'form', poolBusy: null, poolError: replaying ? POOL_UNKNOWN_TEXT : poolFailedText('tx_too_late') });
        if (replaying) refreshPool(ctl).catch(() => {});
        return;
      }
      ctl.set({ poolBusy: 'Corra is submitting it and paying the fee...' });
      let op: PoolOpWire;
      try {
        op = await api.poolSubmit(current.signed, current.key);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status >= 500) && e.status !== 503) {
          guard(gen);
          kept = { pk, kind, amount: s.poolAmount, shown, ...current };
          ctl.set({ poolStep: 'form', poolBusy: null, poolError: keptText(poolErrorText(e)) });
          return;
        }
        // Answered: whatever it said, this blob is settled.
        if (replaying) kept = null;
        throw e;
      }
      kept = null;
      guard(gen);
      const done = op.status === 'SUBMITTED' ? await settle(pk, op, gen) : op;
      if (done.status === 'SUCCESS') {
        backoffUntil = 0;
        ctl.set({ poolStep: 'done', poolBusy: null, poolAmount: '',
          poolDone: { kind, amount: shown, txHash: done.txHash, ledger: done.ledger } });
        ctl.refreshBalances().catch(() => {});
        refreshPool(ctl).catch(() => {});
        return;
      }
      if (done.status === 'FAILED' && done.resultCode === 'tx_bad_seq' && attempt === 0 && !replaying) {
        // Another transaction of this account took the sequence: rebuild at the new one, one more prompt.
        await sleep(BAD_SEQ_RETRY_MS);
        guard(gen);
        current = null;
        continue;
      }
      ctl.set({ poolStep: 'form', poolBusy: null, poolError: done.status === 'FAILED' ? poolFailedText(done.resultCode)
        : 'Corra sent it, but the network has not confirmed it within a minute. Check the position and History shortly.' });
      return;
    }
  } catch (e) {
    if (e instanceof Aborted) return;
    // The merged or reshaped payment account took setupDone down, so the pool card is gone: say it next to the setup button.
    if (e instanceof Error && e.message === PAYMENT_ACCOUNT_GONE) {
      ctl.set({ poolStep: 'form', poolBusy: null, poolError: null, depositError: POOL_PAYMENT_ACCOUNT_GONE });
      return;
    }
    ctl.set({ poolStep: 'form', poolBusy: null, poolError: poolErrorText(e) });
  }
});

export const POOL_PAYMENT_ACCOUNT_GONE = 'Your payment account is gone or no longer usable (it was closed or changed on chain), so the pool move did not start. ' +
  'Press "Set up your account" to make a new one, with no Freighter prompt, then move again. Nothing was signed.';

/** Back to the form after a done move. */
export function resetPool(ctl: Ctl) {
  ctl.set({ poolStep: 'form', poolDone: null, poolError: null, poolBusy: null });
}

/** Called on disconnect. */
export function cancelPool() {
  kept = null;
  config = null;
  backoffUntil = 0;
  readSeq++;
  reading = false;
  again = false;
}
