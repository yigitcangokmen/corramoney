import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppState, Ctl } from './types';

const fw = vi.hoisted(() => ({
  signTransaction: vi.fn(),
  getNetworkDetails: vi.fn(),
  getAddress: vi.fn(),
}));
vi.mock('@stellar/freighter-api', () => fw);

const anchor = vi.hoisted(() => ({
  anchorLogin: vi.fn(),
  startWithdraw: vi.fn(),
  withdrawTransaction: vi.fn(),
}));
vi.mock('./anchor', () => anchor);

const api = vi.hoisted(() => ({
  setup: vi.fn(),
  accountPayments: vi.fn(),
  payment: vi.fn(),
  cashOutSubmit: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));

const horizon = vi.hoisted(() => ({ loadAccount: vi.fn(), submitTransaction: vi.fn(), accounts: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});

const S = await import('@stellar/stellar-sdk');
const { TESTNET } = await import('@corra/shared');
const stellar = await import('@corra/stellar');
const { ApiError } = await import('./api');
const remit = await import('./remit');
const cashout = await import('./cashout');

const PK = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const PAY = 'GAOIFT2MYJYEKA7MEEKXHEYCN6KRCFD7USFW5SJVYBAGL6WMHTG4NFEG';
const ISSUER = TESTNET.corridorIssuer;
const DIST = TESTNET.anchorDistribution;
const MEMO = { type: 'id' as const, value: '881016339300600955' };
const KEY = 'corra_cashout_' + PK;

const paymentAccountRecord = (id: string) => ({
  id, sequence: '77', sponsor: TESTNET.feeSponsor,
  thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
  signers: [{ key: PK, weight: 1, type: 'ed25519_public_key', sponsor: TESTNET.feeSponsor }, { key: id, weight: 0, type: 'ed25519_public_key' }],
  balances: [{ asset_type: 'native', balance: '0.0000000' }],
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
});

/** A payment received by PK, CREDITED, with its cash_out leg (PENDING unless changed). */
function received(over: { leg?: object; asset?: string; events?: any[]; id?: string } = {}): any {
  const asset = over.asset ?? 'TESTPHP';
  return {
    id: over.id ?? 'pmt_1', publicId: 'CORRA-AAAAAA', kind: 'balance', state: 'CREDITED', senderAccount: 'GSENDER', recipientAccount: PK,
    quote: { dest: { amount: '1000.0000000', asset, issuer: ISSUER } }, createdAt: 1_800_000_000_000, updatedAt: 1_800_000_000_000,
    legs: [
      { kind: 'onchain', status: 'CONFIRMED', amount: { amount: '1000.0000000', asset, issuer: ISSUER }, txHash: 'onchain' },
      { kind: 'cash_out', status: 'PENDING', amount: { amount: '1000.0000000', asset, issuer: ISSUER }, anchorId: 'corra-anchor', ...over.leg },
    ],
    ...(over.events ? { events: over.events } : {}),
  };
}

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { state: AppState } {
  const state: any = {
    tab: 'cashout', pick: 'PH', addr: '', remitStep: 'form', destDigits: '1000', quote: null, anchorQuote: null,
    setupDone: false, mxnTrusted: false, paymentAccount: PAY, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    sign: null, signState: 'ask', wallet: 0, history: [], walletMode: 'freighter', pubkey: PK, connecting: false,
    payFrom: 'anchor', walletSpendable: '0', otherBalances: {}, balanceAt: 1, balanceTriedAt: 1, balanceFails: 0, signedWaiting: false,
    depositStep: 'form', depositAmount: '', deposit: null, depositUrl: null, depositUrlAt: 0, depositBusy: null, depositError: null, depositPopupBlocked: false,
    poolRead: 'idle', pool: null, poolReadAt: 0, poolReadError: null, poolAmount: '', poolStep: 'form', poolBusy: null, poolError: null, poolDone: null,
    phpTrusted: true, phpSpendable: '1000.0000000', cashOutRead: 'ready', cashOutRows: [received()], cashOutActive: null, cashOutBusy: null,
    cashOutError: null, cashOutPopupBlocked: false,
    ...overrides,
  };
  return { state, set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p), refreshBalances: vi.fn(async () => {}) } as any;
}

const ready = { status: 'pending_user_transfer_start', amountIn: '1000', anchorAccount: DIST, memo: MEMO, moreInfoUrl: null, stellarTxId: null, message: null };
let store: Record<string, string>;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  remit.cancelRemit();
  cashout.cancelCashOut();
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('window', { open: vi.fn(() => ({})) });
  fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
  fw.getAddress.mockResolvedValue({ address: PK });
  fw.signTransaction.mockImplementation(async (xdr: string) => ({ signedTxXdr: xdr, signerAddress: PK }));
  horizon.loadAccount.mockImplementation(async (id: string) => paymentAccountRecord(id));
  horizon.submitTransaction.mockResolvedValue({ ledger: 5 });
  anchor.startWithdraw.mockResolvedValue({ id: 'w-1', url: 'https://anchor.test/sep24/interactive?token=t' });
  anchor.withdrawTransaction.mockResolvedValue(ready);
  api.cashOutSubmit.mockResolvedValue({ txHash: 'env', ledger: 9, replay: false, payment: received({ leg: { externalRef: 'w-1', txHash: 'inner' } }) });
  api.payment.mockImplementation(async () => received({ leg: { externalRef: 'w-1', txHash: 'inner' } }));
});

afterEach(() => {
  cashout.cancelCashOut();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WC1 cashOutRowOf', () => {
  const row = (p: any, spendable = '1000', active: any = null) => cashout.cashOutRowOf(p, spendable, active);
  it('every state', () => {
    expect(row(received())!.state).toBe('ready');
    expect(row(received(), '999.9999999')!.state).toBe('short');
    for (const step of ['anchor', 'sign', 'submitting', 'onchain'] as const) {
      expect(row(received(), '1000', { paymentId: 'pmt_1', ref: 'w', url: null, urlAt: 0, step })!.state).toBe(step);
    }
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w' } }))!.state).toBe('onchain');
    const done = row(received({ leg: { status: 'CONFIRMED', txHash: 'h', externalRef: 'w' },
      events: [{ type: 'CASHED_OUT', data: { txHash: 'env', moreInfoUrl: 'https://anchor.test/more' } }] }))!;
    expect(done).toMatchObject({ state: 'done', txHash: 'env', moreInfoUrl: 'https://anchor.test/more' });
    expect(row(received({ leg: { status: 'CONFIRMED', externalRef: 'w' }, events: [{ type: 'CASHED_OUT', data: { moreInfoUrl: 'javascript:alert(1)' } }] }))!.moreInfoUrl).toBeNull();
    expect(row(received({ leg: { externalRef: 'w' }, events: [{ type: 'CASH_OUT_SUBMITTED' }, { type: 'CASH_OUT_FAILED' }] }))).toMatchObject({ state: 'failed', reason: cashout.DID_NOT_LAND });
    expect(row(received({ leg: { externalRef: 'w' }, events: [{ type: 'CASH_OUT_SUBMITTED' }, { type: 'CASH_OUT_FAILED' }, { type: 'CASH_OUT_ANCHOR_FAILED' }] })))
      .toMatchObject({ state: 'failed', reason: cashout.ANCHOR_STOPPED });
    expect(row(received({ asset: 'TESTBRL' }))).toMatchObject({ state: 'unsupported', reason: cashout.UNSUPPORTED });
  });
  it('paid then stopped by the anchor, or a mismatch: terminal failed, even with a tx_hash or an active step', () => {
    const sub = { type: 'CASH_OUT_SUBMITTED', data: { ref: 'w', txHash: 'h' } };
    const on = { type: 'CASH_OUT_ONCHAIN', data: { ref: 'w', txHash: 'env-h' } };
    const stopped = row(received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub, on, { type: 'CASH_OUT_ANCHOR_FAILED', data: { ref: 'w', paid: true } }] }))!;
    expect(stopped).toMatchObject({ state: 'failed', terminal: true, reason: cashout.PAID_STOPPED });
    const mismatch = received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub, on, { type: 'CASH_OUT_ANCHOR_COMPLETED' }, { type: 'CASH_OUT_MISMATCH', data: { ref: 'w' } }] });
    expect(row(mismatch)).toMatchObject({ state: 'failed', terminal: true, reason: cashout.PAID_STOPPED });
    expect(row(mismatch, '1000', { paymentId: 'pmt_1', ref: 'w', url: null, urlAt: 0, step: 'onchain' })).toMatchObject({ state: 'failed', terminal: true });
    // The anchor stopping an unpaid withdrawal is not terminal.
    expect(row(received({ leg: { externalRef: 'w' }, events: [{ type: 'CASH_OUT_ANCHOR_FAILED', data: { ref: 'w', paid: false } }] })))
      .toMatchObject({ state: 'failed', terminal: false });
  });
  it('(C2-1) a stop recorded paid: false while the chain lagged, then the leg tx seen ONCHAIN: terminal, and the active cash-out ends', async () => {
    const sub = { type: 'CASH_OUT_SUBMITTED', data: { ref: 'w', txHash: 'h' } };
    const stop = { type: 'CASH_OUT_ANCHOR_FAILED', data: { ref: 'w', anchorStatus: 'error', paid: false } };
    const on = { type: 'CASH_OUT_ONCHAIN', data: { ref: 'w', txHash: 'env-h' } };
    const p = received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub, stop, on] });
    expect(row(p)).toMatchObject({ state: 'failed', terminal: true, reason: cashout.PAID_STOPPED });
    // A stop for an earlier ref, or the leg's tx not seen yet, is not.
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w2' }, events: [stop, { ...sub, data: { ref: 'w2', txHash: 'h' } }, on] })))
      .toMatchObject({ state: 'onchain', terminal: false });
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub, stop] }))).toMatchObject({ state: 'onchain', terminal: false });
    // refreshCashOuts drops the active cash-out on it.
    const ctl = makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w', url: null, urlAt: Date.now(), step: 'onchain', txHash: 'h' } as any });
    store[KEY] = JSON.stringify({ paymentId: 'pmt_1', ref: 'w', url: null, at: Date.now() });
    api.accountPayments.mockResolvedValue({ payments: [received({ leg: { txHash: 'h', externalRef: 'w' } })] });
    api.payment.mockResolvedValue(p);
    await cashout.refreshCashOuts(ctl);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });
  it("a recorded tx says paid only once CASH_OUT_ONCHAIN follows its CASH_OUT_SUBMITTED", () => {
    const sub = (h: string) => ({ type: 'CASH_OUT_SUBMITTED', data: { ref: 'w', txHash: h } });
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub('h')] }))).toMatchObject({ state: 'onchain', paid: false });
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w' } }))).toMatchObject({ state: 'onchain', paid: false });
    expect(row(received({ leg: { txHash: 'h', externalRef: 'w' }, events: [sub('h'), { type: 'CASH_OUT_ONCHAIN', data: { txHash: 'env-h' } }] })))
      .toMatchObject({ state: 'onchain', paid: true });
    // An ONCHAIN of an earlier blob does not count for the current one.
    expect(row(received({ leg: { txHash: 'h2', externalRef: 'w' }, events: [sub('h1'), { type: 'CASH_OUT_ONCHAIN' }, sub('h2')] })))
      .toMatchObject({ state: 'onchain', paid: false });
  });
  it('a Phase 1 mock payout, a leg-less or not CREDITED payment is not listed', () => {
    expect(row(received({ leg: { status: 'CONFIRMED', externalRef: 'mock-payout:CORRA-OLD' } }))).toBeNull();
    const noLeg = received();
    noLeg.legs = noLeg.legs.slice(0, 1);
    expect(row(noLeg)).toBeNull();
    expect(row({ ...received(), state: 'ONCHAIN' })).toBeNull();
  });
});

describe('WC2 startCashOut', () => {
  const NP = TESTNET.networkPassphrase;
  const paymentSetup = (z: string) => stellar.buildPaymentAccountSetup({
    networkPassphrase: NP, sponsor: TESTNET.feeSponsor, sponsorSequence: '10', sender: PK, paymentAccount: z, now: Math.floor(Date.now() / 1000),
  }).toXDR();
  const ownSetup = () => stellar.buildSponsoredSetup({
    networkPassphrase: NP, sponsor: TESTNET.feeSponsor, sponsorSequence: '11', account: PK, accountExists: true,
    trust: [{ code: 'TESTPHP', issuer: ISSUER }], now: Math.floor(Date.now() / 1000),
  }).toXDR();

  it("without a payment account: /setup with ['PHP'] and a throwaway key, no prompt; then startWithdraw; nothing posted to Corra", async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    const ctl = makeCTL({ paymentAccount: null });
    await cashout.startCashOut(ctl, 'pmt_1');
    expect(api.setup.mock.calls[0].slice(0, 2)).toEqual([PK, ['PHP']]);
    expect(S.StrKey.isValidEd25519PublicKey(api.setup.mock.calls[0][2])).toBe(true);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(anchor.startWithdraw).toHaveBeenCalledWith('jwt', PK, '1000.0000000');
    expect(api.cashOutSubmit).not.toHaveBeenCalled();
    expect(ctl.state.cashOutActive).toMatchObject({ paymentId: 'pmt_1', ref: 'w-1', step: 'anchor', url: 'https://anchor.test/sep24/interactive?token=t' });
    expect(JSON.parse(store[KEY])).toMatchObject({ paymentId: 'pmt_1', ref: 'w-1' });
    expect((window.open as any)).not.toHaveBeenCalled();
    await flush();
    expect(ctl.state.cashOutActive?.step).toBe('sign');
    expect(ctl.state.cashOutActive?.memo).toEqual(MEMO);
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('without the TESTPHP line as well: exactly one prompt, for the account\'s own setup', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z), xdr: ownSetup() }));
    const ctl = makeCTL({ paymentAccount: null, phpTrusted: false });
    await cashout.startCashOut(ctl, 'pmt_1');
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(fw.signTransaction.mock.calls[0][0]).toBe(ownSetup());
    expect(anchor.startWithdraw).toHaveBeenCalledTimes(1);
  });

  it('refuses with no prompt when the balance no longer covers the payment, or another cash-out is active', async () => {
    const short = makeCTL({ phpSpendable: '999.9999999' });
    await cashout.startCashOut(short, 'pmt_1');
    expect(short.state.cashOutError).toMatch(/no longer all there/);
    const busy = makeCTL({ cashOutActive: { paymentId: 'other', ref: 'x', url: null, urlAt: 0, step: 'anchor' } });
    await cashout.startCashOut(busy, 'pmt_1');
    expect(api.setup).not.toHaveBeenCalled();
    expect(anchor.startWithdraw).not.toHaveBeenCalled();
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });
});

describe('WC3 waitForAnchor checks what the anchor asks for before any prompt', () => {
  for (const [what, view] of [
    ['another account', { ...ready, anchorAccount: 'GOTHERACCOUNT' }],
    ['another amount', { ...ready, amountIn: '1000.0000001' }],
    ['no memo', { ...ready, memo: null }],
  ] as const) {
    it(what, async () => {
      anchor.withdrawTransaction.mockResolvedValue(view);
      const ctl = makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w-1', url: null, urlAt: Date.now(), step: 'anchor' } });
      await cashout.waitForAnchor(ctl, 'jwt', 'pmt_1', 'w-1');
      expect(ctl.state.cashOutActive).toBeNull();
      expect(ctl.state.cashOutError).toBe(cashout.NOT_EXPECTED);
      expect(ctl.state.cashOutError).toContain('Nothing was signed');
      expect(fw.signTransaction).not.toHaveBeenCalled();
    });
  }
  it('an anchor error stops it with the anchor\'s message', async () => {
    anchor.withdrawTransaction.mockResolvedValue({ ...ready, status: 'error', message: 'compliance' });
    const ctl = makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w-1', url: null, urlAt: Date.now(), step: 'anchor' } });
    await cashout.waitForAnchor(ctl, 'jwt', 'pmt_1', 'w-1');
    expect(ctl.state.cashOutError).toBe(cashout.ANCHOR_STOPPED + ' compliance');
  });
});

const signing = () => makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w-1', url: null, urlAt: Date.now(), step: 'sign', memo: MEMO } });

describe('WC4 signCashOut', () => {
  it('builds tx source = the payment account, op source = the recipient, the memo and the amount; one prompt; posts {ref, signedXdr}', async () => {
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    const xdr = fw.signTransaction.mock.calls[0][0];
    const tx = S.TransactionBuilder.fromXDR(xdr, TESTNET.networkPassphrase) as InstanceType<typeof S.Transaction>;
    expect(tx.source).toBe(PAY);
    expect(tx.sequence).toBe('78');
    expect(tx.fee).toBe('0');
    expect(String(tx.memo.value)).toBe(MEMO.value);
    const op = tx.operations[0] as any;
    expect(op).toMatchObject({ type: 'payment', source: PK, destination: DIST, amount: '1000.0000000' });
    expect(op.asset.getCode()).toBe('TESTPHP');
    expect(api.cashOutSubmit).toHaveBeenCalledWith('pmt_1', { ref: 'w-1', signedXdr: xdr });
    expect(ctl.state.cashOutActive).toMatchObject({ step: 'onchain', txHash: 'env', ledger: 9 });
    expect(ctl.state.cashOutBusy).toBeNull();
  });

  it('does nothing before the anchor is ready (never prompts on its own)', async () => {
    const ctl = makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w-1', url: null, urlAt: Date.now(), step: 'anchor' } });
    await cashout.signCashOut(ctl);
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });
});

describe('WC4b (C5-2) Sign reads the anchor again before any prompt', () => {
  for (const [what, view, text] of [
    ['expired', { ...ready, status: 'expired' }, cashout.ANCHOR_STOPPED],
    ['error', { ...ready, status: 'error', message: 'compliance' }, cashout.ANCHOR_STOPPED + ' compliance'],
    ['another account', { ...ready, anchorAccount: 'GOTHERACCOUNT' }, cashout.NOT_EXPECTED],
    ['another amount', { ...ready, amountIn: '999' }, cashout.NOT_EXPECTED],
    ['another memo', { ...ready, memo: { type: 'id', value: '1' } }, cashout.NOT_EXPECTED],
  ] as const) {
    it(`${what} at the Sign press: no Freighter prompt, no submit, the cash-out ends`, async () => {
      store[KEY] = JSON.stringify({ paymentId: 'pmt_1', ref: 'w-1', url: null, at: Date.now() });
      anchor.withdrawTransaction.mockResolvedValue(view);
      const ctl = signing();
      await cashout.signCashOut(ctl);
      expect(anchor.withdrawTransaction).toHaveBeenCalledWith('jwt', 'w-1');
      expect(fw.signTransaction).not.toHaveBeenCalled();
      expect(api.cashOutSubmit).not.toHaveBeenCalled();
      expect(ctl.state.cashOutActive).toBeNull();
      expect(ctl.state.cashOutError).toBe(text);
      expect(ctl.state.cashOutBusy).toBeNull();
      expect(store[KEY]).toBeUndefined();
    });
  }
  it('the anchor not answering: no prompt, still at sign with an error', async () => {
    anchor.withdrawTransaction.mockRejectedValue(new Error('anchor down'));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(api.cashOutSubmit).not.toHaveBeenCalled();
    expect(ctl.state.cashOutActive?.step).toBe('sign');
    expect(ctl.state.cashOutError).toBeTruthy();
  });
  it('(C6-1) a kept blob after the anchor stopped the withdrawal: read again, no second /submit, the cash-out ends', async () => {
    store[KEY] = JSON.stringify({ paymentId: 'pmt_1', ref: 'w-1', url: null, at: Date.now() });
    api.cashOutSubmit.mockRejectedValueOnce(new ApiError(502, 'SEND_FAILED', 'no answer', true));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(ctl.state.cashOutActive?.step).toBe('sign');
    anchor.withdrawTransaction.mockClear();
    anchor.withdrawTransaction.mockResolvedValue({ ...ready, status: 'expired' });
    await cashout.signCashOut(ctl);
    expect(anchor.withdrawTransaction).toHaveBeenCalledWith('jwt', 'w-1');
    expect(api.cashOutSubmit).toHaveBeenCalledTimes(1);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(ctl.state.cashOutError).toBe(cashout.ANCHOR_STOPPED);
    expect(store[KEY]).toBeUndefined();
  });
  it('(C6-1) a kept blob the anchor already received (pending_anchor): no second /submit, waits for the confirmation', async () => {
    api.cashOutSubmit.mockRejectedValueOnce(new ApiError(502, 'SEND_FAILED', 'no answer', true));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    anchor.withdrawTransaction.mockResolvedValue({ ...ready, status: 'pending_anchor' });
    await cashout.signCashOut(ctl);
    expect(api.cashOutSubmit).toHaveBeenCalledTimes(1);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state.cashOutActive?.step).toBe('onchain');
    expect(ctl.state.cashOutError).toBeNull();
  });
});

describe('WC5 no answer keeps the signed blob', () => {
  for (const e of [new ApiError(0, 'UNREACHABLE', 'down', true), new ApiError(502, 'SEND_FAILED', 'no answer', true), new ApiError(500, 'INTERNAL', 'x', true)]) {
    it(`${e.status} ${e.code}: the next press replays the same blob without a prompt`, async () => {
      api.cashOutSubmit.mockRejectedValueOnce(e);
      const ctl = signing();
      await cashout.signCashOut(ctl);
      expect(ctl.state.cashOutError).toContain('Your signature is kept');
      expect(ctl.state.cashOutActive?.step).toBe('sign');
      await cashout.signCashOut(ctl);
      expect(fw.signTransaction).toHaveBeenCalledTimes(1);
      expect(api.cashOutSubmit).toHaveBeenCalledTimes(2);
      expect(api.cashOutSubmit.mock.calls[1]).toEqual(api.cashOutSubmit.mock.calls[0]);
      expect(ctl.state.cashOutActive?.step).toBe('onchain');
    });
  }
  it('a definite refusal (4xx) drops it: the next press signs a fresh one', async () => {
    api.cashOutSubmit.mockRejectedValueOnce(new ApiError(422, 'UNBOUND_TRANSACTION', "sequence is not the payment account's next"));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(ctl.state.cashOutError).toBe('Your payment account moved on; press again to sign a fresh one. Nothing was sent.');
    await cashout.signCashOut(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
  });
});

describe('WC6 cashOutErrorText', () => {
  const t = (code: string, status = 409, msg = 'm') => cashout.cashOutErrorText(new ApiError(status, code, msg));
  it('per code', () => {
    expect(t('CASH_OUT_IN_PROGRESS')).toBe('Your earlier withdrawal payment may still land. Wait a few minutes, then try again.');
    expect(t('CASH_OUT_ALREADY_PAID')).toBe('The anchor was already paid for this payment; waiting for its confirmation.');
    expect(t('INSUFFICIENT_BALANCE', 422)).toBe('Your TESTPHP balance no longer covers this payment. Nothing was sent.');
    expect(t('CASH_OUT_FAILED', 422, 'the withdrawal payment did not land (op_underfunded); nothing moved, sign again'))
      .toBe('The payment to the anchor did not land (op_underfunded). Nothing moved; press Sign the withdrawal again.');
    expect(t('UNBOUND_TRANSACTION', 422, "sequence is not the payment account's next")).toBe('Your payment account moved on; press again to sign a fresh one. Nothing was sent.');
    expect(t('CASH_OUT_NOT_AVAILABLE', 422)).toBe('Withdrawal is enabled for TESTPHP only on testnet.');
    expect(t('RATE_LIMITED', 429)).toBe('Too many cash-out attempts from this network; wait a few minutes.');
    expect(t('SEND_FAILED', 502)).toBe('Corra did not answer. Your signature is kept; press again to retry it, it will not be signed twice.');
    expect(cashout.cashOutErrorText(new ApiError(0, 'UNREACHABLE', 'x'))).toContain('Your signature is kept');
    expect(cashout.cashOutErrorText(new remit.WalletError('User declined access'))).toBe('User declined access');
  });
});

describe('WC7 resume', () => {
  const remember = (ageMs: number) => { store[KEY] = JSON.stringify({ paymentId: 'pmt_1', ref: 'w-1', url: 'https://anchor.test/p', at: Date.now() - ageMs }); };

  it('within 10 minutes and no tx yet: back to waiting for the anchor; the page link only within 9', async () => {
    api.payment.mockResolvedValue(received({ leg: { externalRef: undefined } }));
    anchor.withdrawTransaction.mockResolvedValue({ ...ready, status: 'incomplete' });
    remember(60_000);
    const a = makeCTL({ cashOutRows: [] });
    await cashout.resumeCashOut(a);
    expect(a.state.cashOutActive).toMatchObject({ paymentId: 'pmt_1', ref: 'w-1', step: 'anchor', url: 'https://anchor.test/p' });
    expect(a.state.cashOutRows.map((r) => r.id)).toEqual(['pmt_1']);
    cashout.cancelCashOut();
    remember(9.5 * 60_000);
    const b = makeCTL({ cashOutRows: [] });
    await cashout.resumeCashOut(b);
    expect(b.state.cashOutActive).toMatchObject({ step: 'anchor', url: null });
  });

  it('a leg with a tx shows onchain; older than 10 minutes, nothing', async () => {
    remember(60_000);
    const a = makeCTL({ cashOutRows: [] });
    await cashout.resumeCashOut(a);
    expect(a.state.cashOutActive).toMatchObject({ step: 'onchain', txHash: 'inner' });
    cashout.cancelCashOut();
    remember(10 * 60_000 + 1000);
    const b = makeCTL({ cashOutRows: [] });
    await cashout.resumeCashOut(b);
    expect(b.state.cashOutActive).toBeNull();
    expect(api.payment).toHaveBeenCalledTimes(1);
  });

  it('(C3-2) resumed onchain, then the reconciler clears the leg (CASH_OUT_FAILED, no tx): the active cash-out ends and the row says it did not land', async () => {
    vi.useFakeTimers();
    remember(60_000);
    const a = makeCTL({ cashOutRows: [] });
    await cashout.resumeCashOut(a);
    expect(a.state.cashOutActive).toMatchObject({ step: 'onchain', txHash: 'inner' });
    api.payment.mockImplementation(async () => received({ leg: { externalRef: 'w-1', txHash: null }, events: [
      { seq: 5, type: 'CASH_OUT_SUBMITTED', data: { ref: 'w-1', txHash: 'inner', maxTime: 1 } },
      { seq: 6, type: 'CASH_OUT_FAILED', data: { ref: 'w-1', txHash: 'inner', reason: 'expired' } },
    ] }));
    await vi.advanceTimersByTimeAsync(3500);
    expect(a.state.cashOutActive).toBeNull();
    expect(store[KEY]).toBeUndefined();
    expect(cashout.cashOutRowOf(a.state.cashOutRows[0], '1000', a.state.cashOutActive)).toMatchObject({ state: 'failed', reason: cashout.DID_NOT_LAND, terminal: false });
  });
});

describe('WC8 the tab never blocks itself', () => {
  const rememberActive = () => { store[KEY] = JSON.stringify({ paymentId: 'pmt_1', ref: 'w-1', url: null, at: Date.now() }); };

  it('the post-submit poll times out: the active cash-out and the remembered entry are dropped; the row falls back to the server state', async () => {
    vi.useFakeTimers();
    rememberActive();
    const ctl = signing();
    ctl.state.cashOutRows = [received(), received({ id: 'pmt_2' })];
    await cashout.signCashOut(ctl);
    expect(ctl.state.cashOutActive?.step).toBe('onchain');
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(store[KEY]).toBeUndefined();
    expect(cashout.cashOutRowOf(ctl.state.cashOutRows.find((r) => r.id === 'pmt_1')!, '1000', null)!.state).toBe('onchain');
  });

  it('CASH_OUT_ALREADY_PAID moves to onchain and polls, never back to sign; the confirmation ends it', async () => {
    vi.useFakeTimers();
    rememberActive();
    api.cashOutSubmit.mockRejectedValueOnce(new ApiError(409, 'CASH_OUT_ALREADY_PAID', 'paid'));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(ctl.state.cashOutActive?.step).toBe('onchain');
    expect(ctl.state.cashOutError).toBeNull();
    api.payment.mockImplementation(async () => received({ leg: { externalRef: 'w-1', txHash: 'inner', status: 'CONFIRMED' } }));
    await vi.advanceTimersByTimeAsync(3500);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });

  it('CASH_OUT_ANCHOR_STOPPED drops the active cash-out and asks for a new one', async () => {
    rememberActive();
    api.cashOutSubmit.mockRejectedValueOnce(new ApiError(409, 'CASH_OUT_ANCHOR_STOPPED', 'stopped'));
    const ctl = signing();
    await cashout.signCashOut(ctl);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(ctl.state.cashOutError).toBe(cashout.STOPPED_START_NEW);
    expect(store[KEY]).toBeUndefined();
  });

  it('(C5-3) more than 10 CONFIRMED rows do not crowd out a paid-and-stopped one: it is read with its events', async () => {
    const confirmed = Array.from({ length: 12 }, (_, i) =>
      ({ ...received({ id: `pmt_c${i}`, leg: { externalRef: `w-c${i}`, txHash: 'h', status: 'CONFIRMED' } }), createdAt: 1_800_000_100_000 + i }));
    const stoppedBare = received({ id: 'pmt_s', leg: { externalRef: 'w', txHash: 'h' } });
    const sub = { type: 'CASH_OUT_SUBMITTED', data: { ref: 'w', txHash: 'h' } };
    const on = { type: 'CASH_OUT_ONCHAIN', data: { ref: 'w', txHash: 'env-h' } };
    const stopped = received({ id: 'pmt_s', leg: { externalRef: 'w', txHash: 'h' },
      events: [sub, on, { type: 'CASH_OUT_ANCHOR_FAILED', data: { ref: 'w', paid: true } }] });
    api.accountPayments.mockResolvedValue({ payments: [...confirmed, stoppedBare] });
    api.payment.mockImplementation(async (id: string) => (id === 'pmt_s' ? stopped : confirmed.find((p) => p.id === id)));
    const ctl = makeCTL();
    await cashout.refreshCashOuts(ctl);
    expect(api.payment).toHaveBeenCalledWith('pmt_s');
    expect(api.payment).toHaveBeenCalledTimes(10);
    const row = cashout.cashOutRowOf(ctl.state.cashOutRows.find((r) => r.id === 'pmt_s')!, '1000', null);
    expect(row).toMatchObject({ state: 'failed', terminal: true, reason: cashout.PAID_STOPPED });
  });

  it('refreshCashOuts drops an active cash-out whose leg is CONFIRMED', async () => {
    rememberActive();
    const confirmed = received({ leg: { externalRef: 'w-1', txHash: 'inner', status: 'CONFIRMED' } });
    api.accountPayments.mockResolvedValue({ payments: [confirmed] });
    api.payment.mockResolvedValue(confirmed);
    const ctl = makeCTL({ cashOutActive: { paymentId: 'pmt_1', ref: 'w-1', url: null, urlAt: Date.now(), step: 'onchain', txHash: 'inner' } });
    await cashout.refreshCashOuts(ctl);
    expect(ctl.state.cashOutActive).toBeNull();
    expect(store[KEY]).toBeUndefined();
  });
});
