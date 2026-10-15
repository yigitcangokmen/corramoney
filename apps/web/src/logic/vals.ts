import { CORR, TABS, SAGA_STEPS } from './data';
import { chip, cta, flat } from './styles';
import { StrKey } from '@stellar/stellar-sdk';
import { TESTNET } from '@corra/shared';
import { cashInLanded, depositAmount, validAmount } from './remit';
import type { Ctl } from './types';

export type Vals = Record<string, any>;

/** Plain words for the saga's recorded reasons. */
const REASONS: Record<string, string> = {
  'maxTime passed before cash-in': 'The 30-minute window for your signature closed before your cash-in arrived.',
  'maxTime passed before the payment landed': 'The 30-minute window for your signature closed before the payment could be submitted.',
  'superseded by a newer payment': 'You signed a newer payment, so this one was cancelled.',
  'sender sequence left the signing window': 'Your account sent other transactions after you signed, so this signature can no longer be used.',
};

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

export function buildVals(ctl: Ctl): Vals {
  const s = ctl.state;
  const c = ctl.corr();
  const amountOk = validAmount(s.destDigits);
  const addrErr = addressProblem(s.addr, s.pubkey);
  const addrOk = !!s.addr && !addrErr;
  const formOk = !!s.pubkey && amountOk && addrOk && !s.remitBusy;
  const q = s.quote;
  const p = s.payment;
  const loginLive = !!s.anchorToken && s.anchorTokenExp > Date.now() + 60_000;

  const eventOf = (type: string) => p?.events.find((e) => e.type === type);
  const failed = p && (p.state === 'EXPIRED' || p.state === 'CAP_EXCEEDED' || p.state === 'FAILED');
  const lastEvent = p?.events.at(-1);
  const lastData = (lastEvent?.data ?? {}) as Record<string, any>;
  const qSym = q ? (CORR.find((o) => 'TEST' + o.cur === q.dest.asset)?.sym ?? '') : '';
  const signedWaiting = p?.state === 'SIGNED';

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

    tabs: TABS.map(([id, label]) => ({
      label,
      go: () => ctl.set({ tab: id }),
      pressed: s.tab === id,
      style: 'font-size:14px; font-weight:600; padding:var(--sp-2) var(--sp-4);' +
        'border-radius:var(--r-sm); cursor:pointer; line-height:1.4;' +
        (s.tab === id
          ? 'background:var(--brand); color:var(--on); border:1px solid var(--brand);'
          : 'background:transparent; color:var(--muted); border:1px solid transparent;')
    })),
    isSend: s.tab === 'send', isHistory: s.tab === 'history',
    goSend: () => ctl.set({ tab: 'send' }),
    goHistory: () => ctl.set({ tab: 'history' }),

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
    quoteId: q?.id ?? '',
    anchorQuote: s.anchorQuote
      ? short(s.anchorQuote.id, 8, 4) + ' · ' + s.anchorQuote.sellAmount + ' MXN · until ' +
        new Date(s.anchorQuote.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : 'not available (no anchor session)',
    recipientShort: short(s.addr),
    loginDone: loginLive, setupDone: s.setupDone,
    loginLine: loginLive
      ? 'Sign in to the anchor (SEP-10): done when you connected. Never submitted, moves nothing.'
      : 'Sign in to the anchor (SEP-10). Never submitted, moves nothing.',
    promptsLeft: (loginLive ? 0 : 1) + (s.setupDone ? 0 : 1) + 1,
    signAndSend: () => ctl.signAndSend(),
    signDisabled: !!s.remitBusy,
    back: () => ctl.set({ remitStep: 'form', remitError: null }),

    // ---- send: cash-in + tracking
    paymentId: p?.publicId ?? '',
    cashInUrl: s.cashInUrl,
    reopenCashIn: () => ctl.openDepositWindow(),
    popupBlocked: s.popupBlocked && !!s.cashInUrl,
    canOpenDeposit: signedWaiting && !!s.cashInUrl,
    canStartDeposit: signedWaiting && !s.cashInUrl && !s.depositSkipped && !s.remitBusy,
    startDeposit: () => ctl.restartDeposit(),
    depositSkipped: s.depositSkipped,
    depositSkippedText: 'Your earlier cash-in is still in your account and covers this payment, so no new SPEI deposit is needed.',
    cashInDeposit: p ? amount(depositAmount(p.quote.maxSend), 2) + ' MXN (paid as TESTMXN)' : '',
    trackError: s.trackError ? 'Live tracking stopped: ' + s.trackError : '',
    sagaSteps: SAGA_STEPS.map(([type, label, detail]) => {
      const ev = eventOf(type);
      const hash = type === 'CASH_IN' ? (ev?.data as any)?.depositTx : (ev?.data as any)?.txHash;
      const isNext = !ev && !failed && p && SAGA_STEPS.findIndex(x => x[0] === type) ===
        SAGA_STEPS.findIndex(x => !eventOf(x[0]));
      return {
        label, detail,
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
    failedTitle: p?.state === 'CAP_EXCEEDED' ? 'The price moved past your cap, nothing was sent'
      : p?.state === 'FAILED' ? 'The network rejected the payment' + (lastData.codes ? ' (' + lastData.codes + ')' : '')
      : lastData.reason === 'superseded by a newer payment' ? 'Replaced by a newer payment'
      : 'The signing window closed, nothing was sent',
    failedReason: (() => {
      if (!p || !failed) return '';
      const kept = cashInLanded(p) ? ' The TESTMXN from your cash-in is still in your account.' : ' Nothing left your account.';
      if (p.state === 'CAP_EXCEEDED') return 'The route would have cost more than the cap you signed, so the network refused the payment.' + kept;
      if (p.state === 'FAILED') return 'The payment landed on Stellar as a failed transaction, so nothing reached the recipient.' + kept;
      return (REASONS[String(lastData.reason)] ?? 'The 30-minute window for your signature closed.') + kept;
    })(),
    failedLink: p?.state === 'CAP_EXCEEDED' || p?.state === 'FAILED' ? explorer(lastData.txHash) : '',
    canResend: !!failed && lastData.reason !== 'superseded by a newer payment',
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
