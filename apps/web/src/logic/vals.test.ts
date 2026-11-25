import { describe, it, expect, vi } from 'vitest';
import { Account, MuxedAccount } from '@stellar/stellar-sdk';

const retry = vi.hoisted(() => ({ pending: vi.fn((_s: any) => false) }));
vi.mock('./remit', async (orig) => ({ ...(await orig<typeof import('./remit')>()), balanceRetryPending: retry.pending }));

const { buildVals } = await import('./vals');
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  pick:'PH', addr:'', remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false, mxnTrusted:false, paymentAccount:null,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  sign:null, signState:'ask',
  wallet:0,
  history:[],
  walletMode:'none', pubkey:null, connecting:false,
  payFrom:'anchor', walletSpendable:'0', otherBalances:{}, balanceAt:0, balanceTriedAt:0, balanceFails:0, signedWaiting:false,
  depositStep:'form', depositAmount:'', deposit:null, depositUrl:null, depositUrlAt:0, depositBusy:null,
  depositError:null, depositPopupBlocked:false,
  poolRead:'idle', pool:null, poolReadAt:0, poolReadError:null, poolAmount:'', poolStep:'form', poolBusy:null,
  poolError:null, poolDone:null, phpTrusted:false, phpSpendable:'0', cashOutRead:'idle', cashOutRows:[], cashOutActive:null, cashOutBusy:null, cashOutError:null, cashOutPopupBlocked:false
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl {
  const state = { ...INITIAL, ...overrides };
  const patches: any[] = [];
  const c: any = {
    state,
    props: { mxnPerUsd: 18.35, spread: 0.005 },
    set: (p: any) => patches.push(p),
    rate: 18.35,
    spread: 0.005,
    minAmt: 200,
    maxAmt: 60000,
    trk: 0 as any,
    n: (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }),
    amt: (k: string) => parseInt((state as any)[k] || '0', 10) || 0,
    usdc: (mxn: number) => mxn / 18.35,
    corr: () => ({ iso:'PH', name:'Philippines', cur:'PHP', sym:'₱', rate:56.00 }),
    connect: async () => {},
    disconnect: () => {},
    refreshBalances: async () => {},
    getQuote: () => {},
    signAndSend: () => {},
    resend: () => {},
    resetRemit: () => {},
    signGo: () => {},
    signReject: () => {},
    log: () => {},
    stamp: () => '01/10 20:00',
    hash: () => 'abc123',
  };
  c._patches = patches;
  return c as Ctl;
}

describe('buildVals wallet state', () => {
  it('shows Connect Wallet when no extension', () => {
    const v = buildVals(makeCTL());
    expect(v.connectLabel).toBe('Connect Wallet');
    expect(v.isConnected).toBe(false);
    expect(v.notConnected).toBe(true);
  });

  it('shows Connecting... when connecting', () => {
    const v = buildVals(makeCTL({ connecting: true }));
    expect(v.connectLabel).toBe('Connecting...');
  });

  it('shows connected state with pubkey', () => {
    const v = buildVals(makeCTL({ walletMode: 'freighter', pubkey: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP' }));
    expect(v.isConnected).toBe(true);
    expect(v.notConnected).toBe(false);
    expect(v.pubkeyShort).toContain('GABC');
    expect(v.pubkeyShort).toContain('MNOP');
  });

  it('shows Freighter wallet tag', () => {
    const v = buildVals(makeCTL({ walletMode: 'freighter' }));
    expect(v.walletTag).toContain('Freighter');
  });

  it('wallet balance shows the TESTMXN the sender spends', () => {
    const v = buildVals(makeCTL());
    expect(v.walletLabel).toBe('0.00 TESTMXN');
  });
});

describe('buildVals removed mock artifacts', () => {
  it('does not have doConnectDemo', () => {
    const v = buildVals(makeCTL());
    expect(v.doConnectDemo).toBeUndefined();
  });

  it('does not have doConnectFreighter', () => {
    const v = buildVals(makeCTL());
    expect(v.doConnectFreighter).toBeUndefined();
  });

  it('does not expose hasFreighter', () => {
    const v = buildVals(makeCTL());
    expect(v.hasFreighter).toBeUndefined();
  });

  it('does not have reset', () => {
    const v = buildVals(makeCTL());
    expect(v.reset).toBeUndefined();
  });

  it('does not have sf3', () => {
    const v = buildVals(makeCTL());
    expect(v.sf3).toBeUndefined();
  });

  it('has doConnect function', () => {
    const v = buildVals(makeCTL());
    expect(typeof v.doConnect).toBe('function');
  });
});

const SENDER = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const RECIPIENT = 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO';

const QUOTE: any = {
  id: 'qt_1', mode: 'strict_receive', corridor: { from: 'MX/MXN', to: 'PH/PHP' },
  source: { amount: '329.3190139', asset: 'TESTMXN' }, dest: { amount: '1000.0000000', asset: 'TESTPHP' },
  maxSend: { amount: '334.2587992', asset: 'TESTMXN' }, path: [{ code: 'USDC', issuer: 'GUSDC' }],
  slippageBps: 150, expiresAt: Date.now() + 30_000,
};

const payment = (state: string, events: { type: string; data?: object }[]): any => ({
  id: 'pmt_1', publicId: 'CORRA-7QF3', state, senderAccount: SENDER, recipientAccount: RECIPIENT, quote: QUOTE, legs: [],
  events: events.map((e, i) => ({ seq: i + 1, from: null, to: e.type, at: Date.now(), ...e })),
});

describe('buildVals send form', () => {
  it('needs a connected wallet before quoting', () => {
    const v = buildVals(makeCTL({ addr: RECIPIENT }));
    expect(v.formNotReady).toBe(true);
    expect(v.isConnected).toBe(false); // the card shows its Connect button instead of Get a quote
    expect(v.connectLabel).toBe('Connect Wallet');
    expect(v.formHint).toMatch(/Freighter wallet, Testnet/);
  });

  it('rejects an address that is not a Stellar account', () => {
    const v = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: 'GABC' }));
    expect(v.formNotReady).toBe(true);
    expect(v.addrHint).toBe('Not a valid Stellar account address (check for a typo).');
  });

  it('rejects a G address with a bad checksum, which the old regex accepted', () => {
    const bad = RECIPIENT.slice(0, -1) + (RECIPIENT.endsWith('A') ? 'B' : 'A');
    const v = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: bad }));
    expect(v.formNotReady).toBe(true);
    expect(v.addrHint).toContain('Not a valid');
  });

  it('explains that muxed M addresses are not supported', () => {
    const m = new MuxedAccount(new Account(RECIPIENT, '0'), '7').accountId();
    const v = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: m }));
    expect(v.formNotReady).toBe(true);
    expect(v.addrHint).toContain('Muxed (M...) addresses are not supported');
  });

  it('refuses the sender\'s own account as the recipient', () => {
    const v = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: SENDER }));
    expect(v.formNotReady).toBe(true);
    expect(v.addrHint).toContain('your own account');
  });

  it('rejects amounts below 0.01 or with more than 2 decimals, without rounding them', () => {
    for (const d of ['0', '0.00', '0.001', '1.234', '.', '']) {
      const v = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: RECIPIENT, destDigits: d }));
      expect(v.formNotReady, d).toBe(true);
    }
    const ok = buildVals(makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: RECIPIENT, destDigits: '0.01' }));
    expect(ok.formNotReady).toBe(false);
    expect(buildVals(makeCTL({ destDigits: '0.001' })).amountHint).toContain('at least 0.01');
  });

  it('the amount input keeps one dot and at most 2 decimals', () => {
    const ctl: any = makeCTL();
    const v = buildVals(ctl);
    v.onDest({ target: { value: '12.3.45' } });
    v.onDest({ target: { value: '1,5a' } });
    v.onDest({ target: { value: '7.999' } });
    expect(ctl._patches.map((x: any) => x.destDigits)).toEqual(['12.34', '15', '7.99']);
  });

  it('is ready with a wallet, an amount and a valid recipient, and not while busy', () => {
    const ready = makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: RECIPIENT, destDigits: '1000' });
    expect(buildVals(ready).formNotReady).toBe(false);
    const busy = makeCTL({ pubkey: SENDER, walletMode: 'freighter', addr: RECIPIENT, remitBusy: 'working' });
    expect(buildVals(busy).formNotReady).toBe(true);
  });
});

describe('buildVals review', () => {
  it('shows the signed cap, the route and the recipient amount from the quote', () => {
    const v = buildVals(makeCTL({ remitStep: 'review', quote: QUOTE, addr: RECIPIENT }));
    expect(v.remitReview).toBe(true);
    expect(v.payUpTo).toBe('334.26 TESTMXN');
    expect(v.receive).toBe('₱1,000.00');
    expect(v.route).toBe('TESTMXN → USDC → TESTPHP');
    expect(v.slippage).toBe('1.50%');
    expect(v.depositDue).toBe('334.26 MXN');
  });

  it('takes the receive symbol from the quote, not from the corridor picked since', () => {
    // makeCTL's corridor is PH (₱); the quote on screen is for Brazil.
    const v = buildVals(makeCTL({ quote: { ...QUOTE, dest: { amount: '50.0000000', asset: 'TESTBRL' } } }));
    expect(v.receive).toBe('R$50.00');
  });

  it('VB25 shortens the quote id so the Review step does not scroll sideways on a phone', () => {
    const long = { ...QUOTE, id: 'qt_' + '0123456789abcdef'.repeat(2) };
    expect(buildVals(makeCTL({ remitStep: 'review', quote: long })).quoteId).toBe('qt_01234…cdef');
  });

  it('only says the anchor login is done when the session is live', () => {
    expect(buildVals(makeCTL({ quote: QUOTE })).loginLine).not.toContain('done');
    const live = makeCTL({ quote: QUOTE, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000 });
    expect(buildVals(live).loginLine).toContain('done when you connected');
  });

  it('counts the wallet prompts left: 3 for a first-time sender, 1 for a returning one', () => {
    expect(buildVals(makeCTL({ quote: QUOTE })).promptsLeft).toBe(3);
    const returning = makeCTL({ quote: QUOTE, setupDone: true, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000 });
    expect(buildVals(returning).promptsLeft).toBe(1);
  });

  it('C1-4 an existing trusted account without a payment account: setup needs no Freighter prompt, and the copy says so', () => {
    const trusted = makeCTL({ quote: QUOTE, setupDone: false, mxnTrusted: true, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000 });
    const v = buildVals(trusted);
    expect(v.promptsLeft).toBe(1);
    expect(v.setupPromptDone).toBe(true);
    expect(v.setupNote).toBe('Your account needs its payment account, set up once. No Freighter prompt; Corra sponsors it, so you need no XLM.');
    const fresh = buildVals(makeCTL({ quote: QUOTE }));
    expect(fresh.setupPromptDone).toBe(false);
    expect(fresh.setupNote).toBe('Your account is not set up for TESTMXN yet. One Freighter prompt; Corra sponsors the reserves, so you need no XLM.');
  });
});

describe('buildVals tracking', () => {
  it('marks each saga step done from the event log and links its transaction', () => {
    const p = payment('ONCHAIN', [
      { type: 'QUOTED' }, { type: 'SIGNED' },
      { type: 'CASH_IN', data: { depositTx: 'dep'.padEnd(64, '0') } },
      { type: 'ONCHAIN', data: { txHash: 'pay'.padEnd(64, '0') } },
    ]);
    const v = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: p }));
    expect(v.sagaSteps.map((s: any) => s.mark)).toEqual(['✓', '✓', '✓', '']);
    expect(v.sagaSteps[1].link).toContain('/tx/dep');
    expect(v.sagaSteps[2].link).toContain('/tx/pay');
    expect(v.credited).toBe(false);
  });

  it('explains a cap-exceeded payment and links the failed transaction', () => {
    const p = payment('CAP_EXCEEDED', [{ type: 'QUOTED' }, { type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN' },
      { type: 'CAP_EXCEEDED', data: { txHash: 'fail'.padEnd(64, '0') } }]);
    const v = buildVals(makeCTL({ pubkey: SENDER, payment: p }));
    expect(v.failed).toBe(true);
    expect(v.failedTitle).toBe('The price moved past your cap, nothing was sent');
    expect(v.failedLink).toContain('/tx/fail');
    expect(v.canResend).toBe(true);
  });

  it('explains an expired payment in plain words, with punctuation', () => {
    const p = payment('EXPIRED', [{ type: 'QUOTED' }, { type: 'SIGNED' },
      { type: 'EXPIRED', data: { reason: 'maxTime passed before cash-in' } }]);
    const v = buildVals(makeCTL({ pubkey: SENDER, payment: p }));
    expect(v.failedTitle).toBe('The signing window closed, nothing was sent');
    expect(v.failedReason).toBe('The 30-minute window for your signature closed before your cash-in arrived. Nothing left your account.');
    expect(v.failedReason).not.toContain('maxTime');
  });

  it('explains a signature the sender used up with their own transactions', () => {
    const p = payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'sender sequence left the signing window' } }]);
    expect(buildVals(makeCTL({ pubkey: SENDER, payment: p })).failedReason).toMatch(/^Your account sent other transactions after you signed/);
  });

  it('says the cash-in is kept when it had landed', () => {
    const p = { ...payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'maxTime passed before the payment landed' } }]),
      legs: [{ kind: 'cash_in', status: 'CONFIRMED' }] };
    expect(buildVals(makeCTL({ pubkey: SENDER, payment: p })).failedReason).toContain('still in your account.');
  });

  it('titles a superseded payment distinctly and offers no resend', () => {
    const p = payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'superseded by a newer payment' } }]);
    const v = buildVals(makeCTL({ pubkey: SENDER, payment: p }));
    expect(v.failedTitle).toBe('Replaced by a newer payment');
    expect(v.canResend).toBe(false);
  });

  it('treats FAILED as a failure and shows its Horizon code', () => {
    const p = payment('FAILED', [{ type: 'ONCHAIN' }, { type: 'FAILED', data: { txHash: 'bad'.padEnd(64, '0'), codes: 'op_no_trust' } }]);
    const v = buildVals(makeCTL({ pubkey: SENDER, payment: p }));
    expect(v.failed).toBe(true);
    expect(v.failedTitle).toBe('The network rejected the payment (op_no_trust)');
    expect(v.failedLink).toContain('/tx/bad');
  });

  it('offers to start the deposit for a SIGNED payment with no deposit page, and to reopen one that has', () => {
    const p = payment('SIGNED', [{ type: 'QUOTED' }, { type: 'SIGNED' }]);
    const none = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: p }));
    expect(none.canStartDeposit).toBe(true);
    expect(none.canOpenDeposit).toBe(false);
    const known = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: p, cashInUrl: 'https://anchor/dep' }));
    expect(known.canStartDeposit).toBe(false);
    expect(known.canOpenDeposit).toBe(true);
    expect(buildVals(makeCTL({ pubkey: SENDER, payment: payment('CASH_IN', []) })).canStartDeposit).toBe(false);
  });

  it('VR1 a received SIGNED payment offers the recipient no deposit buttons', () => {
    const p = payment('SIGNED', [{ type: 'QUOTED' }, { type: 'SIGNED' }]);
    const none = buildVals(makeCTL({ pubkey: RECIPIENT, remitStep: 'track', payment: p }));
    expect(none.canStartDeposit).toBe(false);
    expect(none.canOpenDeposit).toBe(false);
    const known = buildVals(makeCTL({ pubkey: RECIPIENT, remitStep: 'track', payment: p, cashInUrl: 'https://anchor/dep' }));
    expect(known.canOpenDeposit).toBe(false);
  });

  it('VR2 a received FAILED payment offers no resend and speaks from the recipient side', () => {
    const p = payment('FAILED', [{ type: 'FAILED', data: { codes: 'op_no_trust' } }]);
    const v = buildVals(makeCTL({ pubkey: RECIPIENT, payment: p }));
    expect(v.failed).toBe(true);
    expect(v.canResend).toBe(false);
    expect(v.failedTitle).toBe('The payment did not go through');
    expect(v.failedReason).toBe('The sender\'s payment did not land; nothing reached your account.');
    const bal = buildVals(makeCTL({ pubkey: RECIPIENT, payment: { ...payment('EXPIRED', [{ type: 'EXPIRED' }]), kind: 'balance' } }));
    expect(bal.canResend).toBe(false);
    expect(bal.failedReason).not.toContain('Your balance');
  });

  it('VR3 a received payment never speaks of the recipient\'s wallet, balance or cash-in', () => {
    const evs = [{ type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN', data: { txHash: 'a'.repeat(64), ledger: 123 } },
      { type: 'CREDITED', data: { txHash: 'a'.repeat(64), ledger: 123 } }];
    for (const kind of ['balance', 'cash_in']) {
      const v = buildVals(makeCTL({ pubkey: RECIPIENT, remitStep: 'track', payment: { ...payment('CREDITED', evs), kind } }));
      const text = v.sagaSteps.map((s: any) => s.label + ' ' + s.detail).join(' ');
      for (const bad of ['your wallet', 'your balance', 'your cash-in', 'your account.', 'to your account, verified']) expect(text, kind).not.toContain(bad);
      expect(v.sagaSteps[0].label, kind).toBe('Signed by the sender');
      expect(v.sagaSteps[3].label, kind).toBe('Credited to your account');
      if (kind === 'balance') expect(v.sagaSteps[3].detail).toBe('Settled atomically through the USDC hub. Settled in ledger 123.');
      // A viewer who is neither side is not told the payment reached their account.
      const other = buildVals(makeCTL({ pubkey: null, remitStep: 'track', payment: { ...payment('CREDITED', evs), kind } }));
      expect(other.sagaSteps[3].label, kind).toBe('Recipient credited');
      expect(other.sagaSteps[0].label, kind).toBe('Signed by the sender');
    }
  });

  it('shows a plain link when the popup was blocked, and why tracking stopped', () => {
    const v = buildVals(makeCTL({ pubkey: SENDER, cashInUrl: 'https://anchor/dep', popupBlocked: true, trackError: 'payment not found (HTTP_404)' }));
    expect(v.popupBlocked).toBe(true);
    expect(v.trackError).toBe('Live tracking stopped: payment not found (HTTP_404)');
  });
});

describe('buildVals signing sheet', () => {
  it('signOpen is false when no sign', () => {
    const v = buildVals(makeCTL());
    expect(v.signOpen).toBe(false);
  });

  it('signOpen is true when sign exists', () => {
    const v = buildVals(makeCTL({
      sign: { title: 'Test', op: 'payment', dest: 'somewhere', amt: '10 USDC', run: () => {} }
    } as any));
    expect(v.signOpen).toBe(true);
    expect(v.signAsk).toBe(true);
    expect(v.signTitle).toBe('Test');
  });
});

describe('buildVals balance tab', () => {
  const ON = { walletMode: 'freighter' as const, pubkey: SENDER };

  it('VB1 tabs are Send, Balance, History; Cash out joins them when connected', () => {
    expect(buildVals(makeCTL()).tabs.map((t: any) => t.label)).toEqual(['Send', 'Balance', 'History']);
    expect(buildVals(makeCTL(ON)).tabs.map((t: any) => t.label)).toEqual(['Send', 'Balance', 'Cash out', 'History']);
    expect(buildVals(makeCTL({ tab: 'cashout' })).isCashOut).toBe(false);
    expect(buildVals(makeCTL({ ...ON, tab: 'cashout' })).isCashOut).toBe(true);
    expect(buildVals(makeCTL({ tab: 'balance' })).isBalance).toBe(true);
  });

  it('VB2 the card has five states', () => {
    expect(buildVals(makeCTL()).balanceState).toBe('disconnected');
    expect(buildVals(makeCTL({ ...ON, balanceAt: 0 })).balanceState).toBe('reading');
    expect(buildVals(makeCTL({ ...ON, balanceAt: 1, setupDone: false })).balanceState).toBe('setup');
    expect(buildVals(makeCTL({ ...ON, balanceAt: 1, setupDone: true, wallet: 0 })).balanceState).toBe('empty');
    const funded = buildVals(makeCTL({ ...ON, balanceAt: 1, setupDone: true, wallet: 1234.5, walletSpendable: '1234.5000000' }));
    expect(funded.balanceState).toBe('funded');
    expect(funded.balanceText).toBe('1,234.50');
    expect(funded.spendableRow).toBe('');
    expect(funded.accountLink).toBe('https://stellar.expert/explorer/testnet/account/' + SENDER);
  });

  it('VB3 exactly one deposit flag per step', () => {
    for (const step of ['form', 'starting', 'waiting', 'credited', 'expired'] as const) {
      const v = buildVals(makeCTL({ depositStep: step }));
      const on = [v.depositForm, v.depositStarting, v.depositWaiting, v.depositCredited, v.depositExpired].filter(Boolean);
      expect(on, step).toHaveLength(1);
    }
  });

  const DEP: any = {
    id: 'dep_0123456789abcdef', account: SENDER, anchorRef: null, moreInfoUrl: null, memo: 'M',
    requested: { amount: '600.0000000', asset: 'TESTMXN' }, credited: null, txHash: null,
    status: 'PENDING', matchedBy: null, reason: null, createdAt: Date.now(), updatedAt: Date.now(),
  };

  it('VB4 says a deposit is slow only after 10 minutes', () => {
    expect(buildVals(makeCTL({ deposit: DEP })).depositSlow).toBe(false);
    expect(buildVals(makeCTL({ deposit: { ...DEP, createdAt: Date.now() - 11 * 60_000 } })).depositSlow).toBe(true);
    expect(buildVals(makeCTL({ deposit: { ...DEP, status: 'CONFIRMED', createdAt: 0 } })).depositSlow).toBe(false);
    expect(buildVals(makeCTL({ deposit: DEP })).depositRows).toMatchObject({ amount: '600.00 MXN', ref: 'not linked yet' });
  });

  it('VB5 shows a short credit with both figures', () => {
    const full = { ...DEP, status: 'CONFIRMED', credited: { amount: '600.0000000', asset: 'TESTMXN' } };
    expect(buildVals(makeCTL({ deposit: full })).depositCreditedText).toBe('Added 600.00 TESTMXN');
    const short = { ...full, credited: { amount: '450.0000000', asset: 'TESTMXN' }, reason: 'short credit' };
    expect(buildVals(makeCTL({ deposit: short })).depositCreditedText).toBe('Added 450.00 of 600.00 TESTMXN');
  });

  it('VB18 a waiting deposit with a partial chain credit shows both figures', () => {
    expect(buildVals(makeCTL({ deposit: DEP })).depositPartialText).toBe('');
    const part = { ...DEP, credited: { amount: '450.0000000', asset: 'TESTMXN' }, txHash: 'abc' };
    expect(buildVals(makeCTL({ deposit: part })).depositPartialText).toBe('Credited 450.00 of 600.00 TESTMXN so far.');
    expect(buildVals(makeCTL({ deposit: { ...part, status: 'CONFIRMED' } })).depositPartialText).toBe('');
  });

  it('VB19 the setup button turns grey while busy, as the other disabled buttons do', () => {
    const idle = buildVals(makeCTL({ walletMode: 'freighter', pubkey: SENDER, balanceAt: 1 }));
    const busy = buildVals(makeCTL({ walletMode: 'freighter', pubkey: SENDER, balanceAt: 1, depositBusy: 'x' }));
    expect(idle.setupBtnStyle).toBe(idle.ctaStyle);
    expect(busy.setupBtnStyle).not.toBe(busy.ctaStyle);
    expect(busy.setupBtnStyle).toBe(busy.depositBtnStyle);
  });

  it('VB6 links the anchor record only over http(s)', () => {
    expect(buildVals(makeCTL({ deposit: { ...DEP, moreInfoUrl: 'javascript:alert(1)' } })).depositAnchorLink).toBeNull();
    expect(buildVals(makeCTL({ deposit: { ...DEP, moreInfoUrl: 'http://localhost:8091/sep24/more_info?id=1' } })).depositAnchorLink)
      .toBe('http://localhost:8091/sep24/more_info?id=1');
  });

  it('VB14 hides the anchor page after 9 minutes, so the expired copy shows', () => {
    vi.useFakeTimers();
    try {
      const st = { depositStep: 'waiting' as const, deposit: DEP, depositUrl: 'https://anchor/page', depositUrlAt: Date.now(), depositPopupBlocked: true };
      expect(buildVals(makeCTL(st)).depositUrl).toBe('https://anchor/page');
      vi.advanceTimersByTime(8 * 60_000);
      expect(buildVals(makeCTL(st)).depositUrl).toBe('https://anchor/page');
      vi.advanceTimersByTime(60_000 + 1);
      const late = buildVals(makeCTL(st));
      expect(late.depositUrl).toBeNull();
      expect(late.depositPopupBlocked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('VB15 says Horizon is not answering when the first read never came back within 90 s', () => {
    const ON_READING = { walletMode: 'freighter' as const, pubkey: SENDER, balanceAt: 0 };
    // VB-U6-5: before any answer the age counts from the first read tried at connect.
    expect(buildVals(makeCTL({ ...ON_READING, balanceTriedAt: Date.now() - 10_000 })).balanceStale).toBe(false);
    const stuck = buildVals(makeCTL({ ...ON_READING, balanceTriedAt: Date.now() - 100_000 }));
    expect(stuck.balanceState).toBe('reading');
    expect(stuck.balanceStale).toBe(true);
  });

  it('VB13 says the balance may be stale after 90 s without an answer', () => {
    expect(buildVals(makeCTL({ balanceAt: Date.now() - 5_000 })).balanceStale).toBe(false);
    // VB-U6-3: the builder's sighting, a 40 s old figure after a background tab, with no failed read.
    expect(buildVals(makeCTL({ balanceAt: Date.now() - 40_000, balanceFails: 0 })).balanceStale).toBe(false);
    // VB-U6-4
    expect(buildVals(makeCTL({ balanceAt: Date.now() - 100_000 })).balanceStale).toBe(true);
    expect(buildVals(makeCTL({ balanceAt: 0 })).balanceStale).toBe(false);
  });

  it('VB-U6-1/2 two failed reads in a row are not stale, the third is; an answer resets it', () => {
    const at = Date.now() - 20_000;
    expect(buildVals(makeCTL({ balanceAt: at, balanceFails: 2 })).balanceStale).toBe(false);
    expect(buildVals(makeCTL({ balanceAt: at, balanceFails: 3 })).balanceStale).toBe(true);
    expect(buildVals(makeCTL({ balanceAt: Date.now(), balanceFails: 0 })).balanceStale).toBe(false);
  });
});

describe('buildVals pay from balance', () => {
  const REVIEW = { remitStep: 'review' as const, quote: QUOTE, addr: RECIPIENT, setupDone: false };

  it('VB7 offers the balance when it covers the cap: one prompt, no SPEI row', () => {
    const v = buildVals(makeCTL({ ...REVIEW, walletSpendable: '334.2587992', payFrom: 'balance' }));
    expect(v.canPayFromBalance).toBe(true);
    expect(v.payFromBalance).toBe(true);
    expect(v.payChoices.map((c: any) => [c.label, c.pressed])).toEqual([
      ['Pay from my balance now', true], ['Pay in pesos at the anchor', false]]);
    expect(v.promptsLeft).toBe(1);
    const anchor = buildVals(makeCTL({ ...REVIEW, walletSpendable: '334.2587992', payFrom: 'anchor' }));
    expect(anchor.payFromBalance).toBe(false);
    expect(anchor.promptsLeft).toBe(3);
  });

  it('VB8 the short-balance line shows only for 0 < spendable < cap', () => {
    expect(buildVals(makeCTL({ ...REVIEW, walletSpendable: '0' })).balanceShortText).toBe('');
    expect(buildVals(makeCTL({ ...REVIEW, walletSpendable: '334.2587992' })).balanceShortText).toBe('');
    expect(buildVals(makeCTL({ ...REVIEW, walletSpendable: '100.0000000' })).balanceShortText)
      .toBe('Your balance 100.00 TESTMXN does not cover the cap 334.26 TESTMXN, so you pay at the anchor.');
    expect(buildVals(makeCTL({ ...REVIEW, walletSpendable: '100.0000000' })).payChoices).toEqual([]);
  });

  it('VB12 warns about a signed payment waiting only on the balance path', () => {
    const base = { ...REVIEW, walletSpendable: '400', signedWaiting: true };
    expect(buildVals(makeCTL({ ...base, payFrom: 'balance' })).signedWaitingHint).toMatch(/^You have a signed payment waiting/);
    expect(buildVals(makeCTL({ ...base, payFrom: 'anchor' })).signedWaitingHint).toBe('');
  });

  it('VB16 a busy Balance tab locks Sign and send and the tiles; a busy send locks Add money and setup', () => {
    const base = { ...REVIEW, walletSpendable: '400', depositAmount: '500' };
    expect(buildVals(makeCTL(base)).signDisabled).toBe(false);
    expect(buildVals(makeCTL({ ...base, depositBusy: 'Opening the anchor deposit...' })).signDisabled).toBe(true);
    expect(buildVals(makeCTL(base)).depositOk).toBe(true);
    const sending = buildVals(makeCTL({ ...base, remitBusy: 'Handing the signed payment to Corra...' }));
    expect(sending.depositOk).toBe(false);
    expect(sending.setupDisabled).toBe(true);
    expect(buildVals(makeCTL({ ...base, depositBusy: 'Freighter: set up your account' })).setupDisabled).toBe(true);
    expect(buildVals(makeCTL(base)).setupDisabled).toBe(false);
  });

  it('VB17 a kept balance signature keeps the balance choice on screen after the balance drops', () => {
    const short = { ...REVIEW, walletSpendable: '100.0000000', payFrom: 'balance' as const };
    expect(buildVals(makeCTL(short)).payChoices).toEqual([]);
    retry.pending.mockReturnValue(true);
    try {
      const v = buildVals(makeCTL(short));
      expect(v.payFromBalance).toBe(true);
      expect(v.payChoices.map((c: any) => [c.label, c.pressed])).toEqual([
        ['Pay from my balance now', true], ['Pay in pesos at the anchor', false]]);
      expect(v.balanceShortText).toBe('');
    } finally {
      retry.pending.mockReturnValue(false);
    }
  });

  const bal = (state: string, events: { type: string; data?: object }[]) => ({ ...payment(state, events), kind: 'balance' });

  it('VB9 a balance payment has its own timeline and its ledger', () => {
    const v = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: bal('CREDITED', [
      { type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN', data: { txHash: 'a'.repeat(64), ledger: 123 } },
      { type: 'CREDITED', data: { txHash: 'a'.repeat(64), ledger: 123 } }]) as any }));
    expect(v.sagaSteps.map((s: any) => s.label)).toEqual(['Signed in your wallet', 'Paid from your balance', 'Submitted to Stellar', 'Recipient credited']);
    expect(v.sagaSteps[3].detail).toBe('Settled atomically through the USDC hub. Settled in ledger 123. They can cash out at the anchor.');
  });

  it('VB24 a FAILED balance payment whose ONCHAIN event carries a ledger never says Settled', async () => {
    const { BALANCE_STEPS } = await import('./data');
    for (const state of ['FAILED', 'CAP_EXCEEDED']) {
      const v = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: bal(state, [
        { type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN', data: { txHash: 'a'.repeat(64), ledger: 123 } },
        { type: state, data: { codes: 'op_too_few_offers' } }]) as any }));
      expect(v.sagaSteps[3].detail, state).toBe(BALANCE_STEPS[3][2]);
    }
  });

  it('VB10 a Phase 1 payment keeps the Phase 1 timeline, with no ledger text', async () => {
    const { SAGA_STEPS } = await import('./data');
    const v = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: { ...payment('CREDITED', [
      { type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN', data: { ledger: 123 } }, { type: 'CREDITED', data: { ledger: 123 } }]), kind: 'cash_in' } }));
    // A TESTPHP payment: the CREDITED step adds the cash-out sentence (PLAN 3.8), nothing else changes.
    expect(v.sagaSteps.map((s: any) => [s.label, s.detail])).toEqual(SAGA_STEPS.map(([t, l, d]) => [l, t === 'CREDITED' ? d + ' They can cash out at the anchor.' : d]));
  });

  it('VB11 an expired balance payment speaks of the 5-minute window', () => {
    const v = buildVals(makeCTL({ pubkey: SENDER, payment: bal('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'maxTime passed before the payment landed' } }]) as any }));
    expect(v.failedReason).toBe('The 5-minute window for your signature closed before the payment landed. Your TESTMXN is still in your account.');
    const under = buildVals(makeCTL({ pubkey: SENDER, payment: bal('FAILED', [{ type: 'FAILED', data: { codes: 'tx_failed,op_underfunded' } }]) as any }));
    expect(under.failedReason).toMatch(/spent by another transaction before it landed\.$/);
  });
});

describe('pool card values (D2)', () => {
  const POS = { status: 2, bTokens: 200_000_000n, underlying: '20.0000000', underlyingRaw: 200_000_000n, supplyApr: 0 };
  const ready = (o: Partial<AppState> = {}) => makeCTL({
    walletMode: 'freighter', pubkey: 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR', setupDone: true, balanceAt: 1,
    walletSpendable: '50.0000000', wallet: 50, poolRead: 'ready', pool: POS, poolReadAt: 1, poolAmount: '20', ...o,
  });

  it('VP1 unavailable after a reset; hidden until the account is set up', () => {
    expect(buildVals(ready({ poolRead: 'unavailable', pool: null })).poolState).toBe('unavailable');
    expect(buildVals(ready({ setupDone: false })).poolShown).toBe(false);
    expect(buildVals(ready()).poolShown).toBe(true);
  });

  it('VP2 reading before the first answer, error only if nothing was ever read', () => {
    expect(buildVals(ready({ poolRead: 'reading', pool: null })).poolState).toBe('reading');
    expect(buildVals(ready({ poolRead: 'error', pool: null, poolReadAt: 0 })).poolState).toBe('error');
    const stale = buildVals(ready({ poolReadError: 'down' }));
    expect([stale.poolState, stale.poolStale]).toEqual(['ready', true]);
  });

  it('VP8 the error state says why the read failed', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const PoolCard = (await import('../components/PoolCard')).default;
    const v = buildVals(ready({ poolRead: 'error', pool: null, poolReadAt: 0, poolReadError: 'RPC down' }));
    expect(v.poolReadErrorText).toBe('RPC down');
    expect(renderToStaticMarkup(createElement(PoolCard, { v }))).toContain('The pool is not answering. RPC down');
  });

  it('VP3 an empty position says so', () => {
    const v = buildVals(ready({ pool: { ...POS, bTokens: 0n, underlying: '0.0000000', underlyingRaw: 0n } }));
    expect(v.poolEmpty).toBe(true);
    expect(v.poolWithdrawOk).toBe(false);
    expect(v.poolAllOk).toBe(false);
  });

  it('VP4 Plan A: computed 0.00% APR, On-Ice note, the team as admin; another status replaces the On-Ice sentence', () => {
    const v = buildVals(ready());
    expect(v).toMatchObject({ poolPositionText: '20.00', poolRateText: '0.00% APR', poolStatusText: 'On-Ice (admin)',
      poolAdminText: 'The Corra team (testnet)', poolSupplyOk: true, poolWithdrawOk: true, poolAmountHint: 'up to 50.00 TESTMXN' });
    expect(v.poolNote).toBe('Rate 0%: the pool is On-Ice (deposits and withdrawals on, borrowing off), so nothing is earned; this proves the mechanics, not a return.' +
      ' Pool admin: the Corra team (testnet). Borrowing is off (c/l factor 0). Turning it on takes a reserve change the pool holds for one week, visible on chain, so the admin cannot move or lock your deposit without a week of notice. Withdrawals work in every pool state.');
    expect(v.poolLink).toMatch(/^https:\/\/stellar\.expert\/explorer\/testnet\/contract\/C[A-Z2-7]{55}$/);
    const frozen = buildVals(ready({ pool: { ...POS, status: 4 } }));
    expect(frozen.poolNote).toMatch(/^Status: Frozen \(admin\)\. Pool admin: the Corra team/);
    expect(buildVals(ready({ pool: { ...POS, supplyApr: 0.0123 } })).poolRateText).toBe('1.23% APR');
    expect(buildVals(ready({ poolDone: { kind: 'withdraw', amount: '20.00', txHash: 'h', ledger: 1 }, poolStep: 'done' })).poolDoneText)
      .toBe('Took 20.00 TESTMXN back');
  });

  it('VP5 Plan B: Blend\'s pool, its live rate, no On-Ice note', async () => {
    vi.resetModules();
    vi.doMock('@corra/shared', async (orig) => ({ ...(await orig<typeof import('@corra/shared')>()),
      TESTNET_BLEND: { plan: 'B', factory: 'CF', backstop: 'CB', oracle: 'CO', pool: 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF',
        asset: 'CAQC', assetCode: 'USDC', assetIssuer: 'GATAL', admin: null, deployedAt: 'x' } }));
    try {
      const b = (await import('./vals')).buildVals(ready({ pool: { ...POS, status: 1, supplyApr: 0.05 } }));
      expect(b.poolAdminText).toBe('Blend (TestnetV2)');
      expect(b.poolNote).toBe('Blend TestnetV2 USDC pool (fallback). The rate is the pool\'s live rate.');
      expect(b.poolRateText).toBe('5.00% APR');
      expect(b.poolStatusText).toBe('Active');
    } finally {
      vi.doUnmock('@corra/shared');
      vi.resetModules();
    }
  });

  it('VP6 every value-moving button is off while any flow is busy', () => {
    for (const busy of ['remitBusy', 'depositBusy', 'poolBusy'] as const) {
      const v = buildVals(ready({ [busy]: 'working...', depositAmount: '600', poolAmount: '20' }));
      expect([v.depositOk, v.setupDisabled, v.signDisabled, v.poolSupplyOk, v.poolWithdrawOk, v.poolAllOk], busy)
        .toEqual([false, true, true, false, false, false]);
    }
    const idle = buildVals(ready({ depositAmount: '600' }));
    expect([idle.depositOk, idle.setupDisabled, idle.signDisabled, idle.poolSupplyOk]).toEqual([true, false, false, true]);
  });

  it('VP7 blocked only while the sender\'s payment from the balance settles (J83)', () => {
    const v = buildVals(ready({ payment: { senderAccount: 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR', kind: 'balance', state: 'CASH_IN', events: [],
      recipientAccount: 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO', publicId: 'CORRA-1',
      quote: { maxSend: { amount: '10', asset: 'TESTMXN' }, dest: { amount: '100', asset: 'TESTPHP' } } } as any }));
    expect([v.poolBlocked, v.poolSupplyOk, v.poolWithdrawOk]).toEqual([true, false, false]);
    for (const state of ['SIGNED', 'CASH_IN']) {
      const c = buildVals(ready({ payment: { senderAccount: 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR', kind: 'cash_in', state, events: [],
        recipientAccount: 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO', publicId: 'CORRA-2',
        quote: { maxSend: { amount: '10', asset: 'TESTMXN' }, dest: { amount: '100', asset: 'TESTPHP' } } } as any }));
      expect([c.poolBlocked, c.poolSupplyOk, c.poolWithdrawOk], state).toEqual([false, true, true]);
    }
    // A cash_in payment in SIGNED or CASH_IN holds back its maxSend from a supply: the credited deposit pays for it,
    // and in SIGNED the deposit may already have landed before the saga moves it to CASH_IN.
    for (const state of ['SIGNED', 'CASH_IN']) {
      const cashIn = (poolAmount: string) => buildVals(ready({ poolAmount, walletSpendable: '50.0000000', payment: {
        senderAccount: 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR', kind: 'cash_in', state, events: [],
        recipientAccount: 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO', publicId: 'CORRA-3',
        quote: { maxSend: { amount: '10.0000000', asset: 'TESTMXN' }, dest: { amount: '100', asset: 'TESTPHP' } } } as any }));
      expect([cashIn('50').poolSupplyOk, cashIn('40').poolSupplyOk, cashIn('40').poolAmountHint], state).toEqual([false, true, 'up to 40.00 TESTMXN']);
    }
    expect(buildVals(ready({ poolAmount: 'all' })).poolSupplyOk).toBe(false);
    expect(buildVals(ready({ poolAmount: 'all' })).poolWithdrawOk).toBe(true);
    // 'all' shows the position amount in the box, not the word.
    const all = buildVals(ready({ poolAmount: 'all' }));
    expect(all.poolAmountText).toBe(all.poolPositionText);
    expect(all.poolAmountText).not.toBe('all');
  });
});

describe('buildVals cash out (D3)', () => {
  const ON = { walletMode: 'freighter' as const, pubkey: SENDER };
  const leg = (over: object = {}) => ({ kind: 'cash_out', status: 'PENDING', amount: { amount: '1000.0000000', asset: 'TESTPHP', issuer: 'GI' }, anchorId: 'a', ...over });
  const recv = (id: string, over: object = {}): any => ({ id, publicId: 'CORRA-' + id, state: 'CREDITED', recipientAccount: SENDER, createdAt: 1, legs: [leg(over)] });

  it('VC1 the Cash out buttons are off while any flow is busy; another active cash-out turns the others off', () => {
    const base = { ...ON, phpTrusted: true, paymentAccount: 'GPAY', phpSpendable: '1000', cashOutRead: 'ready' as const, cashOutRows: [recv('a'), recv('b')] };
    expect(buildVals(makeCTL(base)).cashOutRowsView.map((r: any) => r.canStart)).toEqual([true, true]);
    for (const busy of [{ remitBusy: 'x' }, { depositBusy: 'x' }, { poolBusy: 'x' }, { cashOutBusy: 'x' }]) {
      const v = buildVals(makeCTL({ ...base, ...busy }));
      expect(v.cashOutRowsView.map((r: any) => r.canStart), JSON.stringify(busy)).toEqual([false, false]);
      expect(v.cashOutSetupDisabled).toBe(true);
    }
    // The Cash out flow's own busy flag turns the other flows' buttons off too.
    expect(buildVals(makeCTL({ ...base, cashOutBusy: 'x' })).signDisabled).toBe(true);
    const v = buildVals(makeCTL({ ...base, cashOutActive: { paymentId: 'a', ref: 'w', url: 'https://a/p', urlAt: Date.now(), step: 'sign' } }));
    expect(v.cashOutRowsView.map((r: any) => [r.state, r.canStart, r.other, r.signOk])).toEqual([['sign', false, false, true], ['ready', false, true, false]]);
    expect(v.cashOutUrl).toBe('https://a/p');
  });

  it('VC2 setup copy: a prompt only when the TESTPHP line is missing; the empty list and the short row', () => {
    expect(buildVals(makeCTL({ ...ON, phpTrusted: false, paymentAccount: null })).cashOutSetupPrompt).toBe(true);
    const noPa = buildVals(makeCTL({ ...ON, phpTrusted: true, paymentAccount: null }));
    expect([noPa.cashOutNeedsSetup, noPa.cashOutSetupPrompt]).toEqual([true, false]);
    expect(buildVals(makeCTL({ ...ON, phpTrusted: true, paymentAccount: 'GPAY' })).cashOutNeedsSetup).toBe(false);
    expect(buildVals(makeCTL({ ...ON, cashOutRead: 'ready', cashOutRows: [] })).cashOutEmpty).toBe(true);
    const short = buildVals(makeCTL({ ...ON, cashOutRead: 'ready', phpSpendable: '400', cashOutRows: [recv('a')] })).cashOutRowsView[0];
    expect(short.state).toBe('short');
    expect(short.shortText).toBe("Your account holds 400.00 TESTPHP; this payment's 1,000.00 is no longer all there.");
  });

  it('VC3 the sender\'s CREDITED detail adds the cash-out sentence for TESTPHP only, never for the recipient', () => {
    const evs = [{ type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN' }, { type: 'CREDITED' }];
    const php = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: payment('CREDITED', evs) }));
    expect(php.sagaSteps[3].detail).toMatch(/ They can cash out at the anchor\.$/);
    const brl = buildVals(makeCTL({ pubkey: SENDER, remitStep: 'track', payment: { ...payment('CREDITED', evs), quote: { ...payment('CREDITED', evs).quote, dest: { amount: '10', asset: 'TESTBRL' } } } }));
    expect(brl.sagaSteps[3].detail).not.toContain('cash out');
    const asRecipient = buildVals(makeCTL({ pubkey: RECIPIENT, remitStep: 'track', payment: payment('CREDITED', evs) }));
    expect(asRecipient.sagaSteps[3].detail).not.toContain('cash out');
  });
});
