import { describe, it, expect, vi } from 'vitest';
import { ask, signReject, signGo } from './signing';
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
