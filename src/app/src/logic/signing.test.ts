import { describe, it, expect, vi } from 'vitest';
import { ask, signReject, signGo } from './signing';
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
  walletMode:'none', pubkey:null, secretKey:null, connecting:false
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { _patches: any[] } {
  const state = { ...INITIAL, ...overrides };
  const patches: any[] = [];
  return {
    state,
    props: {},
    set: (p: any) => {
      patches.push(p);
      if (typeof p === 'object') Object.assign(state, p);
    },
    rate: 18.35, spread: 0.005, minAmt: 200, maxAmt: 60000,
    trk: 0 as any,
    connect: async () => {},
    disconnect: () => {},
    refreshBalances: async () => {},
    _patches: patches,
  } as any;
}

describe('signing', () => {
  it('ask sets sign state', () => {
    const ctl = makeCTL();
    const sign = { title: 'Test', op: 'payment', dest: 'X', amt: '10', run: () => {} };
    ask(ctl, sign);
    expect(ctl.state.sign).toBe(sign);
    expect(ctl.state.signState).toBe('ask');
  });

  it('signReject clears sign and calls cancel', () => {
    const cancel = vi.fn();
    const sign = { title: 'T', op: 'p', dest: 'X', amt: '10', run: () => {}, cancel };
    const ctl = makeCTL({ sign, signState: 'ask' } as any);
    signReject(ctl);
    expect(ctl.state.sign).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('signGo executes run immediately (no delay)', () => {
    const run = vi.fn();
    const sign = { title: 'T', op: 'p', dest: 'X', amt: '10', run };
    const ctl = makeCTL({ sign, signState: 'ask' } as any);
    signGo(ctl);
    expect(run).toHaveBeenCalledOnce();
    expect(ctl.state.sign).toBeNull();
  });

  it('signGo does nothing if no sign', () => {
    const ctl = makeCTL();
    signGo(ctl);
    expect(ctl._patches).toHaveLength(0);
  });
});
