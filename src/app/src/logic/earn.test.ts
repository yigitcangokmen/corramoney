import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppState, Ctl } from './types';

const { mockLoadAccount, mockSubmitTransaction, mockSignTransaction } = vi.hoisted(() => ({
  mockLoadAccount: vi.fn(),
  mockSubmitTransaction: vi.fn(),
  mockSignTransaction: vi.fn(),
}));

const storage: Record<string, string> = {};
const mockLocalStorage = {
  getItem: (key: string) => storage[key] ?? null,
  setItem: (key: string, val: string) => { storage[key] = val; },
  removeItem: (key: string) => { delete storage[key]; },
  clear: () => { for (const k in storage) delete storage[k]; },
};
vi.stubGlobal('localStorage', mockLocalStorage);

vi.mock('@stellar/stellar-sdk', () => {
  const Asset = vi.fn().mockImplementation((code: string, issuer: string) => ({ code, issuer }));
  (Asset as any).native = () => ({ code:'XLM', issuer:null });
  const Keypair = { fromSecret: vi.fn().mockReturnValue({ sign: vi.fn() }) };
  const Operation = { payment: vi.fn().mockReturnValue({ type:'payment' }) };
  const mockTx = {
    toXDR: vi.fn().mockReturnValue('mock-xdr'),
    sign: vi.fn(),
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnThis(),
  };
  const TransactionBuilder = vi.fn().mockImplementation(() => mockTx);
  (TransactionBuilder as any).fromXDR = vi.fn().mockReturnValue({ toXDR: () => 'signed-xdr' });
  const Server = vi.fn().mockImplementation(() => ({
    loadAccount: mockLoadAccount,
    submitTransaction: mockSubmitTransaction,
  }));
  return {
    default: { Horizon: { Server }, TransactionBuilder, Operation, Asset, Keypair },
    Horizon: { Server },
    TransactionBuilder,
    Operation,
    Asset,
    Keypair,
  };
});

vi.mock('@stellar/freighter-api', () => ({
  signTransaction: mockSignTransaction,
  isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
  requestAccess: vi.fn().mockResolvedValue({ address: 'GABCDEF' }),
}));

import { vaultGo, vaultOut, cashOut, loadPositions } from './earn';

const INITIAL: AppState = {
  tab:'yield',
  depStep:'form', depDigits:'3500', depProg:0, depRef:8412,
  sendStep:1, sndDigits:'3500', pick:'PH', addr:'',
  elapsed:0, trackProg:0, sndRef:8412, saga:'cfbd94bf', txHash:'', ledger:0,
  pos:{}, vaultDigits:'100', vaultPick:'blend',
  sign:null, signState:'ask',
  wallet:500,
  history:[],
  walletMode:'freighter', pubkey:'GABCDEF', connecting:false
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl {
  const state = { ...INITIAL, ...overrides };
  const log = vi.fn();
  const refreshBalances = vi.fn().mockResolvedValue(undefined);
  return {
    state,
    props: {},
    set: (p: any) => {
      if (typeof p === 'function') {
        const result = p(state);
        if (result) Object.assign(state, result);
      } else if (typeof p === 'object') {
        Object.assign(state, p);
      }
    },
    rate: 18.35, spread: 0.005, minAmt: 200, maxAmt: 60000,
    trk: 0 as any,
    connect: async () => {},
    disconnect: () => {},
    refreshBalances,
    n: (v: number, d: number) => v.toFixed(d),
    pickedVault: () => ({ id:'blend', name:'Blend', apy:5.2, addr:'GAXGTNEY...W2WE', note:'USDC lending pool' }),
    log,
    stamp: () => '01/10 20:00',
    hash: () => 'abc123',
    _log: log,
    _refreshBalances: refreshBalances,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAccount.mockResolvedValue({ balances: [] });
  mockSubmitTransaction.mockResolvedValue({ hash: 'txhash123' });
  mockSignTransaction.mockResolvedValue({ signedTxXdr: 'signed-xdr', error: '' });
  mockLocalStorage.clear();
});

describe('vaultGo', () => {
  it('rejects when amount exceeds wallet', () => {
    const ctl = makeCTL({ vaultDigits: '9999', wallet: 100 });
    vaultGo(ctl);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects when amount is 0', () => {
    const ctl = makeCTL({ vaultDigits: '0' });
    vaultGo(ctl);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('rejects negative amount', () => {
    const ctl = makeCTL({ vaultDigits: '-50' });
    vaultGo(ctl);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('calls Stellar SDK for valid deposit', async () => {
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(mockLoadAccount).toHaveBeenCalled();
    });
  });

  it('calls signTransaction for Freighter approval', async () => {
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(mockSignTransaction).toHaveBeenCalled();
    });
  });

  it('updates position state after successful deposit', async () => {
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(ctl.state.pos.blend).toBeDefined();
      expect(ctl.state.pos.blend.amt).toBe(100);
    });
  });

  it('accumulates on existing position', async () => {
    const ctl = makeCTL({
      vaultDigits: '50', wallet: 500,
      pos: { blend: { amt: 100, at: Date.now(), earned: 0 } }
    });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(ctl.state.pos.blend.amt).toBe(150);
    });
  });

  it('logs completed deposit', async () => {
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 }) as any;
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(ctl._log).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'Vault deposit · Blend', state: 'Completed' })
      );
    });
  });

  it('calls refreshBalances after deposit', async () => {
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 }) as any;
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(ctl._refreshBalances).toHaveBeenCalled();
    });
  });

  it('handles Freighter rejection gracefully', async () => {
    mockSignTransaction.mockResolvedValueOnce({ signedTxXdr: '', error: 'User rejected' });
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(mockSignTransaction).toHaveBeenCalled();
    });
    await new Promise(r => setTimeout(r, 50));
    expect(ctl.state.pos.blend).toBeUndefined();
  });

  it('handles Stellar submission error gracefully', async () => {
    mockSubmitTransaction.mockRejectedValueOnce(new Error('tx failed'));
    const ctl = makeCTL({ vaultDigits: '100', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(mockSubmitTransaction).toHaveBeenCalled();
    });
    await new Promise(r => setTimeout(r, 50));
    expect(ctl.state.pos.blend).toBeUndefined();
  });
});

describe('vaultOut', () => {
  it('does nothing when position does not exist', () => {
    const ctl = makeCTL();
    vaultOut(ctl, 'blend');
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('does nothing when position amount is 0', () => {
    const ctl = makeCTL({ pos: { blend: { amt: 0, at: Date.now(), earned: 0 } } });
    vaultOut(ctl, 'blend');
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('calls Stellar SDK for valid withdrawal', async () => {
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now() - 3600000, earned: 0 } }
    });
    vaultOut(ctl, 'blend');
    await vi.waitFor(() => {
      expect(mockLoadAccount).toHaveBeenCalled();
    });
  });

  it('calls signTransaction for Freighter approval on withdraw', async () => {
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now() - 3600000, earned: 0 } }
    });
    vaultOut(ctl, 'blend');
    await vi.waitFor(() => {
      expect(mockSignTransaction).toHaveBeenCalled();
    });
  });

  it('removes position after successful withdrawal', async () => {
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now() - 3600000, earned: 0 } }
    });
    vaultOut(ctl, 'blend');
    await vi.waitFor(() => {
      expect(ctl.state.pos.blend).toBeUndefined();
    });
  });

  it('logs withdrawal with earned amount', async () => {
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now() - 3600000, earned: 0 } }
    }) as any;
    vaultOut(ctl, 'blend');
    await vi.waitFor(() => {
      expect(ctl._log).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'Vault withdrawal · Blend', state: 'Completed' })
      );
    });
  });
});

describe('cashOut', () => {
  it('rejects when wallet is 0', () => {
    const ctl = makeCTL({ wallet: 0 });
    cashOut(ctl);
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it('calls Stellar SDK for valid cash out', async () => {
    const ctl = makeCTL({ wallet: 500 });
    cashOut(ctl);
    await vi.waitFor(() => {
      expect(mockLoadAccount).toHaveBeenCalled();
    });
  });

  it('calls signTransaction for Freighter approval', async () => {
    const ctl = makeCTL({ wallet: 500 });
    cashOut(ctl);
    await vi.waitFor(() => {
      expect(mockSignTransaction).toHaveBeenCalled();
    });
  });

  it('switches to history tab after cash out', async () => {
    const ctl = makeCTL({ wallet: 500 });
    cashOut(ctl);
    await vi.waitFor(() => {
      expect(ctl.state.tab).toBe('history');
    });
  });

  it('logs MXN withdrawal', async () => {
    const ctl = makeCTL({ wallet: 500 }) as any;
    cashOut(ctl);
    await vi.waitFor(() => {
      expect(ctl._log).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'MXN withdrawal', state: 'Awaiting bank' })
      );
    });
  });
});

describe('loadPositions / savePositions', () => {
  it('returns empty object for unknown pubkey', () => {
    expect(loadPositions('GUNKNOWN')).toEqual({});
  });

  it('round-trips positions through localStorage', async () => {
    const ctl = makeCTL({ vaultDigits: '50', wallet: 500 });
    vaultGo(ctl);
    await vi.waitFor(() => {
      expect(ctl.state.pos.blend).toBeDefined();
    });
    const loaded = loadPositions('GABCDEF');
    expect(loaded.blend).toBeDefined();
    expect(loaded.blend.amt).toBe(50);
  });

  it('clears position from localStorage on withdraw', async () => {
    localStorage.setItem('corra_pos_GABCDEF', JSON.stringify({
      blend: { amt: 100, at: Date.now(), earned: 0 }
    }));
    const ctl = makeCTL({
      pos: { blend: { amt: 100, at: Date.now(), earned: 0 } }
    });
    vaultOut(ctl, 'blend');
    await vi.waitFor(() => {
      expect(ctl.state.pos.blend).toBeUndefined();
    });
    const loaded = loadPositions('GABCDEF');
    expect(loaded.blend).toBeUndefined();
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('corra_pos_GBAD', '{invalid json');
    expect(loadPositions('GBAD')).toEqual({});
  });
});

describe('earn module exports', () => {
  it('does not export reset', async () => {
    const mod = await import('./earn');
    expect((mod as any).reset).toBeUndefined();
  });

  it('exports loadPositions', async () => {
    const mod = await import('./earn');
    expect(typeof mod.loadPositions).toBe('function');
  });
});
