import { describe, it, expect } from 'vitest';
import { disconnect } from './wallet';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  depStep:'form', depDigits:'3500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'3500', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
  pos:{}, vaultDigits:'', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:500,
  history:[],
  walletMode:'demo', pubkey:'GABCDEF', secretKey:'SABCDEF', connecting:false
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
    expect(ctl.state.secretKey).toBeNull();
    expect(ctl.state.wallet).toBe(0);
    expect(ctl.state.connecting).toBe(false);
  });
});
