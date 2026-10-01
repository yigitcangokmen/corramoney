import { describe, it, expect, vi } from 'vitest';
import { vaultGo, vaultOut, cashOut } from './earn';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'yield',
  depStep:'form', depDigits:'3500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'3500', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
  pos:{}, vaultDigits:'100', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:500,
  history:[],
  walletMode:'demo', pubkey:'GABCDEF', secretKey:'SABCDEF', connecting:false
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl {
  const state = { ...INITIAL, ...overrides };
  const ask = vi.fn();
  return {
    state,
    props: {},
    set: (p: any) => {
      if (typeof p === 'object') Object.assign(state, p);
    },
    rate: 18.35, spread: 0.005, minAmt: 200, maxAmt: 60000,
    trk: 0 as any,
    connect: async () => {},
    disconnect: () => {},
    refreshBalances: async () => {},
    ask,
    n: (v: number, d: number) => v.toFixed(d),
    pickedVault: () => ({ id:'blend', name:'Blend', apy:5.2, addr:'GAXGTNEY...W2WE', note:'USDC lending pool' }),
    log: () => {},
    stamp: () => '01/10 20:00',
    hash: () => 'abc123',
    _ask: ask,
  } as any;
}

describe('vaultGo', () => {
  it('calls ask for vault deposit', () => {
    const ctl = makeCTL() as any;
    vaultGo(ctl);
    expect(ctl._ask).toHaveBeenCalledOnce();
    const arg = ctl._ask.mock.calls[0][0];
    expect(arg.title).toContain('Deposit into Blend');
    expect(arg.op).toBe('payment');
    expect(typeof arg.run).toBe('function');
  });

  it('rejects when amount exceeds wallet', () => {
    const ctl = makeCTL({ vaultDigits: '9999', wallet: 100 }) as any;
    vaultGo(ctl);
    expect(ctl._ask).not.toHaveBeenCalled();
  });

  it('rejects when amount is 0', () => {
    const ctl = makeCTL({ vaultDigits: '0' }) as any;
    vaultGo(ctl);
    expect(ctl._ask).not.toHaveBeenCalled();
  });
});

describe('vaultOut', () => {
  it('calls ask for withdrawal', () => {
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now() - 3600000, earned: 0 } }
    }) as any;
    vaultOut(ctl, 'blend');
    expect(ctl._ask).toHaveBeenCalledOnce();
    const arg = ctl._ask.mock.calls[0][0];
    expect(arg.title).toContain('Withdraw from Blend');
  });

  it('rejects when position does not exist', () => {
    const ctl = makeCTL() as any;
    vaultOut(ctl, 'blend');
    expect(ctl._ask).not.toHaveBeenCalled();
  });
});

describe('cashOut', () => {
  it('calls ask for cash out', () => {
    const ctl = makeCTL({ wallet: 500 }) as any;
    cashOut(ctl);
    expect(ctl._ask).toHaveBeenCalledOnce();
    const arg = ctl._ask.mock.calls[0][0];
    expect(arg.title).toBe('Send to the anchor');
  });

  it('rejects when wallet is 0', () => {
    const ctl = makeCTL({ wallet: 0 }) as any;
    cashOut(ctl);
    expect(ctl._ask).not.toHaveBeenCalled();
  });
});

describe('earn module exports', () => {
  it('does not export reset', async () => {
    const mod = await import('./earn');
    expect((mod as any).reset).toBeUndefined();
  });
});
