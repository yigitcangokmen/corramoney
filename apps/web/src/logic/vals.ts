import { BALANCE_STEPS, CORR, RECEIVED_BALANCE_STEPS, RECEIVED_SAGA_STEPS, TABS, SAGA_STEPS } from './data';
import { chip, cta, flat } from './styles';
import { StrKey } from '@stellar/stellar-sdk';
import { TESTNET } from '@corra/shared';
import { balanceRetryPending, cashInLanded, coversCap, depositAmount, validAmount } from './remit';
import { ANCHOR_PAGE_TTL_MS, DEPOSIT_SLOW_MS, validDeposit } from './deposit';
import { POOL_AMOUNT_RE, POOL_ASSET_CODE, POOL_CFG, POOL_PLAN, poolBlocked, poolMoney, poolRetryPending, poolSupplyMax, STATUS_LABEL } from './pool';
import { formatUnits, parseUnits } from '@corra/shared';
import { safeLink } from './history';
import { CASH_OUT_PAGE_TTL_MS, cashOutRowOf } from './cashout';
import type { Ctl } from './types';

export type Vals = Record<string, any>;

/** Plain words for the saga's recorded reasons. */
const REASONS: Record<string, string> = {
  'maxTime passed before cash-in': 'The 30-minute window for your signature closed before your cash-in arrived.',
  'maxTime passed before the payment landed': 'The 30-minute window for your signature closed before the payment could be submitted.',
  'superseded by a newer payment': 'You signed a newer payment, so this one was cancelled.',
  'sender sequence left the signing window': 'Your account sent other transactions after you signed, so this signature can no longer be used.',
  'payment account sequence left the signing window': 'Your other Corra payments or pool moves used up this signature\'s window, or your payment account was closed, so this signature can no longer be used.',
};

/** The same reasons for a payment from the balance: a 5-minute window, and nothing was taken from the balance. */
const REASONS_BALANCE: Record<string, string> = {
  'maxTime passed before the payment landed': 'The 5-minute window for your signature closed before the payment landed. Your TESTMXN is still in your account.',
  'sender sequence left the signing window': 'Your account sent another transaction first, so this signature can no longer be used. Your TESTMXN is still in your account.',
  'payment account sequence left the signing window': 'Another payment or pool move of yours went first, so this signature can no longer be used. Your TESTMXN is still in your account.',
};

/** How long the balance card trusts its last Horizon read before saying it may be stale. */
/** The Balance card says Horizon is not answering after this many failed reads in a row (8 s apart)... */
export const BALANCE_STALE_FAILS = 3;
/** ...or when nothing answered for this long (a hung read never fails). */
export const BALANCE_STALE_MS = 90_000;

/** Why an address cannot receive, or '' when it can. */
export function addressProblem(addr: string, own: string | null): string {
  if (!addr) return '';
  if (addr.startsWith('M') && StrKey.isValidMed25519PublicKey(addr)) return 'Muxed (M...) addresses are not supported. Use the G... account address.';
  if (!StrKey.isValidEd25519PublicKey(addr)) return 'Not a valid Stellar account address (check for a typo).';
  if (own && addr === own) return 'That is your own account. Enter the recipient\'s account.';
  return '';
}
const explorer = (h?: string) => (h ? 'https://stellar.expert/explorer/testnet/tx/' + h : '');
const short = (s: string, a = 6, b = 6) => (s && s.length > a + b + 1 ? s.slice(0, a) + '…' + s.slice(-b) : s || '—');
const amount = (n: string | number, d = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const accountLink = (pk: string) => 'https://stellar.expert/explorer/testnet/account/' + pk;

export function buildVals(ctl: Ctl): Vals {
  const s = ctl.state;
  const c = ctl.corr();
  const amountOk = validAmount(s.destDigits);
  const addrErr = addressProblem(s.addr, s.pubkey);
  const addrOk = !!s.addr && !addrErr;
  const formOk = !!s.pubkey && amountOk && addrOk && !s.remitBusy;
  const q = s.quote;
  const p = s.payment;
  // A received payment opens the same Track screen: only its sender may deposit for it or re-sign it.
  const isSender = !!p && p.senderAccount === s.pubkey;
  const loginLive = !!s.anchorToken && s.anchorTokenExp > Date.now() + 60_000;

  const eventOf = (type: string) => p?.events.find((e) => e.type === type);
  const failed = p && (p.state === 'EXPIRED' || p.state === 'CAP_EXCEEDED' || p.state === 'FAILED');
  const lastEvent = p?.events.at(-1);
  const lastData = (lastEvent?.data ?? {}) as Record<string, any>;
  const qSym = q ? (CORR.find((o) => 'TEST' + o.cur === q.dest.asset)?.sym ?? '') : '';
  const signedWaiting = p?.state === 'SIGNED';
  const balanceKind = p?.kind === 'balance';
  // Anyone but the sender reads the timeline from the outside; 'your account' only for the recipient.
  const isRecipient = !!p && p.recipientAccount === s.pubkey;
  const steps = isSender ? (balanceKind ? BALANCE_STEPS : SAGA_STEPS)
    : (balanceKind ? RECEIVED_BALANCE_STEPS : RECEIVED_SAGA_STEPS)
      .map(([t, l, d]): [string, string, string] => [t, t === 'CREDITED' && !isRecipient ? 'Recipient credited' : l, d]);
  // Only a credited payment settled; a FAILED or CAP_EXCEEDED one carries a ledger on ONCHAIN too.
  const settledLedger = p?.state === 'CREDITED'
    ? (eventOf('CREDITED')?.data as any)?.ledger ?? (eventOf('ONCHAIN')?.data as any)?.ledger : undefined;
  // A kept balance signature keeps the choice on screen: the next press retries it.
  const canPayFromBalance = !!q && (coversCap(s.walletSpendable, q.maxSend) || balanceRetryPending(s));
  const payFromBalance = canPayFromBalance && s.payFrom === 'balance';
  const d = s.deposit;
  // Send, Add money, the pool and Cash out share one in-flight lock: while one is busy, the others' buttons are off.
  const busy = !!s.remitBusy || !!s.depositBusy || !!s.poolBusy || !!s.cashOutBusy;
  const connected = s.walletMode !== 'none';
  const coActive = s.cashOutActive;
  const coRows = s.cashOutRows.map((r) => cashOutRowOf(r, s.phpSpendable, coActive)).filter((r) => r !== null);
  const coUrl = coActive?.url && Date.now() - coActive.urlAt < CASH_OUT_PAGE_TTL_MS ? coActive.url : null;
  const depositOk = validDeposit(s.depositAmount) && !busy;
  // The anchor's page token dies after 10 minutes; past 9 the expired copy takes over.
  const depositUrl = s.depositUrl && Date.now() - s.depositUrlAt < ANCHOR_PAGE_TTL_MS ? s.depositUrl : null;
  const pl = s.pool;
  const blocked = poolBlocked(s);
  const typedRaw = POOL_AMOUNT_RE.test(s.poolAmount) ? parseUnits(s.poolAmount) : 0n;
  const poolReady = s.poolRead === 'ready' || (!!pl && s.poolRead !== 'unavailable');
  // A kept signature for this button and amount stays pressable: it may have landed and moved the balances.
  const poolSupplyOk = !busy && !blocked && (poolRetryPending(s, 'supply') ||
    (poolReady && typedRaw > 0n && typedRaw <= poolSupplyMax(s)));
  const poolWithdrawOk = !busy && !blocked && (poolRetryPending(s, 'withdraw') || (poolReady && !!pl && pl.underlyingRaw > 0n &&
    (s.poolAmount === 'all' || (typedRaw > 0n && typedRaw <= pl.underlyingRaw))));
  const onIce = pl?.status === 2 || pl?.status === 3;
  const poolStatusText = pl ? STATUS_LABEL[pl.status] ?? 'Status ' + pl.status : '';
  // A side-by-side button that is off: the grey of cta(false).
  const flatOff = flat(false) + 'background:var(--n-100); color:var(--n-400); border:1px solid var(--n-100); cursor:not-allowed;';
  const tile = (on: boolean) => 'padding:var(--sp-4); border-radius:var(--r-sm); cursor:pointer; text-align:left;' +
    'transition:all .18s linear;' +
    (on ? 'background:var(--weak); border:1px solid var(--brand); box-shadow:0 0 0 3px rgba(14,133,70,.12);'
        : 'background:var(--surface); border:1px solid var(--line);');

  return {
    rateTop: '1 USDC = ' + ctl.n(ctl.rate, 2) + ' MXN',
    rowStyle: 'display:flex; justify-content:space-between; gap:var(--sp-3); font-size:14px;',
    kStyle: 'font-family:var(--mono); font-size:10px; letter-spacing:.14em;' +
      'text-transform:uppercase; color:var(--subtle);',
    chipStyle: chip,
    ctaStyle: cta(true),
    ctaFlat: flat(true), ghostFlat: flat(false),

    isConnected: s.walletMode !== 'none',
    notConnected: s.walletMode === 'none',
    pubkeyShort: s.pubkey ? s.pubkey.slice(0, 4) + '…' + s.pubkey.slice(-4) : '',
    connectLabel: s.connecting ? 'Connecting...' : 'Connect Wallet',
    connecting: s.connecting,
    doConnect: () => ctl.connect(),
    doDisconnect: () => ctl.disconnect(),
    walletTag: 'Freighter · testnet',
    walletLabel: ctl.n(s.wallet, 2) + ' TESTMXN',

    // Cash out is the recipient's own account at work: shown only when connected.
    tabs: TABS.filter(([id]) => id !== 'cashout' || connected).map(([id, label]) => ({
      label,
      go: () => { ctl.set({ tab: id }); if (id === 'cashout') ctl.refreshCashOuts?.(); },
      pressed: s.tab === id,
      style: 'font-size:14px; font-weight:600; padding:var(--sp-2) var(--sp-4);' +
        'border-radius:var(--r-sm); cursor:pointer; line-height:1.4;' +
        (s.tab === id
          ? 'background:var(--brand); color:var(--on); border:1px solid var(--brand);'
          : 'background:transparent; color:var(--muted); border:1px solid transparent;')
    })),
    isSend: s.tab === 'send', isBalance: s.tab === 'balance', isHistory: s.tab === 'history', isCashOut: s.tab === 'cashout' && connected,
    goSend: () => ctl.set({ tab: 'send' }),
    goBalance: () => ctl.set({ tab: 'balance' }),
    goHistory: () => ctl.set({ tab: 'history' }),

    // ---- balance card
    balanceState: s.walletMode === 'none' ? 'disconnected' : s.balanceAt === 0 ? 'reading'
      : !s.setupDone ? 'setup' : s.wallet === 0 ? 'empty' : 'funded',
    balanceText: ctl.n(s.wallet, 2),
    spendableRow: s.balanceAt && Number(s.walletSpendable) !== s.wallet
      ? amount(s.walletSpendable, 2) + ' TESTMXN (the rest is held by open offers)' : '',
    balanceUpdated: s.balanceAt ? new Date(s.balanceAt).toLocaleTimeString('en-GB') : '',
    // The age counts from the last answer, or before any answer from the first read tried at connect.
    balanceStale: s.balanceFails >= BALANCE_STALE_FAILS
      || (s.balanceAt > 0 ? Date.now() - s.balanceAt > BALANCE_STALE_MS : s.balanceTriedAt > 0 && Date.now() - s.balanceTriedAt > BALANCE_STALE_MS),
    accountLink: s.pubkey ? accountLink(s.pubkey) : '',
    otherBalanceRows: Object.entries(s.otherBalances).map(([code, bal]) => ({ k: code, val: amount(bal, 2) + ' ' + code })),
    setupNote: s.mxnTrusted
      ? 'Your account needs its payment account, set up once. No Freighter prompt; Corra sponsors it, so you need no XLM.'
      : 'Your account is not set up for TESTMXN yet. One Freighter prompt; Corra sponsors the reserves, so you need no XLM.',
    setupAccount: () => ctl.setupAccount(),
    setupDisabled: busy,
    setupBtnStyle: cta(!busy),

    // ---- balance: add money
    depositForm: s.depositStep === 'form',
    depositStarting: s.depositStep === 'starting',
    depositWaiting: s.depositStep === 'waiting',
    depositCredited: s.depositStep === 'credited',
    depositExpired: s.depositStep === 'expired',
    depositAmountText: s.depositAmount,
    onDepositAmount: (e: any) => {
      // Digits and at most one dot; at most 7 whole digits and 2 decimals, as the server accepts.
      const raw = String(e.target.value).replace(/[^0-9.]/g, '');
      const [whole, ...rest] = raw.split('.');
      const next = rest.length ? whole.slice(0, 7) + '.' + rest.join('').slice(0, 2) : whole.slice(0, 7);
      ctl.set({ depositAmount: next });
    },
    depositAmountHint: s.depositAmount && !validDeposit(s.depositAmount) ? 'Enter 1.00 to 1,000,000.00 MXN, up to 2 decimals.' : '',
    depositOk,
    depositBtnStyle: cta(depositOk),
    addMoney: () => ctl.addMoney(),
    openAnchorPage: () => ctl.openAnchorPage(),
    resetDeposit: () => ctl.resetDeposit(),
    depositBusyText: s.depositBusy,
    depositErrorText: s.depositError,
    depositPopupBlocked: s.depositPopupBlocked && !!depositUrl,
    depositUrl,
    depositSlow: d?.status === 'PENDING' && Date.now() - d.createdAt > DEPOSIT_SLOW_MS,
    depositRows: d ? {
      id: short(d.id, 8, 4),
      amount: amount(d.requested.amount, 2) + ' MXN',
      ref: d.anchorRef ? short(d.anchorRef, 8, 4) : 'not linked yet',
    } : null,
    depositCreditedText: d?.credited
      ? (d.reason?.includes('short')
        ? 'Added ' + amount(d.credited.amount, 2) + ' of ' + amount(d.requested.amount, 2) + ' TESTMXN'
        : 'Added ' + amount(d.credited.amount, 2) + ' TESTMXN')
      : '',
    // A short credit stays PENDING (with credited set) until the window closes: say what arrived so far.
    depositPartialText: d?.status === 'PENDING' && d.credited
      ? 'Credited ' + amount(d.credited.amount, 2) + ' of ' + amount(d.requested.amount, 2) + ' TESTMXN so far.' : '',
    depositTxLink: explorer(d?.txHash ?? undefined),
    depositAnchorLink: safeLink(d?.moreInfoUrl ?? null),

    // ---- cash out (D3)
    cashOutNeedsSetup: !s.phpTrusted || !s.paymentAccount,
    // The account or its TESTPHP line is missing: the account's own sponsored setup needs the wallet.
    cashOutSetupPrompt: !s.phpTrusted,
    cashOutBalanceText: amount(s.phpSpendable, 2) + ' TESTPHP',
    cashOutReading: s.cashOutRead === 'reading' || (s.cashOutRead === 'idle' && !s.cashOutRows.length),
    cashOutReadError: s.cashOutRead === 'error',
    cashOutEmpty: s.cashOutRead !== 'reading' && s.cashOutRead !== 'idle' && !coRows.length,
    cashOutBusyText: s.cashOutBusy,
    cashOutErrorText: s.cashOutError,
    cashOutPopupBlocked: s.cashOutPopupBlocked && !!coUrl,
    cashOutUrl: coUrl,
    cashOutRowsView: coRows.map((r) => {
      const other = !!coActive && coActive.paymentId !== r.id;
      const canStart = (r.state === 'ready' || (r.state === 'failed' && !r.terminal)) && !other && !busy;
      return {
        ...r,
        amountText: amount(r.amount, 2) + ' ' + r.asset,
        dateText: new Date(r.receivedAt).toLocaleString(),
        canStart, other,
        start: () => ctl.startCashOut(r.id),
        startStyle: cta(canStart),
        sign: () => ctl.signCashOut(),
        signOk: r.state === 'sign' && !busy,
        signStyle: cta(r.state === 'sign' && !busy),
        open: () => ctl.openCashOutPage(),
        reset: () => ctl.resetCashOut(),
        resetOk: !busy,
        active: coActive?.paymentId === r.id,
        txLink: explorer(r.txHash ?? undefined),
        ledger: coActive?.paymentId === r.id ? coActive.ledger ?? null : null,
        shortText: r.state === 'short'
          ? 'Your account holds ' + amount(s.phpSpendable, 2) + ' TESTPHP; this payment\'s ' + amount(r.amount, 2) + ' is no longer all there.' : '',
      };
    }),
    cashOutSetup: () => ctl.setupCashOut(),
    cashOutSetupStyle: cta(!busy),
    cashOutSetupDisabled: busy,

    // ---- balance: lending pool
    poolShown: !!POOL_CFG && s.setupDone,
    poolState: s.poolRead === 'unavailable' ? 'unavailable' : pl ? 'ready' : s.poolRead === 'error' ? 'error' : 'reading',
    poolEmpty: !!pl && pl.underlyingRaw === 0n,
    poolPositionText: pl ? poolMoney(pl.underlyingRaw) : '',
    poolRateText: pl ? (pl.supplyApr * 100).toFixed(2) + '% APR' : '',
    poolStatusText,
    poolAdminText: POOL_PLAN === 'B' ? 'Blend (TestnetV2)' : 'The Corra team (testnet)',
    poolNote: POOL_PLAN === 'B' ? 'Blend TestnetV2 USDC pool (fallback). The rate is the pool\'s live rate.'
      : (onIce || !pl
        ? 'Rate 0%: the pool is On-Ice (deposits and withdrawals on, borrowing off), so nothing is earned; this proves the mechanics, not a return.'
        : 'Status: ' + poolStatusText + '.') +
        // The team is pool and oracle admin: it could queue borrowing on (one-week timelock) and set the pool Active.
        // pool-check (verifyPool) asserts status 2 and c/l factor 0 every run.
        ' Pool admin: the Corra team (testnet). Borrowing is off (c/l factor 0). Turning it on takes a reserve change the pool holds for one week, visible on chain, so the admin cannot move or lock your deposit without a week of notice. Withdrawals work in every pool state.',
    poolLink: POOL_CFG ? 'https://stellar.expert/explorer/testnet/contract/' + POOL_CFG.poolId : '',
    poolAssetCode: POOL_ASSET_CODE,
    poolAmountText: s.poolAmount === 'all' && pl ? poolMoney(pl.underlyingRaw) : s.poolAmount,
    onPoolAmount: (e: any) => {
      // Digits and at most one dot; at most 7 whole digits and 7 decimals. Typing replaces 'all'.
      const raw = String(e.target.value).replace(/[^0-9.]/g, '');
      const [whole, ...rest] = raw.split('.');
      ctl.set({ poolAmount: rest.length ? whole.slice(0, 7) + '.' + rest.join('').slice(0, 7) : whole.slice(0, 7) });
    },
    poolAmountHint: 'up to ' + amount(formatUnits(poolSupplyMax(s)), 2) + ' ' + POOL_ASSET_CODE,
    poolSupplyOk, poolWithdrawOk,
    poolSupplyStyle: poolSupplyOk ? flat(true) : flatOff, poolWithdrawStyle: poolWithdrawOk ? flat(false) : flatOff,
    poolAllOk: !busy && !blocked && !!pl && pl.underlyingRaw > 0n,
    poolAll: () => ctl.set({ poolAmount: 'all', poolError: null }),
    poolSupply: () => ctl.movePool('supply'),
    poolWithdraw: () => ctl.movePool('withdraw'),
    resetPool: () => ctl.resetPool(),
    poolBlocked: blocked,
    poolWorking: s.poolStep === 'working',
    poolDoneStep: s.poolStep === 'done',
    poolBusyText: s.poolBusy,
    poolErrorText: s.poolError,
    poolReadErrorText: s.poolReadError,
    poolDoneText: s.poolDone
      ? (s.poolDone.kind === 'supply' ? 'Moved ' + s.poolDone.amount + ' ' + POOL_ASSET_CODE + ' into the pool'
        : 'Took ' + s.poolDone.amount + ' ' + POOL_ASSET_CODE + ' back')
      : '',
    poolDoneLink: explorer(s.poolDone?.txHash ?? undefined),
    poolStale: !!s.poolReadError && s.poolReadAt > 0,

    // ---- send: form
    remitForm: s.remitStep === 'form',
    remitReview: s.remitStep === 'review',
    remitCashin: s.remitStep === 'cashin',
    remitTrack: s.remitStep === 'track',
    busyText: s.remitBusy,
    errorText: s.remitError,
    destText: s.destDigits,
    onDest: (e: any) => {
      // Digits and at most one dot; at most 2 decimals. Never rounds what the user typed.
      const raw = String(e.target.value).replace(/[^0-9.]/g, '');
      const [whole, ...rest] = raw.split('.');
      const next = rest.length ? whole.slice(0, 9) + '.' + rest.join('').slice(0, 2) : whole.slice(0, 9);
      ctl.set({ destDigits: next });
    },
    amountHint: s.destDigits && !amountOk ? 'Enter at least 0.01, with up to 2 decimals.' : '',
    destSym: c.sym, destCur: c.cur, destCode: 'TEST' + c.cur,
    corridors: CORR.map(o => ({
      iso: o.iso, name: o.name, cur: o.cur,
      pick: () => ctl.set({ pick: o.iso }),
      pressed: s.pick === o.iso,
      style: 'padding:var(--sp-4); border-radius:var(--r-sm); cursor:pointer;' +
        'text-align:center; transition:all .18s linear;' +
        (s.pick === o.iso
          ? 'background:var(--weak); border:1px solid var(--brand); box-shadow:0 0 0 3px rgba(14,133,70,.12);'
          : 'background:var(--surface); border:1px solid var(--line);'),
      code: 'display:inline-block; font-family:var(--mono); font-size:12px; font-weight:500;' +
        'letter-spacing:.1em; padding:3px var(--sp-2); border-radius:var(--r-xs);' +
        (s.pick === o.iso ? 'background:var(--brand); color:var(--on);' : 'background:var(--sunken); color:var(--n-700);')
    })),
    pickName: c.name, pickCur: c.cur, pickIso: c.iso,
    addrText: s.addr,
    onAddr: (e: any) => ctl.set({ addr: String(e.target.value).trim() }),
    useDemo: () => ctl.set({ addr: (TESTNET as any).demoRecipient ?? '' }),
    hasDemo: !!(TESTNET as any).demoRecipient,
    addrHint: addrErr || 'The recipient needs a trustline for TEST' + c.cur + '. The demo recipient has one.',
    addrHintColor: addrErr ? 'var(--amber)' : 'var(--subtle)',
    formNotReady: !formOk,
    formBtnStyle: cta(formOk),
    formHint: !s.pubkey ? 'Freighter wallet, Testnet. Signing in moves no money.' : '',
    connectCtaStyle: cta(!s.connecting),
    freighterMissing: s.freighterMissing,
    getQuote: () => ctl.getQuote(),

    // ---- send: review
    payUpTo: q ? amount(q.maxSend.amount, 2) + ' TESTMXN' : '',
    payEst: q ? amount(q.source.amount, 2) + ' TESTMXN' : '',
    receive: q ? qSym + amount(q.dest.amount, 2) : '',
    depositDue: q ? amount(depositAmount(q.maxSend), 2) + ' MXN' : '',
    receiveCode: q ? amount(q.dest.amount, 2) + ' ' + q.dest.asset : '',
    route: q ? [q.source.asset, ...q.path.map((a: any) => a.code), q.dest.asset].join(' → ') : '',
    slippage: q ? (q.slippageBps / 100).toFixed(2) + '%' : '',
    quoteId: q ? short(q.id, 8, 4) : '',
    anchorQuote: s.anchorQuote
      ? short(s.anchorQuote.id, 8, 4) + ' · ' + s.anchorQuote.sellAmount + ' MXN · until ' +
        new Date(s.anchorQuote.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'not available (no anchor session)',
    recipientShort: short(s.addr),
    loginDone: loginLive, setupDone: s.setupDone,
    // An existing trusted account only lacks its payment account: set up with no wallet prompt.
    setupPromptDone: s.setupDone || s.mxnTrusted,
    loginLine: loginLive
      ? 'Sign in to the anchor (SEP-10): done when you connected. Never submitted, moves nothing.'
      : 'Sign in to the anchor (SEP-10). Never submitted, moves nothing.',
    promptsLeft: payFromBalance ? 1 : (loginLive ? 0 : 1) + (s.setupDone || s.mxnTrusted ? 0 : 1) + 1,
    canPayFromBalance, payFromBalance,
    payChoices: canPayFromBalance ? ([
      ['balance', 'Pay from my balance now', 'One Freighter prompt. Settles in a few seconds.'],
      ['anchor', 'Pay in pesos at the anchor', 'Sign now, pay by SPEI later.'],
    ] as const).map(([id, label, detail]) => ({
      label, detail,
      pick: () => ctl.set({ payFrom: id, remitError: null }),
      pressed: s.payFrom === id,
      style: tile(s.payFrom === id),
    })) : [],
    balanceShortText: q && Number(s.walletSpendable) > 0 && !canPayFromBalance
      ? 'Your balance ' + amount(s.walletSpendable, 2) + ' TESTMXN does not cover the cap ' + amount(q.maxSend.amount, 2) + ' TESTMXN, so you pay at the anchor.'
      : '',
    signedWaitingHint: payFromBalance && s.signedWaiting
      ? 'You have a signed payment waiting for its cash-in. Finish its deposit first, or pay at the anchor instead, which replaces it.' : '',
    signAndSend: () => ctl.signAndSend(),
    signDisabled: busy,
    back: () => ctl.set({ remitStep: 'form', remitError: null }),

    // ---- send: cash-in + tracking
    paymentId: p?.publicId ?? '',
    cashInUrl: s.cashInUrl,
    reopenCashIn: () => ctl.openDepositWindow(),
    popupBlocked: s.popupBlocked && !!s.cashInUrl,
    canOpenDeposit: isSender && signedWaiting && !!s.cashInUrl,
    canStartDeposit: isSender && signedWaiting && !s.cashInUrl && !s.depositSkipped && !s.remitBusy,
    startDeposit: () => ctl.restartDeposit(),
    depositSkipped: s.depositSkipped,
    depositSkippedText: 'Your earlier cash-in is still in your account and covers this payment, so no new SPEI deposit is needed.',
    cashInDeposit: p ? amount(depositAmount(p.quote.maxSend), 2) + ' MXN (paid as TESTMXN)' : '',
    trackError: s.trackError ? 'Live tracking stopped: ' + s.trackError : '',
    sagaSteps: steps.map(([type, label, detail]) => {
      const ev = eventOf(type);
      const hash = type === 'CASH_IN' ? (ev?.data as any)?.depositTx : (ev?.data as any)?.txHash;
      const isNext = !ev && !failed && p && steps.findIndex(x => x[0] === type) ===
        steps.findIndex(x => !eventOf(x[0]));
      return {
        label,
        detail: (balanceKind && type === 'CREDITED' && typeof settledLedger === 'number'
          ? detail + ' Settled in ledger ' + settledLedger + '.' : detail) +
          // PLAN 3.8: the recipient of a TESTPHP payment can withdraw it at the test anchor (D3).
          (isSender && type === 'CREDITED' && p?.state === 'CREDITED' && p.quote.dest.asset === 'TESTPHP' ? ' They can cash out at the anchor.' : ''),
        mark: ev ? '✓' : '',
        at: ev ? new Date(ev.at).toLocaleTimeString() : '',
        link: explorer(hash), linkText: hash ? short(hash, 8, 6) : '',
        style: 'display:flex; gap:var(--sp-3); padding:var(--sp-3) var(--sp-4); border-radius:var(--r-sm);' +
          'background:' + (ev ? 'var(--weak)' : isNext ? 'var(--sunken)' : 'transparent') + ';' +
          'opacity:' + (ev || isNext ? '1' : '.5') + ';',
        dot: 'flex:none; width:20px; height:20px; border-radius:50%; display:grid; place-items:center;' +
          'font-size:11px; font-weight:700; color:var(--on); margin-top:1px;' +
          'background:' + (ev ? 'var(--brand)' : 'var(--n-200)') + ';' +
          (isNext ? 'animation:dPulse 1.4s ease-in-out infinite;' : '')
      };
    }),
    credited: p?.state === 'CREDITED',
    failed: !!failed,
    failedTitle: p && !isSender ? 'The payment did not go through'
      : p?.state === 'CAP_EXCEEDED' ? 'The price moved past your cap, nothing was sent'
      : p?.state === 'FAILED' ? 'The network rejected the payment' + (lastData.codes ? ' (' + lastData.codes + ')' : '')
      : lastData.reason === 'superseded by a newer payment' ? 'Replaced by a newer payment'
      : 'The signing window closed, nothing was sent',
    failedReason: (() => {
      if (!p || !failed) return '';
      if (!isSender) return 'The sender\'s payment did not land; nothing reached your account.';
      if (balanceKind) {
        const notCharged = ' Your balance was not charged.';
        if (p.state === 'CAP_EXCEEDED') return 'The route would have cost more than the cap you signed, so the network refused the payment.' + notCharged;
        if (p.state === 'FAILED') return 'The payment landed on Stellar as a failed transaction, so nothing reached the recipient.' +
          (String(lastData.codes ?? '').includes('op_underfunded') ? ' Your balance was spent by another transaction before it landed.' : notCharged);
        return REASONS_BALANCE[String(lastData.reason)] ??
          (REASONS[String(lastData.reason)] ?? 'The 5-minute window for your signature closed.') + ' Your TESTMXN is still in your account.';
      }
      const kept = cashInLanded(p) ? ' The TESTMXN from your cash-in is still in your account.' : ' Nothing left your account.';
      if (p.state === 'CAP_EXCEEDED') return 'The route would have cost more than the cap you signed, so the network refused the payment.' + kept;
      if (p.state === 'FAILED') return 'The payment landed on Stellar as a failed transaction, so nothing reached the recipient.' + kept;
      return (REASONS[String(lastData.reason)] ?? 'The 30-minute window for your signature closed.') + kept;
    })(),
    failedLink: p?.state === 'CAP_EXCEEDED' || p?.state === 'FAILED' ? explorer(lastData.txHash) : '',
    canResend: isSender && !!failed && lastData.reason !== 'superseded by a newer payment',
    resend: () => ctl.resend(),
    sendAnother: () => ctl.resetRemit(),
    historyPubkey: s.pubkey,
    trackPayment: (id: string) => ctl.track(id),
    trackDest: p ? amount(p.quote.dest.amount, 2) + ' ' + p.quote.dest.asset : '',
    trackRecipient: p ? short(p.recipientAccount) : '',

    signOpen: !!s.sign,
    signAsk: !!s.sign && s.signState === 'ask',
    signBusy: !!s.sign && s.signState === 'busy',
    signTitle: s.sign ? s.sign.title : '',
    signOp: s.sign ? s.sign.op : '',
    signAmt: s.sign ? s.sign.amt : '',
    signDest: s.sign ? s.sign.dest : '',
    signGo: () => ctl.signGo(),
    signReject: () => ctl.signReject(),
  };
}
