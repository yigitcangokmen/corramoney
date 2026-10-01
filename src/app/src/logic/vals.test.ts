import { describe, it, expect } from 'vitest';
import { buildVals } from './vals';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  depStep:'form', depDigits:'3500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'3500', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
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
    depGo: () => {},
    depSim: () => {},
    sndSign: () => {},
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
  it('shows Install Freighter when no extension', () => {
    const v = buildVals(makeCTL());
    expect(v.connectLabel).toBe('Install Freighter');
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

  it('wallet balance is 0.00 USDC without wallet', () => {
    const v = buildVals(makeCTL());
    expect(v.walletLabel).toBe('0.00 USDC');
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

  it('hasFreighter is false in test env', () => {
    const v = buildVals(makeCTL());
    expect(v.hasFreighter).toBe(false);
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

describe('buildVals step rail', () => {
  it('has 4 steps (not 5)', () => {
    const v = buildVals(makeCTL());
    expect(v.stepRail).toHaveLength(4);
  });

  it('step numbers are 1, 2, 4, 5', () => {
    const v = buildVals(makeCTL({ sendStep: 1 }));
    const marks = v.stepRail.map((s: any) => s.mark);
    expect(marks).toEqual(['1', '2', '4', '5']);
  });

  it('marks steps done when sendStep > step number', () => {
    const v = buildVals(makeCTL({ sendStep: 4 }));
    const marks = v.stepRail.map((s: any) => s.mark);
    expect(marks[0]).toBe('✓');
    expect(marks[1]).toBe('✓');
    expect(marks[2]).toBe('4');
    expect(marks[3]).toBe('5');
  });
});

describe('buildVals send flow gates', () => {
  it('blocks send without wallet', () => {
    const v = buildVals(makeCTL({ sndDigits: '3500', addr: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ' }));
    expect(v.sndNotReady).toBe(true);
    expect(v.sndHint).toBe('Connect a wallet to send');
  });

  it('allows send with wallet and valid input', () => {
    const v = buildVals(makeCTL({
      walletMode: 'freighter', sndDigits: '3500',
      addr: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP'
    }));
    expect(v.sndNotReady).toBe(false);
  });

  it('blocks send with amount below min', () => {
    const v = buildVals(makeCTL({
      walletMode: 'freighter', sndDigits: '100',
      addr: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGHIJKLMNOP'
    }));
    expect(v.sndNotReady).toBe(true);
  });
});

describe('buildVals deposit flow gates', () => {
  it('blocks deposit without wallet', () => {
    const v = buildVals(makeCTL({ depDigits: '3500' }));
    expect(v.depNotReady).toBe(true);
    expect(v.depHint).toBe('Connect a wallet to deposit');
  });

  it('allows deposit with wallet and valid amount', () => {
    const v = buildVals(makeCTL({ walletMode: 'freighter', depDigits: '3500' }));
    expect(v.depNotReady).toBe(false);
  });
});

describe('buildVals timings', () => {
  it('uses real elapsed time, not hardcoded values', () => {
    const v = buildVals(makeCTL({ elapsed: 3.7 }));
    expect(v.timings).toHaveLength(2);
    expect(v.timings[0].label).toBe('Stellar path payment');
    expect(v.timings[0].val).toBe('3.7 s');
    expect(v.timings[1].label).toBe('A bank wire, for comparison');
    expect(v.timings[1].val).toBe('1--3 days');
  });

  it('shows 0.0 s when elapsed is 0', () => {
    const v = buildVals(makeCTL({ elapsed: 0 }));
    expect(v.timings[0].val).toBe('0.0 s');
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

describe('buildVals tx result', () => {
  it('shows failed state', () => {
    const v = buildVals(makeCTL({ txHash: 'FAILED: op_underfunded' }));
    expect(v.txFailed).toBeTruthy();
    expect(v.txOk).toBeFalsy();
  });

  it('shows success state with truncated hash', () => {
    const v = buildVals(makeCTL({ txHash: 'abcdef1234567890abcdef1234567890', ledger: 12345 }));
    expect(v.txOk).toBeTruthy();
    expect(v.txFailed).toBeFalsy();
    expect(v.txHash).toMatch(/^abcdef123456/);
    expect(v.ledger).toBe('#12345');
  });
});
