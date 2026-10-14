import { describe, it, expect } from 'vitest';
import { Account, MuxedAccount } from '@stellar/stellar-sdk';
import { buildVals } from './vals';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  pick:'PH', addr:'', remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  pos:{}, vaultDigits:'', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:0,
  history:[],
  walletMode:'none', pubkey:null, connecting:false
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
    pickedVault: () => ({ id:'blend', name:'Blend', apy:5.2, addr:'GAXGTNEY...W2WE', note:'USDC lending pool' }),
    totalVault: () => 0,
    totalEarned: () => 0,
    connect: async () => {},
    disconnect: () => {},
    refreshBalances: async () => {},
    getQuote: () => {},
    signAndSend: () => {},
    resend: () => {},
    resetRemit: () => {},
    vaultGo: () => {},
    vaultOut: (_id: string) => {},
    cashOut: () => {},
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
  id: 'pmt_1', publicId: 'CORRA-7QF3', state, recipientAccount: RECIPIENT, quote: QUOTE, legs: [],
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
});

describe('buildVals tracking', () => {
  it('marks each saga step done from the event log and links its transaction', () => {
    const p = payment('ONCHAIN', [
      { type: 'QUOTED' }, { type: 'SIGNED' },
      { type: 'CASH_IN', data: { depositTx: 'dep'.padEnd(64, '0') } },
      { type: 'ONCHAIN', data: { txHash: 'pay'.padEnd(64, '0') } },
    ]);
    const v = buildVals(makeCTL({ remitStep: 'track', payment: p }));
    expect(v.sagaSteps.map((s: any) => s.mark)).toEqual(['✓', '✓', '✓', '']);
    expect(v.sagaSteps[1].link).toContain('/tx/dep');
    expect(v.sagaSteps[2].link).toContain('/tx/pay');
    expect(v.credited).toBe(false);
  });

  it('explains a cap-exceeded payment and links the failed transaction', () => {
    const p = payment('CAP_EXCEEDED', [{ type: 'QUOTED' }, { type: 'SIGNED' }, { type: 'CASH_IN' }, { type: 'ONCHAIN' },
      { type: 'CAP_EXCEEDED', data: { txHash: 'fail'.padEnd(64, '0') } }]);
    const v = buildVals(makeCTL({ payment: p }));
    expect(v.failed).toBe(true);
    expect(v.failedTitle).toBe('The price moved past your cap, nothing was sent');
    expect(v.failedLink).toContain('/tx/fail');
    expect(v.canResend).toBe(true);
  });

  it('explains an expired payment in plain words, with punctuation', () => {
    const p = payment('EXPIRED', [{ type: 'QUOTED' }, { type: 'SIGNED' },
      { type: 'EXPIRED', data: { reason: 'maxTime passed before cash-in' } }]);
    const v = buildVals(makeCTL({ payment: p }));
    expect(v.failedTitle).toBe('The signing window closed, nothing was sent');
    expect(v.failedReason).toBe('The 30-minute window for your signature closed before your cash-in arrived. Nothing left your account.');
    expect(v.failedReason).not.toContain('maxTime');
  });

  it('explains a signature the sender used up with their own transactions', () => {
    const p = payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'sender sequence left the signing window' } }]);
    expect(buildVals(makeCTL({ payment: p })).failedReason).toMatch(/^Your account sent other transactions after you signed/);
  });

  it('says the cash-in is kept when it had landed', () => {
    const p = { ...payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'maxTime passed before the payment landed' } }]),
      legs: [{ kind: 'cash_in', status: 'CONFIRMED' }] };
    expect(buildVals(makeCTL({ payment: p })).failedReason).toContain('still in your account.');
  });

  it('titles a superseded payment distinctly and offers no resend', () => {
    const p = payment('EXPIRED', [{ type: 'EXPIRED', data: { reason: 'superseded by a newer payment' } }]);
    const v = buildVals(makeCTL({ payment: p }));
    expect(v.failedTitle).toBe('Replaced by a newer payment');
    expect(v.canResend).toBe(false);
  });

  it('treats FAILED as a failure and shows its Horizon code', () => {
    const p = payment('FAILED', [{ type: 'ONCHAIN' }, { type: 'FAILED', data: { txHash: 'bad'.padEnd(64, '0'), codes: 'op_no_trust' } }]);
    const v = buildVals(makeCTL({ payment: p }));
    expect(v.failed).toBe(true);
    expect(v.failedTitle).toBe('The network rejected the payment (op_no_trust)');
    expect(v.failedLink).toContain('/tx/bad');
  });

  it('offers to start the deposit for a SIGNED payment with no deposit page, and to reopen one that has', () => {
    const p = payment('SIGNED', [{ type: 'QUOTED' }, { type: 'SIGNED' }]);
    const none = buildVals(makeCTL({ remitStep: 'track', payment: p }));
    expect(none.canStartDeposit).toBe(true);
    expect(none.canOpenDeposit).toBe(false);
    const known = buildVals(makeCTL({ remitStep: 'track', payment: p, cashInUrl: 'https://anchor/dep' }));
    expect(known.canStartDeposit).toBe(false);
    expect(known.canOpenDeposit).toBe(true);
    expect(buildVals(makeCTL({ payment: payment('CASH_IN', []) })).canStartDeposit).toBe(false);
  });

  it('shows a plain link when the popup was blocked, and why tracking stopped', () => {
    const v = buildVals(makeCTL({ cashInUrl: 'https://anchor/dep', popupBlocked: true, trackError: 'payment not found (HTTP_404)' }));
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
