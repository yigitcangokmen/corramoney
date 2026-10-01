import { describe, it, expect } from 'vitest';
import { earnedOf, n, amt, usdc, corr, totalVault, totalEarned } from './helpers';
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

describe('earnedOf', () => {
  it('calculates yield over time', () => {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const result = earnedOf({ amt: 1000, at: oneHourAgo, earned: 0 }, 5.2);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it('returns 0 for zero amount', () => {
    const result = earnedOf({ amt: 0, at: Date.now() - 3600000, earned: 0 }, 5.2);
    expect(result).toBe(0);
  });
});

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
  it('parses depDigits', () => {
    const ctl = makeCTL({ depDigits: '3500' });
    expect(amt(ctl, 'depDigits')).toBe(3500);
  });

  it('returns 0 for empty', () => {
    const ctl = makeCTL({ depDigits: '' });
    expect(amt(ctl, 'depDigits')).toBe(0);
  });

  it('returns 0 for non-numeric', () => {
    const ctl = makeCTL({ depDigits: 'abc' } as any);
    expect(amt(ctl, 'depDigits')).toBe(0);
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

describe('totalVault', () => {
  it('returns 0 with no positions', () => {
    const ctl = makeCTL();
    expect(totalVault(ctl)).toBe(0);
  });

  it('sums all position amounts', () => {
    const ctl = makeCTL({
      pos: {
        blend: { amt: 100, at: Date.now(), earned: 0 },
        defindex: { amt: 200, at: Date.now(), earned: 0 }
      }
    });
    expect(totalVault(ctl)).toBe(300);
  });
});

describe('totalEarned', () => {
  it('returns 0 with no positions', () => {
    const ctl = makeCTL();
    expect(totalEarned(ctl)).toBe(0);
  });

  it('accumulates earnings across positions', () => {
    const ctl = makeCTL({
      pos: {
        blend: { amt: 1000, at: Date.now() - 3600000, earned: 0 }
      }
    });
    expect(totalEarned(ctl)).toBeGreaterThan(0);
  });
});
