import { describe, it, expect, vi } from 'vitest';
import type { AppState, Ctl } from './types';

/** What Horizon's `GET /accounts?signer=` returns. */
const signer = vi.hoisted(() => ({ records: [] as any[] }));
const horizon = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  accounts: vi.fn(() => ({ forSigner: () => ({ limit: () => ({ call: async () => ({ records: signer.records }) }) }) })),
}));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});

const fw = vi.hoisted(() => ({
  isConnected: vi.fn(async () => ({ isConnected: true })),
  requestAccess: vi.fn(async () => ({ address: 'GABCDEF' })),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
  signTransaction: vi.fn(),
}));
vi.mock('@stellar/freighter-api', () => fw);
vi.mock('./anchor', () => ({ anchorLogin: vi.fn(async () => ({ token: 'jwt', exp: Date.now() + 3_600_000 })) }));

const { TESTNET } = await import('@corra/shared');
const { connect, disconnect, refreshBalances } = await import('./wallet');
const { readAccount, readPaymentAccount } = await import('./stellar');
const { buildVals } = await import('./vals');

const PAY = 'GAOIFT2MYJYEKA7MEEKXHEYCN6KRCFD7USFW5SJVYBAGL6WMHTG4NFEG';
/** A payment account of `sender` as Horizon lists it under ?signer=. */
const paymentAccountRecord = (id: string, sender: string, o: object = {}) => ({
  id, sequence: '77', sponsor: TESTNET.feeSponsor,
  thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
  signers: [{ key: sender, weight: 1, type: 'ed25519_public_key', sponsor: TESTNET.feeSponsor }, { key: id, weight: 0, type: 'ed25519_public_key' }],
  balances: [{ asset_type: 'native', balance: '0.0000000' }],
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
  ...o,
});

const INITIAL: AppState = {
  tab:'deposit',
  pick:'PH', addr:'', remitStep:'form', destDigits:'1000', quote:null, anchorQuote:null, setupDone:false, mxnTrusted:false, paymentAccount:null,
  anchorToken:null, anchorTokenExp:0, payment:null, cashInUrl:null,
  remitBusy:null, remitError:null, trackError:null, popupBlocked:false, depositSkipped:false, freighterMissing:false,
  sign:null, signState:'ask',
  wallet:500,
  history:[],
  walletMode:'freighter', pubkey:'GABCDEF', connecting:false,
  payFrom:'anchor', walletSpendable:'0', otherBalances:{}, balanceAt:0, balanceTriedAt:0, balanceFails:0, signedWaiting:false,
  depositStep:'form', depositAmount:'', deposit:null, depositUrl:null, depositUrlAt:0, depositBusy:null,
  depositError:null, depositPopupBlocked:false,
  poolRead:'idle', pool:null, poolReadAt:0, poolReadError:null, poolAmount:'', poolStep:'form', poolBusy:null,
  poolError:null, poolDone:null, phpTrusted:false, phpSpendable:'0', cashOutRead:'idle', cashOutRows:[], cashOutActive:null, cashOutBusy:null, cashOutError:null, cashOutPopupBlocked:false
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

describe('balance state', () => {
  it('WB1 disconnect resets every balance and deposit field', () => {
    const ctl = makeCTL({
      payFrom: 'balance', walletSpendable: '12.5000000', otherBalances: { TESTPHP: '3' }, balanceAt: 123, balanceTriedAt: 100, balanceFails: 0, signedWaiting: true,
      depositStep: 'waiting', depositAmount: '600', deposit: { id: 'dep_1' } as any, depositUrl: 'https://anchor/x', depositUrlAt: 120,
      depositBusy: 'busy', depositError: 'err', depositPopupBlocked: true,
    });
    disconnect(ctl);
    expect(ctl.state).toMatchObject({
      payFrom: 'anchor', walletSpendable: '0', otherBalances: {}, balanceAt: 0, balanceTriedAt: 0, balanceFails: 0, signedWaiting: false,
      depositStep: 'form', depositAmount: '', deposit: null, depositUrl: null, depositUrlAt: 0, depositBusy: null,
      depositError: null, depositPopupBlocked: false,
    });
  });

  it('WB1b disconnect resets every pool field', () => {
    const ctl = makeCTL({
      poolRead: 'ready', pool: { status: 2, bTokens: 1n, underlying: '1', underlyingRaw: 1n, supplyApr: 0 }, poolReadAt: 5,
      poolReadError: 'x', poolAmount: '20', poolStep: 'working', poolBusy: 'busy', poolError: 'err',
      poolDone: { kind: 'supply', amount: '20.00', txHash: 'h', ledger: 1 },
    });
    disconnect(ctl);
    expect(ctl.state).toMatchObject({
      poolRead: 'idle', pool: null, poolReadAt: 0, poolReadError: null, poolAmount: '', poolStep: 'form', poolBusy: null,
      poolError: null, poolDone: null,
    });
  });

  it('WB7 disconnect resets every cash-out field', () => {
    const ctl = makeCTL({
      phpTrusted: true, phpSpendable: '10', cashOutRead: 'ready', cashOutRows: [{ id: 'pmt_1' } as any],
      cashOutActive: { paymentId: 'pmt_1', ref: 'w', url: 'https://a/p', urlAt: 1, step: 'sign' }, cashOutBusy: 'busy', cashOutError: 'err', cashOutPopupBlocked: true,
    });
    disconnect(ctl);
    expect(ctl.state).toMatchObject({
      phpTrusted: false, phpSpendable: '0', cashOutRead: 'idle', cashOutRows: [], cashOutActive: null, cashOutBusy: null, cashOutError: null, cashOutPopupBlocked: false,
    });
  });

  it('(C5-1) disconnect on the Cash out tab: exactly one screen (Send) and one pressed tab', () => {
    const ctl = makeCTL({ tab: 'cashout' });
    disconnect(ctl);
    const v = buildVals({ ...ctl, n: (x: number, d: number) => x.toFixed(d), amt: () => 0, usdc: (x: number) => x,
      corr: () => ({ iso: 'PH', name: 'Philippines', cur: 'PHP', sym: 'P', rate: 56 }) } as any);
    expect([v.isSend, v.isBalance, v.isCashOut, v.isHistory].filter(Boolean).length).toBe(1);
    expect(v.isSend).toBe(true);
    expect(v.tabs.filter((t: any) => t.pressed).length).toBe(1);
  });

  it('WB8 the account read exposes phpTrusted and phpSpendable (Corra issuer, minus selling liabilities); a refresh only raises phpTrusted', async () => {
    const I = TESTNET.corridorIssuer;
    horizon.loadAccount.mockResolvedValueOnce({ balances: [
      { asset_code: 'TESTPHP', asset_issuer: I, balance: '1000.0000000', selling_liabilities: '250.0000000' },
    ] });
    expect(await readAccount('GX')).toMatchObject({ phpTrusted: true, phpSpendable: '750.0000000', others: { TESTPHP: '1000.0000000' } });
    horizon.loadAccount.mockResolvedValueOnce({ balances: [{ asset_code: 'TESTPHP', asset_issuer: 'GFAKEISSUER', balance: '9' }] });
    expect(await readAccount('GX')).toMatchObject({ phpTrusted: false, phpSpendable: '0' });
    // A lagging replica right after the cash-out setup does not lower it.
    const ctl = makeCTL({ phpTrusted: true });
    horizon.loadAccount.mockResolvedValueOnce({ balances: [] });
    await refreshBalances(ctl);
    expect(ctl.state.phpTrusted).toBe(true);
  });

  it('WB2 readAccount: issuer rule, spendable after selling liabilities, 404 and unreachable Horizon', async () => {
    const I = TESTNET.corridorIssuer;
    horizon.loadAccount.mockResolvedValueOnce({ balances: [
      { asset_type: 'native', balance: '5' },
      { asset_code: 'TESTMXN', asset_issuer: I, balance: '400.0000000', selling_liabilities: '100.0000000' },
      { asset_code: 'TESTPHP', asset_issuer: I, balance: '7.5000000' },
      { asset_code: 'TESTBRL', asset_issuer: I, balance: '0.0000000' },
      { asset_code: 'TESTARS', asset_issuer: 'GFAKEISSUER', balance: '999.0000000' },
    ] });
    expect(await readAccount('GX')).toEqual({ exists: true, mxnTrusted: true, testmxn: '400.0000000', spendable: '300.0000000', others: { TESTPHP: '7.5000000' }, paymentAccount: null, phpTrusted: true, phpSpendable: '7.5000000' });

    horizon.loadAccount.mockResolvedValueOnce({ balances: [{ asset_code: 'TESTMXN', asset_issuer: 'GFAKEISSUER', balance: '9' }] });
    expect(await readAccount('GX')).toMatchObject({ exists: true, mxnTrusted: false, spendable: '0' });

    horizon.loadAccount.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    expect(await readAccount('GX')).toEqual({ exists: false, mxnTrusted: false, testmxn: '0', spendable: '0', others: {}, paymentAccount: null, phpTrusted: false, phpSpendable: '0' });

    horizon.loadAccount.mockRejectedValueOnce(Object.assign(new Error('down'), { response: { status: 503 } }));
    expect(await readAccount('GX')).toBeNull();

    // A Horizon blip never zeroes the card.
    horizon.loadAccount.mockRejectedValueOnce(new TypeError('fetch failed'));
    const ctl = makeCTL({ wallet: 500, walletSpendable: '500.0000000', balanceAt: 42, setupDone: true });
    await refreshBalances(ctl);
    expect(ctl.state).toMatchObject({ wallet: 500, walletSpendable: '500.0000000', balanceAt: 42, setupDone: true });

    horizon.loadAccount.mockResolvedValueOnce({ balances: [{ asset_code: 'TESTMXN', asset_issuer: I, balance: '20.0000000' }] });
    await refreshBalances(ctl);
    expect(ctl.state).toMatchObject({ wallet: 20, walletSpendable: '20.0000000', setupDone: true });
    expect(ctl.state.balanceAt).toBeGreaterThan(42);
  });

  it('WB4 a refresh never lowers setupDone: a lagging Horizon read after setup keeps it true', async () => {
    const I = TESTNET.corridorIssuer;
    horizon.loadAccount.mockResolvedValueOnce({ balances: [{ asset_code: 'TESTPHP', asset_issuer: I, balance: '0' }] });
    const ctl = makeCTL({ setupDone: true, paymentAccount: PAY });
    await refreshBalances(ctl);
    expect(ctl.state.setupDone).toBe(true);
    // Nor forgets the payment account just created: ?signer= can lag a ledger behind (S3).
    expect(ctl.state.paymentAccount).toBe(PAY);
    signer.records = [paymentAccountRecord(PAY, 'GABCDEF')];
    horizon.loadAccount.mockResolvedValueOnce({ balances: [{ asset_code: 'TESTMXN', asset_issuer: I, balance: '0' }] });
    const fresh = makeCTL({ setupDone: false });
    await refreshBalances(fresh);
    expect(fresh.state).toMatchObject({ setupDone: true, paymentAccount: PAY });
    signer.records = [];
  });

  it('WB5 setup is done only with the account, its TESTMXN trustline and its payment account', async () => {
    const I = TESTNET.corridorIssuer;
    const trusted = { balances: [{ asset_code: 'TESTMXN', asset_issuer: I, balance: '600.0000000' }] };
    // An existing, trusted, funded account from before the fix (no payment account): not done, so Set up shows.
    horizon.loadAccount.mockResolvedValueOnce(trusted);
    const before = makeCTL({ setupDone: false });
    await refreshBalances(before);
    expect(before.state).toMatchObject({ setupDone: false, mxnTrusted: true, paymentAccount: null, walletSpendable: '600.0000000' });
    // Only an account the sponsor set up, whose only signer is the sender, counts.
    signer.records = [
      paymentAccountRecord('GZZZ', 'GABCDEF', { sponsor: 'GSOMEONEELSE' }),
      paymentAccountRecord('GYYY', 'GABCDEF', { signers: [{ key: 'GABCDEF', weight: 1, type: 'ed25519_public_key' }, { key: 'GYYY', weight: 1, type: 'ed25519_public_key' }] }),
    ];
    horizon.loadAccount.mockResolvedValueOnce(trusted);
    expect((await readAccount('GABCDEF'))?.paymentAccount).toBeNull();
    signer.records = [paymentAccountRecord('GBBB', 'GABCDEF'), paymentAccountRecord(PAY, 'GABCDEF')];
    horizon.loadAccount.mockResolvedValueOnce(trusted);
    expect((await readAccount('GABCDEF'))?.paymentAccount).toBe(PAY < 'GBBB' ? PAY : 'GBBB');
    signer.records = [];
  });

  it('WB6 S1-1 the payment account is found behind 200 look-alikes on page 1 (anyone can add the sender as a signer)', async () => {
    const junk = Array.from({ length: 200 }, (_, i) => paymentAccountRecord('GA' + String(i).padStart(3, '0'), 'GABCDEF', {
      signers: [{ key: 'GABCDEF', weight: 1, type: 'ed25519_public_key' }, { key: 'GJUNK', weight: 0, type: 'ed25519_public_key' }],
    }));
    const next = vi.fn(async () => ({ records: [paymentAccountRecord(PAY, 'GABCDEF')], next: async () => ({ records: [] }) }));
    horizon.accounts.mockReturnValueOnce({ forSigner: () => ({ limit: () => ({ call: async () => ({ records: junk, next }) }) }) });
    expect(await readPaymentAccount('GABCDEF')).toEqual({ id: PAY, sequence: '77' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('WB-U6-1 three unanswered refreshes count 3; an answer resets the count to 0', async () => {
    horizon.loadAccount.mockRejectedValue(new TypeError('fetch failed'));
    const ctl = makeCTL({ balanceAt: 42, balanceFails: 0 });
    for (let i = 1; i <= 3; i++) {
      await refreshBalances(ctl);
      expect(ctl.state.balanceFails).toBe(i);
    }
    horizon.loadAccount.mockReset();
    horizon.loadAccount.mockResolvedValueOnce({ balances: [] });
    await refreshBalances(ctl);
    expect(ctl.state.balanceFails).toBe(0);
  });

  it('WB-U6-2 disconnect resets the failure count', () => {
    const ctl = makeCTL({ balanceFails: 5 });
    disconnect(ctl);
    expect(ctl.state.balanceFails).toBe(0);
  });

  it('SA-U6-1 a known payment account that still is one is read directly, without the ?signer= listing', async () => {
    horizon.loadAccount.mockReset();
    horizon.accounts.mockClear();
    horizon.loadAccount.mockResolvedValueOnce(paymentAccountRecord(PAY, 'GABCDEF', { sequence: '91' }));
    expect(await readPaymentAccount('GABCDEF', PAY)).toEqual({ id: PAY, sequence: '91' });
    expect(horizon.loadAccount).toHaveBeenCalledWith(PAY);
    expect(horizon.accounts).not.toHaveBeenCalled();
  });

  it('SA-U6-2 a known account that was reshaped falls back to the listing', async () => {
    horizon.loadAccount.mockReset();
    horizon.accounts.mockClear();
    horizon.loadAccount.mockResolvedValueOnce(paymentAccountRecord(PAY, 'GABCDEF', { sponsor: 'GSOMEONEELSE' }));
    signer.records = [paymentAccountRecord('GBBB', 'GABCDEF')];
    expect(await readPaymentAccount('GABCDEF', PAY)).toEqual({ id: 'GBBB', sequence: '77' });
    expect(horizon.accounts).toHaveBeenCalledTimes(1);
    signer.records = [];
  });

  it('SA-U6-3 a known account that is gone (404) falls back to the listing', async () => {
    horizon.loadAccount.mockReset();
    horizon.accounts.mockClear();
    horizon.loadAccount.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    signer.records = [];
    expect(await readPaymentAccount('GABCDEF', PAY)).toBeNull();
    expect(horizon.accounts).toHaveBeenCalledTimes(1);
  });

  it('WB3 connect records when the first read was tried, even when Horizon does not answer', async () => {
    fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
    horizon.loadAccount.mockRejectedValue(new TypeError('fetch failed'));
    const ctl = makeCTL({ walletMode: 'none', pubkey: null, connecting: false });
    const before = Date.now();
    await connect(ctl);
    expect(ctl.state.walletMode).toBe('freighter');
    expect(ctl.state.balanceAt).toBe(0);
    expect(ctl.state.balanceTriedAt).toBeGreaterThanOrEqual(before);
    expect(ctl.state.balanceFails).toBe(1);
    horizon.loadAccount.mockReset();
  });
});
