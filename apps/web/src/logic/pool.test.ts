import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppState, Ctl } from './types';

const fw = vi.hoisted(() => ({
  signTransaction: vi.fn(),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
}));
vi.mock('@stellar/freighter-api', () => fw);

const blend = vi.hoisted(() => ({ readPool: vi.fn(), buildSubmit: vi.fn() }));
vi.mock('./blend', async (orig) => ({ ...(await orig<typeof import('./blend')>()), ...blend }));

const api = vi.hoisted(() => ({ poolSubmit: vi.fn(), accountPoolOps: vi.fn() }));

/** The sender's payment account: the transaction source of its pool moves. */
const PAY = vi.hoisted(() => 'GAOIFT2MYJYEKA7MEEKXHEYCN6KRCFD7USFW5SJVYBAGL6WMHTG4NFEG');
const payAcct = vi.hoisted(() => ({ loadPaymentAccount: vi.fn() }));
vi.mock('./remit', async (orig) => ({ ...(await orig<typeof import('./remit')>()), ...payAcct }));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));
const horizon = vi.hoisted(() => ({ loadAccount: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});

const BLEND = vi.hoisted(() => ({
  plan: 'A', factory: 'CF', backstop: 'CB', oracle: 'CO', pool: 'CPOOL', asset: 'CSAC', assetCode: 'TESTMXN', assetIssuer: 'GI', admin: 'GA',
  deployedAt: '2026-11-24T00:00:00Z',
}));
vi.mock('@corra/shared', async (orig) => ({ ...(await orig<typeof import('@corra/shared')>()), TESTNET_BLEND: BLEND }));

const { TESTNET } = await import('@corra/shared');
const { ApiError } = await import('./api');
const { PoolMissing, PoolSimError } = await import('./blend');
const remit = await import('./remit');
const wallet = await import('./wallet');
const pool = await import('./pool');
const { buildVals } = await import('./vals');

const SENDER = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const OTHER = 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO';
const READ = { status: 2, backstopRate: 0, index: 0, bTokens: 200_000_000n, underlyingRaw: 200_000_000n, supplyApr: 0, utilization: 0, ledger: 9 };
const POSITION = { status: 2, bTokens: 200_000_000n, underlying: '20.0000000', underlyingRaw: 200_000_000n, supplyApr: 0 };
const op = (status: string, extra: object = {}): any => ({
  id: 'pop_1', kind: 'supply', status, txHash: 'ab'.repeat(32), ledger: status === 'SUCCESS' ? 77 : null, resultCode: null,
  amount: { amount: '20.0000000', asset: 'TESTMXN' }, createdAt: 1, ...extra,
});

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { state: AppState } {
  const state: any = {
    tab: 'balance', pick: 'PH', addr: '', remitStep: 'form', destDigits: '1000', quote: null, anchorQuote: null,
    setupDone: true, paymentAccount: PAY, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    sign: null, signState: 'ask', wallet: 50, history: [],
    walletMode: 'freighter', pubkey: SENDER, connecting: false,
    payFrom: 'anchor', walletSpendable: '50.0000000', otherBalances: {}, balanceAt: 1, balanceTriedAt: 1, balanceFails: 0, signedWaiting: false,
    depositStep: 'form', depositAmount: '', deposit: null, depositUrl: null, depositUrlAt: 0, depositBusy: null,
    depositError: null, depositPopupBlocked: false,
    poolRead: 'ready', pool: POSITION, poolReadAt: 1, poolReadError: null, poolAmount: '20', poolStep: 'form', poolBusy: null,
    poolError: null, poolDone: null, phpTrusted: false, phpSpendable: '0', cashOutRead: 'idle', cashOutRows: [], cashOutActive: null, cashOutBusy: null, cashOutError: null, cashOutPopupBlocked: false,
    ...overrides,
  };
  return {
    state,
    set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
    refreshBalances: vi.fn(async () => {}),
  } as any;
}

/** The pool buttons as the card would show them now. */
const buttons = (ctl: Ctl & { state: AppState }) => {
  const v = buildVals({ ...ctl, corr: () => ({ iso: 'PH', name: 'Philippines', cur: 'PHP', sym: '₱', rate: 56 }),
    n: (x: number, d: number) => x.toFixed(d), rate: 18.35 } as any);
  return { poolSupplyOk: v.poolSupplyOk, poolWithdrawOk: v.poolWithdrawOk };
};

beforeEach(() => {
  vi.clearAllMocks();
  remit.cancelRemit();
  pool.cancelPool();
  fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
  fw.getAddress.mockResolvedValue({ address: SENDER });
  fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: SENDER });
  blend.readPool.mockResolvedValue(READ);
  blend.buildSubmit.mockResolvedValue({ xdr: 'UNSIGNED', resourceFee: 720_532n });
  api.poolSubmit.mockResolvedValue(op('SUCCESS'));
  payAcct.loadPaymentAccount.mockResolvedValue({ id: PAY, sequence: '1' });
});

afterEach(() => vi.useRealTimers());

describe('refreshPool', () => {
  it('PW1 reads the position; an answer for a switched account is dropped', async () => {
    const ctl = makeCTL({ poolRead: 'idle', pool: null, poolReadAt: 0 });
    await pool.refreshPool(ctl);
    expect(blend.readPool).toHaveBeenCalledWith(pool.POOL_CFG, SENDER, undefined);
    expect(ctl.state).toMatchObject({ poolRead: 'ready', pool: POSITION, poolReadError: null });
    // the config is cached for a minute
    await pool.refreshPool(ctl);
    expect(blend.readPool).toHaveBeenLastCalledWith(pool.POOL_CFG, SENDER, { config: { status: 2, backstopRate: 0 } });

    const other = makeCTL({ poolRead: 'idle', pool: null, poolReadAt: 0 });
    let release!: (v: unknown) => void;
    blend.readPool.mockReturnValueOnce(new Promise((r) => (release = r)));
    const reading = pool.refreshPool(other);
    other.state.pubkey = OTHER;
    release(READ);
    await reading;
    expect(other.state.pool).toBeNull();
  });

  it('PW2 a pool that is not on this network is unavailable', async () => {
    blend.readPool.mockRejectedValue(new PoolMissing('MissingValue'));
    const ctl = makeCTL({ poolRead: 'idle', pool: null, poolReadAt: 0 });
    await pool.refreshPool(ctl);
    expect(ctl.state).toMatchObject({ poolRead: 'unavailable', pool: null });
  });

  it('PW16 after an error the next read waits 30 s; a known position stays on screen', async () => {
    vi.useFakeTimers();
    blend.readPool.mockRejectedValue(new Error('RPC down'));
    const fresh = makeCTL({ poolRead: 'idle', pool: null, poolReadAt: 0 });
    await pool.refreshPool(fresh);
    expect(fresh.state).toMatchObject({ poolRead: 'error', poolReadError: 'RPC down' });
    await pool.refreshPool(fresh);
    expect(blend.readPool).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    const known = makeCTL();
    await pool.refreshPool(known);
    expect(blend.readPool).toHaveBeenCalledTimes(2);
    expect(known.state).toMatchObject({ poolRead: 'ready', pool: POSITION, poolReadError: 'RPC down' });
  });
});

describe('movePool', () => {
  it('PW3 supply: one prompt, Corra submits with a key, done, balances and position refreshed', async () => {
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(blend.buildSubmit).toHaveBeenCalledWith(pool.POOL_CFG, SENDER, PAY, '1', 'supply', 200_000_000n, expect.any(Number));
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(fw.signTransaction.mock.calls[0][0]).toBe('UNSIGNED');
    expect(api.poolSubmit).toHaveBeenCalledWith('SIGNED', expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(ctl.state).toMatchObject({ poolStep: 'done', poolBusy: null, poolError: null, poolAmount: '',
      poolDone: { kind: 'supply', amount: '20.00', txHash: 'ab'.repeat(32), ledger: 77 } });
    expect(ctl.refreshBalances).toHaveBeenCalled();
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalled());
  });

  it('PW4 an amount that is not valid never reaches Freighter', async () => {
    for (const [kind, poolAmount, msg] of [
      ['supply', 'abc', /above 0/], ['supply', '0', /above 0/], ['supply', '1.12345678', /above 0/], ['supply', 'all', /above 0/],
      ['supply', '50.0000001', /spendable 50.00 TESTMXN/], ['withdraw', '20.0000001', /your 20.00 TESTMXN in the pool/],
      ['supply', '1000001', /1,000,000/],
    ] as const) {
      const ctl = makeCTL({ poolAmount, walletSpendable: kind === 'supply' && poolAmount === '1000001' ? '2000000' : '50.0000000' });
      await pool.movePool(ctl, kind);
      expect(ctl.state.poolError, poolAmount).toMatch(msg);
    }
    const empty = makeCTL({ poolAmount: 'all', pool: { ...POSITION, bTokens: 0n, underlying: '0', underlyingRaw: 0n } });
    await pool.movePool(empty, 'withdraw');
    expect(empty.state.poolError).toBe('Nothing in the pool to take back.');
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(blend.buildSubmit).not.toHaveBeenCalled();
  });

  it('PW5 a simulation refusal is said in plain words and nothing is signed', async () => {
    for (const [code, text] of [
      [1206, 'The pool is not taking deposits right now. Withdrawals always work.'],
      [10, 'Not enough TESTMXN in your account.'],
      ['restore', 'A pool record is archived on testnet. The team restores it; try again later. Nothing was signed.'],
      [1223, 'This asset is switched off in the pool.'],
      ['unknown', 'The pool refused the transaction in simulation: HostError: Error(Budget). Nothing was signed.'],
    ] as const) {
      blend.buildSubmit.mockRejectedValueOnce(new PoolSimError(code, 'HostError: Error(Budget)\nmore lines'));
      const ctl = makeCTL();
      await pool.movePool(ctl, 'supply');
      expect(ctl.state).toMatchObject({ poolStep: 'form', poolBusy: null, poolError: text });
    }
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('PW6 a resource fee above Corra\'s cap stops before the prompt', async () => {
    blend.buildSubmit.mockResolvedValue({ xdr: 'UNSIGNED', resourceFee: 5_000_001n });
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toBe('This transaction needs more network resources than Corra pays for. Nothing was signed.');
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('PW7 a declined prompt shows Freighter\'s words and calls nothing', async () => {
    fw.signTransaction.mockResolvedValue({ error: { code: -4, message: 'The user rejected this request.' } });
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state).toMatchObject({ poolStep: 'form', poolError: 'The user rejected this request.' });
    expect(api.poolSubmit).not.toHaveBeenCalled();
  });

  it('PW8 Corra\'s refusal says what was refused', async () => {
    api.poolSubmit.mockRejectedValue(new ApiError(422, 'REFUSED', 'only supply or withdraw'));
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toBe('Corra refused to pay the fee for this transaction: only supply or withdraw. Nothing was submitted.');
    for (const [e, text] of [
      [new ApiError(429, 'RATE_LIMITED', 'x'), /Too many pool transactions/],
      [new ApiError(409, 'DUPLICATE_TRANSACTION', 'x'), /Corra already has this transaction/],
      [new ApiError(503, 'POOL_NOT_CONFIGURED', 'x', true), /not deployed on this testnet yet/],
    ] as const) {
      api.poolSubmit.mockRejectedValueOnce(e);
      const c = makeCTL();
      await pool.movePool(c, 'supply');
      expect(c.state.poolError).toMatch(text);
    }
  });

  it('PW9 tx_bad_seq rebuilds once with a second prompt; a second failure is said with its code', async () => {
    vi.useFakeTimers();
    api.poolSubmit.mockResolvedValueOnce(op('FAILED', { resultCode: 'tx_bad_seq' }))
      .mockResolvedValueOnce(op('FAILED', { resultCode: 'tx_bad_seq' }));
    const ctl = makeCTL();
    const run = pool.movePool(ctl, 'supply');
    await vi.advanceTimersByTimeAsync(2_000);
    await run;
    expect(blend.buildSubmit).toHaveBeenCalledTimes(2);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
    expect(api.poolSubmit.mock.calls[0][1]).not.toBe(api.poolSubmit.mock.calls[1][1]);
    expect(ctl.state.poolError).toBe('The transaction failed on chain (tx_bad_seq). Nothing moved.');
    api.poolSubmit.mockResolvedValueOnce(op('FAILED', { resultCode: 'tx_too_late' }));
    const late = makeCTL();
    await pool.movePool(late, 'supply');
    expect(late.state.poolError).toBe('The 3-minute signature window passed. Nothing moved; try again.');
    api.poolSubmit.mockResolvedValueOnce(op('FAILED', { resultCode: 'unknown' }));
    const unknown = makeCTL();
    await pool.movePool(unknown, 'supply');
    expect(unknown.state.poolError).toBe('Corra could not find out whether this landed. Check the position.');
    api.poolSubmit.mockResolvedValueOnce(op('FAILED', { resultCode: 'not_found' }));
    const lost = makeCTL();
    await pool.movePool(lost, 'supply');
    expect(lost.state.poolError).toBe('It never reached the network. Nothing moved; try again.');
  });

  it('PW20 a send Corra could not make (502 SEND_FAILED) keeps the signature for a replay with the same key', async () => {
    api.poolSubmit.mockRejectedValueOnce(new ApiError(502, 'SEND_FAILED', 'could not send', true));
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toMatch(/Your signature is kept/);
    await pool.movePool(ctl, 'supply');
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.poolSubmit.mock.calls[1]).toEqual(api.poolSubmit.mock.calls[0]);
    expect(ctl.state.poolStep).toBe('done');
  });

  it('PW10 SUBMITTED polls the account\'s list until the op lands', async () => {
    vi.useFakeTimers();
    api.poolSubmit.mockResolvedValue(op('SUBMITTED'));
    api.accountPoolOps.mockResolvedValueOnce({ ops: [op('SUBMITTED')] }).mockResolvedValueOnce({ ops: [op('SUCCESS')] });
    const ctl = makeCTL();
    const run = pool.movePool(ctl, 'supply');
    await vi.advanceTimersByTimeAsync(6_000);
    await run;
    expect(api.accountPoolOps).toHaveBeenCalledWith(SENDER, 10);
    expect(ctl.state).toMatchObject({ poolStep: 'done', poolDone: { ledger: 77 } });
  });

  it('PW11 a lost answer keeps the signature: the same press replays it with the same key; another amount is told', async () => {
    api.poolSubmit.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toBe('Corra\'s server is not reachable. Your signature is kept: press again to retry it without signing again. Check the position first.');
    const other = makeCTL({ poolAmount: '5' });
    await pool.movePool(other, 'supply');
    expect(other.state.poolError).toBe(pool.KEPT_OTHER);
    await pool.movePool(ctl, 'supply');
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(blend.buildSubmit).toHaveBeenCalledTimes(1);
    expect(api.poolSubmit.mock.calls[1]).toEqual(api.poolSubmit.mock.calls[0]);
    expect(ctl.state.poolStep).toBe('done');
  });

  it('PW17 a lost answer that landed: the same press replays it although the balances moved', async () => {
    // Supply the whole spendable balance; the answer is lost but the transaction lands.
    api.poolSubmit.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL({ poolAmount: '50' });
    await pool.movePool(ctl, 'supply');
    expect(pool.poolRetryPending(ctl.state, 'supply')).toBe(true);
    expect(pool.poolRetryPending({ ...ctl.state, poolAmount: '5' }, 'supply')).toBe(false);
    expect(pool.poolRetryPending(ctl.state, 'withdraw')).toBe(false);
    Object.assign(ctl.state, { walletSpendable: '0.0000000', pool: { ...POSITION, underlyingRaw: 700_000_000n, underlying: '70.0000000' } });
    // The balances say 0 spendable, yet the button for the kept signature stays on.
    expect(buttons(ctl).poolSupplyOk).toBe(true);
    await pool.movePool(ctl, 'supply');
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.poolSubmit.mock.calls[1]).toEqual(api.poolSubmit.mock.calls[0]);
    expect(ctl.state).toMatchObject({ poolStep: 'done', poolError: null, poolDone: { kind: 'supply', amount: '50.00' } });
    expect(pool.poolRetryPending(ctl.state, 'supply')).toBe(false);

    // Take back all; the answer is lost, the position is now 0.
    api.poolSubmit.mockRejectedValueOnce(new ApiError(502, 'BAD_GATEWAY', 'x', true));
    const all = makeCTL({ poolAmount: 'all' });
    await pool.movePool(all, 'withdraw');
    expect(all.state.poolError).toMatch(/Your signature is kept/);
    all.state.pool = { ...POSITION, bTokens: 0n, underlyingRaw: 0n, underlying: '0' };
    expect(buttons(all)).toEqual({ poolSupplyOk: false, poolWithdrawOk: true });
    await pool.movePool(all, 'withdraw');
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
    expect(api.poolSubmit.mock.calls[3]).toEqual(api.poolSubmit.mock.calls[2]);
    expect(all.state).toMatchObject({ poolStep: 'done', poolError: null, poolDone: { kind: 'withdraw', amount: '20.00' } });
  });

  it('PW18 an approval after the signature window is told tx_too_late; a kept blob about to expire claims nothing; neither is sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { SUBMIT_TTL_SEC } = await import('./blend');
    fw.signTransaction.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + (SUBMIT_TTL_SEC + 1) * 1000);
      return { signedTxXdr: 'SIGNED', signerAddress: SENDER };
    });
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(api.poolSubmit).not.toHaveBeenCalled();
    expect(ctl.state).toMatchObject({ poolStep: 'form', poolBusy: null, poolError: pool.poolFailedText('tx_too_late') });
    expect(pool.poolRetryPending(ctl.state, 'supply')).toBe(false);

    // A lost answer keeps the blob; the press comes 3 s before its time bound.
    api.poolSubmit.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const lost = makeCTL();
    await pool.movePool(lost, 'supply');
    expect(api.poolSubmit).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + (SUBMIT_TTL_SEC - 3) * 1000);
    expect(pool.poolRetryPending(lost.state, 'supply')).toBe(true);
    blend.readPool.mockClear();
    await pool.movePool(lost, 'supply');
    expect(api.poolSubmit).toHaveBeenCalledTimes(1);
    // Its first send may have landed: "Nothing moved" could be false, so it says it does not know and reads the position.
    expect(lost.state).toMatchObject({ poolStep: 'form', poolError: pool.POOL_UNKNOWN_TEXT });
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(1));
    expect(pool.poolRetryPending(lost.state, 'supply')).toBe(false);
  });

  it('PW12 take back all asks 1% over the position, rounded up; the pool clamps', async () => {
    const ctl = makeCTL({ poolAmount: 'all', pool: { ...POSITION, underlyingRaw: 200_000_001n, underlying: '20.0000001' } });
    await pool.movePool(ctl, 'withdraw');
    expect(blend.buildSubmit).toHaveBeenCalledWith(pool.POOL_CFG, SENDER, PAY, '1', 'withdraw', 202_000_002n, expect.any(Number));
    expect(ctl.state.poolDone).toMatchObject({ kind: 'withdraw', amount: '20.0000001' });
  });

  it('PW13 off only while the sender\'s payment from the balance is settling (J83)', async () => {
    const ctl = makeCTL({ payment: { senderAccount: SENDER, kind: 'balance', state: 'ONCHAIN' } as any });
    await pool.movePool(ctl, 'supply');
    expect(blend.buildSubmit).not.toHaveBeenCalled();
    expect(pool.poolBlocked({ payment: { senderAccount: SENDER, kind: 'balance', state: 'CASH_IN' } as any, pubkey: SENDER })).toBe(true);
    expect(pool.poolBlocked({ payment: { senderAccount: SENDER, kind: 'balance', state: 'CREDITED' } as any, pubkey: SENDER })).toBe(false);
    expect(pool.poolBlocked({ payment: { senderAccount: OTHER, kind: 'balance', state: 'CASH_IN' } as any, pubkey: SENDER })).toBe(false);
    // A presigned cash_in payment sits at current+SEQ_WINDOW with minAccountSequence=current: a pool move at current+1 leaves it valid.
    for (const state of ['SIGNED', 'CASH_IN'] as const) {
      expect(pool.poolBlocked({ payment: { senderAccount: SENDER, kind: 'cash_in', state } as any, pubkey: SENDER }), state).toBe(false);
    }
    const held = makeCTL({ payment: { senderAccount: SENDER, kind: 'cash_in', state: 'CASH_IN' } as any });
    await pool.movePool(held, 'withdraw');
    expect(blend.buildSubmit).toHaveBeenCalledTimes(1);
    expect(held.state.poolStep).toBe('done');
  });

  it('PW21 the TESTMXN a presigned cash_in payment will spend is held back from a supply', async () => {
    // The anchor credited 10 TESTMXN for the signed payment; the saga has not submitted it yet.
    const payment = { senderAccount: SENDER, kind: 'cash_in', state: 'CASH_IN', quote: { maxSend: { amount: '10.0000000', asset: 'TESTMXN' } } } as any;
    const ctl = makeCTL({ payment, walletSpendable: '50.0000000', poolAmount: '50' });
    expect(pool.poolSupplyMax(ctl.state)).toBe(400_000_000n);
    await pool.movePool(ctl, 'supply');
    expect(blend.buildSubmit).not.toHaveBeenCalled();
    expect(ctl.state.poolError).toBe('That is more than 40.00 TESTMXN: the rest pays for your signed payment.');
    // SIGNED too: the deposit can land before the saga sees it and moves the payment to CASH_IN.
    for (const state of ['SIGNED', 'ONCHAIN', 'CASH_IN'] as const) {
      expect(pool.poolSupplyMax({ ...ctl.state, payment: { ...payment, state } }), state).toBe(400_000_000n);
    }
    for (const p of [{ ...payment, state: 'CREDITED' }, { ...payment, senderAccount: OTHER }, null]) {
      expect(pool.poolSupplyMax({ ...ctl.state, payment: p })).toBe(500_000_000n);
    }
    expect(pool.poolSupplyMax({ ...ctl.state, walletSpendable: '4.0000000' })).toBe(0n);
    ctl.state.poolAmount = '40';
    await pool.movePool(ctl, 'supply');
    expect(blend.buildSubmit).toHaveBeenCalledWith(pool.POOL_CFG, SENDER, PAY, '1', 'supply', 400_000_000n, expect.any(Number));
  });

  it('PW22 a read left behind by a disconnect does not end the reconnected account\'s read', async () => {
    let releaseOld!: (v: unknown) => void;
    let releaseNew!: (v: unknown) => void;
    blend.readPool.mockReturnValueOnce(new Promise((r) => (releaseOld = r)));
    const ctl = makeCTL();
    const old = pool.refreshPool(ctl);
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(1));
    pool.cancelPool();
    blend.readPool.mockReturnValueOnce(new Promise((r) => (releaseNew = r)));
    const fresh = pool.refreshPool(ctl);
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(2));
    releaseOld(READ);
    await old;
    // the new read is still in flight: a tick now waits for it instead of reading in parallel
    await pool.refreshPool(ctl);
    expect(blend.readPool).toHaveBeenCalledTimes(2);
    releaseNew(READ);
    await fresh;
    // the coalesced tick runs once, after the new read ends
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(3));
  });

  it('PW19 a move that lands while a tick read is in flight gets one more read with the new position', async () => {
    let release!: (v: unknown) => void;
    blend.readPool.mockReturnValueOnce(new Promise((r) => (release = r)));
    const ctl = makeCTL();
    const tick = pool.refreshPool(ctl);
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(1));
    blend.readPool.mockResolvedValue({ ...READ, bTokens: 400_000_000n, underlyingRaw: 400_000_000n });
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolStep).toBe('done');
    // the tick read started before the move: its answer is the old position
    release(READ);
    await tick;
    await vi.waitFor(() => expect(blend.readPool).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ctl.state.pool).toMatchObject({ underlyingRaw: 400_000_000n, underlying: '40.0000000' }));
  });

  it('PW14 a disconnect mid-flow stops it and resets the card', async () => {
    let release!: (v: unknown) => void;
    blend.buildSubmit.mockReturnValueOnce(new Promise((r) => (release = r)));
    const ctl = makeCTL();
    const run = pool.movePool(ctl, 'supply');
    await vi.waitFor(() => expect(blend.buildSubmit).toHaveBeenCalled());
    wallet.disconnect(ctl);
    release({ xdr: 'UNSIGNED', resourceFee: 1n });
    await run;
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(ctl.state).toMatchObject({ pubkey: null, poolStep: 'form', poolBusy: null, poolError: null, pool: null });

    // A disconnect while Corra's answer is pending: a lost answer after it keeps no signature for the same account.
    let reject!: (e: unknown) => void;
    api.poolSubmit.mockReturnValueOnce(new Promise((_r, j) => (reject = j)));
    const lost = makeCTL();
    // as in App.tsx: a patch makes a new state object, the snapshot movePool took keeps its values
    lost.set = (p: any) => { lost.state = { ...lost.state, ...(typeof p === 'function' ? p(lost.state) : p) }; };
    const pending = pool.movePool(lost, 'supply');
    await vi.waitFor(() => expect(api.poolSubmit).toHaveBeenCalled());
    wallet.disconnect(lost);
    reject(new ApiError(0, 'UNREACHABLE', 'down', true));
    await pending;
    lost.set({ pubkey: SENDER, setupDone: true, poolAmount: '20' });
    expect(pool.poolRetryPending(lost.state, 'supply')).toBe(false);
  });

  it('PW23 S4-1 a merged payment account (404): the error shows next to "Set up your account", nothing is signed', async () => {
    const real = await vi.importActual<typeof import('./remit')>('./remit');
    payAcct.loadPaymentAccount.mockImplementation(real.loadPaymentAccount);
    horizon.loadAccount.mockRejectedValue(Object.assign(new Error('Not Found'), { response: { status: 404 } }));
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(horizon.loadAccount).toHaveBeenCalledWith(PAY);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(blend.buildSubmit).not.toHaveBeenCalled();
    expect(api.poolSubmit).not.toHaveBeenCalled();
    const v = buildVals({ ...ctl, corr: () => ({ iso: 'PH', name: 'Philippines', cur: 'PHP', sym: '₱', rate: 56 }),
      n: (x: number, d: number) => x.toFixed(d), rate: 18.35 } as any);
    // The pool card is gone with setupDone; the Balance card shows the setup button and the error under it.
    expect(v.poolShown).toBe(false);
    expect(v.balanceState).toBe('setup');
    expect(v.depositErrorText).toBe(pool.POOL_PAYMENT_ACCOUNT_GONE);
    expect(v.depositErrorText).toMatch(/Set up your account.*no Freighter prompt.*Nothing was signed/);
    expect(ctl.state).toMatchObject({ setupDone: false, paymentAccount: null, poolStep: 'form', poolBusy: null });
  });

  it('PW15 Freighter on another network: its message, unchanged, before anything is built', async () => {
    fw.getNetworkDetails.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: 'Public Global Stellar Network ; September 2015' });
    const ctl = makeCTL();
    await pool.movePool(ctl, 'supply');
    expect(ctl.state.poolError).toBe('Switch Freighter to Testnet. It is on PUBLIC now.');
    expect(blend.buildSubmit).not.toHaveBeenCalled();
  });
});
