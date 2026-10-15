import { describe, it, expect } from 'vitest';
import { n, amt, usdc, corr } from './helpers';
import type { AppState, Ctl } from './types';

const INITIAL: AppState = {
  tab:'deposit',
  pick:'PH', addr:'', remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  sign:null, signState:'ask',
  wallet:0,
  history:[],
  walletMode:'none', pubkey:null, connecting:false
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl {
  const state = { ...INITIAL, ...overrides };
  return {
    state,
    props: { mxnPerUsd: 18.35, spread: 0.005 },
    set: () => {},
    rate: 18.35,
    spread: 0.005,
    minAmt: 200,
    maxAmt: 60000,
    trk: 0 as any,
    connect: async () => {},
    disconnect: () => {},
    refreshBalances: async () => {},
  } as any;
}

describe('n (number format)', () => {
  it('formats with decimal places', () => {
    const ctl = makeCTL();
    expect(n(ctl, 1234.5, 2)).toBe('1,234.50');
  });

  it('formats zero', () => {
    const ctl = makeCTL();
    expect(n(ctl, 0, 2)).toBe('0.00');
  });
});

describe('amt (amount parser)', () => {
  it('parses destDigits', () => {
    const ctl = makeCTL({ destDigits: '3500' });
    expect(amt(ctl, 'destDigits')).toBe(3500);
  });

  it('returns 0 for empty', () => {
    const ctl = makeCTL({ destDigits: '' });
    expect(amt(ctl, 'destDigits')).toBe(0);
  });

  it('returns 0 for non-numeric', () => {
    const ctl = makeCTL({ destDigits: 'abc' } as any);
    expect(amt(ctl, 'destDigits')).toBe(0);
  });
});

describe('usdc', () => {
  it('converts MXN to USDC at rate', () => {
    const ctl = makeCTL();
    const result = usdc(ctl, 18.35);
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('converts 0', () => {
    const ctl = makeCTL();
    expect(usdc(ctl, 0)).toBe(0);
  });
});

describe('corr', () => {
  it('returns Philippines for PH', () => {
    const ctl = makeCTL({ pick: 'PH' });
    const c = corr(ctl);
    expect(c.cur).toBe('PHP');
    expect(c.name).toBe('Philippines');
  });

  it('returns Brazil for BR', () => {
    const ctl = makeCTL({ pick: 'BR' });
    const c = corr(ctl);
    expect(c.cur).toBe('BRL');
  });

  it('falls back to first corridor for unknown', () => {
    const ctl = makeCTL({ pick: 'XX' });
    const c = corr(ctl);
    expect(c.iso).toBe('PH');
  });
});

