import { describe, it, expect } from 'vitest';
import { disconnect } from './wallet';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  pick:'PH', addr:'', remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  sign:null, signState:'ask',
  wallet:500,
  history:[],
  walletMode:'freighter', pubkey:'GABCDEF', connecting:false
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

describe('disconnect', () => {
  it('resets all wallet state', () => {
    const ctl = makeCTL();
    disconnect(ctl);
    expect(ctl.state.walletMode).toBe('none');
    expect(ctl.state.pubkey).toBeNull();
    expect(ctl.state.wallet).toBe(0);
    expect(ctl.state.connecting).toBe(false);
  });
});
