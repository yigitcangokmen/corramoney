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
  firmQuote: vi.fn(),
  startDeposit: vi.fn(),
}));
vi.mock('./anchor', () => anchor);

const api = vi.hoisted(() => ({
  quote: vi.fn(),
  confirm: vi.fn(),
  resign: vi.fn(),
  linkCashIn: vi.fn(),
  payment: vi.fn(),
  setup: vi.fn(),
  watch: vi.fn(),
  send: vi.fn(),
  accountPayments: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));

/** What Horizon's `GET /accounts?signer=` returns. */
const signer = vi.hoisted(() => ({ records: [] as any[] }));
const horizon = vi.hoisted(() => ({ loadAccount: vi.fn(), submitTransaction: vi.fn(), accounts: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});
const build = vi.hoisted(() => ({ buildStrictReceive: vi.fn((_p: any) => ({ toXDR: () => 'UNSIGNED' })) }));
vi.mock('@corra/stellar', async (orig) => ({ ...(await orig<typeof import('@corra/stellar')>()), ...build }));

const { TESTNET } = await import('@corra/shared');
const { ApiError } = await import('./api');
const remit = await import('./remit');

const SENDER = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
/** The sender's payment account. */
const PAY = 'GAOIFT2MYJYEKA7MEEKXHEYCN6KRCFD7USFW5SJVYBAGL6WMHTG4NFEG';
const RECIPIENT = 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO';
/** A payment account of SENDER as Horizon lists it under ?signer=. */
const paymentAccountRecord = (id: string) => ({
  id, sequence: '77', sponsor: TESTNET.feeSponsor,
  thresholds: { low_threshold: 1, med_threshold: 1, high_threshold: 1 },
  signers: [{ key: SENDER, weight: 1, type: 'ed25519_public_key', sponsor: TESTNET.feeSponsor }, { key: id, weight: 0, type: 'ed25519_public_key' }],
  balances: [{ asset_type: 'native', balance: '0.0000000' }],
  flags: { auth_required: false, auth_revocable: false, auth_immutable: false, auth_clawback_enabled: false },
});

const QUOTE: any = {
  id: 'qt_1', mode: 'strict_receive', corridor: { from: 'MX/MXN', to: 'PH/PHP' },
  source: { amount: '329.3190139', asset: 'TESTMXN' }, dest: { amount: '1000.0000000', asset: 'TESTPHP' },
  maxSend: { amount: '334.2587992', asset: 'TESTMXN' }, path: [], slippageBps: 150,
  expiresAt: Date.now() + 120_000,
};
const PAYMENT: any = { id: 'pmt_1', publicId: 'CORRA-1', kind: 'cash_in', state: 'SIGNED', senderAccount: SENDER, recipientAccount: RECIPIENT, quote: QUOTE, legs: [] };

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { state: AppState } {
  const state: any = {
    tab: 'send', pick: 'PH', addr: RECIPIENT, remitStep: 'review', destDigits: '1000', quote: QUOTE,
    anchorQuote: { id: 'aq_old', expiresAt: Date.now() + 600_000, price: '1', sellAmount: '334.26', sellAsset: 'iso4217:MXN' },
    setupDone: true, paymentAccount: PAY, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    sign: null, signState: 'ask', wallet: 0, history: [],
    walletMode: 'freighter', pubkey: SENDER, connecting: false,
    payFrom: 'anchor', walletSpendable: '0', otherBalances: {}, balanceAt: 0, signedWaiting: false,
    depositStep: 'form', depositAmount: '', deposit: null, depositUrl: null, depositBusy: null,
    depositError: null, depositPopupBlocked: false,
    poolRead: 'idle', pool: null, poolReadAt: 0, poolReadError: null, poolAmount: '', poolStep: 'form', poolBusy: null,
    poolError: null, poolDone: null, phpTrusted: false, phpSpendable: '0', cashOutRead: 'idle', cashOutRows: [], cashOutActive: null, cashOutBusy: null, cashOutError: null, cashOutPopupBlocked: false,
    ...overrides,
  };
  return {
    state,
    set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
    refreshBalances: vi.fn(async () => {}),
  } as any;
}

let stopWatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  remit.cancelRemit();
  fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
  fw.getAddress.mockResolvedValue({ address: SENDER });
  fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: SENDER });
  signer.records = [];
  horizon.submitTransaction.mockResolvedValue({ ledger: 5 });
  horizon.accounts.mockReturnValue({ forSigner: () => ({ limit: () => ({ call: async () => ({ records: signer.records }) }) }) });
  horizon.loadAccount.mockImplementation(async (id: string) => id === PAY ? paymentAccountRecord(PAY) : {
    sequence: '1',
    balances: ['TESTMXN', 'TESTPHP'].map((c) => ({ asset_code: c, asset_issuer: TESTNET.corridorIssuer, balance: '0' })),
  });
  api.confirm.mockResolvedValue(PAYMENT);
  api.resign.mockResolvedValue({ ...PAYMENT, id: 'pmt_2' });
  api.linkCashIn.mockResolvedValue({});
  api.accountPayments.mockResolvedValue({ payments: [] });
  api.send.mockResolvedValue({ ...PAYMENT, id: 'pmt_b', kind: 'balance', state: 'CASH_IN' });
  stopWatch = vi.fn();
  api.watch.mockReturnValue(stopWatch);
  anchor.startDeposit.mockResolvedValue({ id: 'dep_1', url: 'https://anchor/dep_1' });
  anchor.firmQuote.mockResolvedValue({ id: 'aq_new', expiresAt: Date.now() + 600_000, price: '1', sellAmount: '334.26', sellAsset: 'iso4217:MXN' });
});

describe('signAndSend', () => {
  it('refreshes an anchor quote that expires within a minute and confirms with the new one', async () => {
    const ctl = makeCTL({ anchorQuote: { id: 'aq_old', expiresAt: Date.now() + 20_000, price: '1', sellAmount: '334.26', sellAsset: 'x' } });
    await remit.signAndSend(ctl);
    expect(anchor.firmQuote).toHaveBeenCalledWith('jwt', '334.2600000');
    expect(api.confirm.mock.calls[0][0].anchorQuote.id).toBe('aq_new');
    expect(anchor.startDeposit.mock.calls[0][4]).toBe(QUOTE.anchorQuoteId);
  });

  it('refreshes the Corra quote when it expires within 10 s', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_2' });
    const ctl = makeCTL({ quote: { ...QUOTE, expiresAt: Date.now() + 5_000 } });
    await remit.signAndSend(ctl);
    expect(api.quote).toHaveBeenCalled();
    expect(api.confirm.mock.calls[0][0].quoteId).toBe('qt_2');
  });

  it('lands on the cash-in step with a retry when the deposit fails after confirm', async () => {
    anchor.startDeposit.mockRejectedValue(new Error('anchor is down'));
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.remitStep).toBe('cashin');
    expect(ctl.state.payment?.id).toBe('pmt_1');
    expect(ctl.state.remitError).toBe('The payment is signed and held, but the deposit did not start: anchor is down');
    expect(api.watch).toHaveBeenCalledWith('pmt_1', expect.any(Function), expect.any(Function));

    // The retry starts the deposit for the same payment instead of signing a second one.
    anchor.startDeposit.mockResolvedValue({ id: 'dep_2', url: 'https://anchor/dep_2' });
    await remit.restartDeposit(ctl);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(ctl.state.cashInUrl).toBe('https://anchor/dep_2');
    expect(ctl.state.remitError).toBeNull();
  });

  it('keeps going when the deposit ref was already linked', async () => {
    api.linkCashIn.mockRejectedValue(new ApiError(409, 'CASH_IN_ALREADY_LINKED', 'already linked'));
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.cashInUrl).toBe('https://anchor/dep_1');
    expect(ctl.state.remitError).toBeNull();
  });

  it('shows the message of a Freighter error object, not [object Object]', async () => {
    fw.signTransaction.mockResolvedValue({ signedTxXdr: '', error: { code: -4, message: 'User declined access' } });
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('User declined access');
    expect(ctl.state.remitStep).toBe('review');
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it('passes the connected address to Freighter and refuses a different signer', async () => {
    fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: RECIPIENT });
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(fw.signTransaction.mock.calls[0][1]).toMatchObject({ address: SENDER, networkPassphrase: TESTNET.networkPassphrase });
    expect(ctl.state.remitError).toBe(remit.ACCOUNT_SWITCHED);
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it('refuses when Freighter is on another network', async () => {
    fw.getNetworkDetails.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: 'Public Global Stellar Network ; September 2015' });
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Switch Freighter to Testnet. It is on PUBLIC now.');
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('refuses when Freighter switched accounts since connect', async () => {
    fw.getAddress.mockResolvedValue({ address: RECIPIENT });
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe(remit.ACCOUNT_SWITCHED);
  });
});

describe('disconnect', () => {
  it('stops the watcher', async () => {
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(stopWatch).not.toHaveBeenCalled();
    remit.cancelRemit();
    expect(stopWatch).toHaveBeenCalledTimes(1);
  });

  it('aborts a flow in flight: nothing it does afterwards reaches the screen', async () => {
    let release!: (p: any) => void;
    api.confirm.mockReturnValue(new Promise((r) => (release = r)));
    const ctl = makeCTL();
    const run = remit.signAndSend(ctl);
    await vi.waitFor(() => expect(api.confirm).toHaveBeenCalled());
    remit.cancelRemit();
    release(PAYMENT);
    await run;
    expect(ctl.state.payment).toBeNull();
    expect(ctl.state.remitStep).toBe('review');
    expect(api.watch).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
  });
});

describe('getQuote', () => {
  it('does not ask for a quote for an invalid amount', async () => {
    for (const d of ['0', '0.001', '1.234', '1..2', '']) {
      await remit.getQuote(makeCTL({ destDigits: d, remitStep: 'form' }));
    }
    expect(api.quote).not.toHaveBeenCalled();
  });

  it('sends the amount exactly as typed, without rounding', async () => {
    api.quote.mockResolvedValue(QUOTE);
    const ctl = makeCTL({ destDigits: '12.5', remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(api.quote.mock.calls[0][1].amount).toBe('12.5');
    expect(ctl.state.remitStep).toBe('review');
  });

  it('stops before any wallet prompt when the recipient cannot receive the asset', async () => {
    api.quote.mockResolvedValue(QUOTE);
    horizon.loadAccount.mockImplementation(async (id: string) => id === RECIPIENT
      ? { sequence: '1', balances: [] }
      : { sequence: '1', balances: [{ asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer, balance: '0' }] });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('form');
    expect(ctl.state.remitError).toMatch(/cannot receive TESTPHP/);
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('does not block the quote when Horizon cannot be reached for the recipient check', async () => {
    api.quote.mockResolvedValue(QUOTE);
    horizon.loadAccount.mockRejectedValue(Object.assign(new Error('down'), { response: { status: 503 } }));
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('review');
  });

  it('continues without an anchor quote when the anchor cannot quote', async () => {
    api.quote.mockResolvedValue(QUOTE);
    anchor.firmQuote.mockRejectedValue(new Error('no quote'));
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.anchorQuote).toBeNull();
    expect(ctl.state.remitStep).toBe('review');
  });
});

describe('resend', () => {
  const expired = (cashIn: 'CONFIRMED' | 'FAILED'): any =>
    ({ ...PAYMENT, state: 'EXPIRED', legs: [{ kind: 'cash_in', status: cashIn }], events: [] });

  it('skips a second deposit when the old cash-in landed and the wallet covers the new cap', async () => {
    api.quote.mockResolvedValue(QUOTE);
    const ctl = makeCTL({ payment: expired('CONFIRMED'), wallet: 400, remitStep: 'track' });
    await remit.resend(ctl);
    expect(api.resign.mock.calls[0][0].supersedesId).toBe('pmt_1');
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(ctl.state.depositSkipped).toBe(true);
    expect(ctl.state.payment?.id).toBe('pmt_2');
  });

  it('asks for a new deposit when the wallet does not cover the new cap', async () => {
    api.quote.mockResolvedValue(QUOTE);
    const ctl = makeCTL({ payment: expired('CONFIRMED'), wallet: 100, remitStep: 'track' });
    await remit.resend(ctl);
    expect(anchor.startDeposit).toHaveBeenCalled();
    expect(ctl.state.depositSkipped).toBe(false);
  });
});

describe('received payments', () => {
  const FROM_OTHER = { pubkey: RECIPIENT, remitStep: 'track' as const };
  beforeEach(() => {
    // Freighter is on the recipient's account, so nothing but the sender check stops the flow.
    fw.getAddress.mockResolvedValue({ address: RECIPIENT });
    fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: RECIPIENT });
    api.quote.mockResolvedValue(QUOTE);
  });

  it('RR1 resend on a received payment makes no Freighter or api call', async () => {
    for (const kind of ['cash_in', 'balance']) {
      const ctl = makeCTL({ ...FROM_OTHER, payment: { ...PAYMENT, kind, state: 'FAILED', events: [] } });
      await remit.resend(ctl);
      expect(fw.getNetworkDetails, kind).not.toHaveBeenCalled();
      expect(fw.signTransaction, kind).not.toHaveBeenCalled();
      expect(api.resign, kind).not.toHaveBeenCalled();
      expect(ctl.refreshBalances, kind).not.toHaveBeenCalled();
    }
  });

  it('RR2 a received SIGNED payment never starts a deposit or takes its cash-in ref', async () => {
    const ctl = makeCTL({ ...FROM_OTHER, payment: { ...PAYMENT, events: [] } });
    await remit.restartDeposit(ctl);
    expect(anchor.anchorLogin).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(api.linkCashIn).not.toHaveBeenCalled();
  });
});

describe('tracking', () => {
  it('reports why live tracking stopped', () => {
    const ctl = makeCTL();
    remit.track(ctl, 'pmt_gone');
    const onError = api.watch.mock.calls[0][2];
    onError(new ApiError(404, 'PAYMENT_NOT_FOUND', 'payment not found'));
    expect(ctl.state.trackError).toBe('payment not found (PAYMENT_NOT_FOUND)');
  });

  it('falls back to a link when the browser blocks the deposit popup', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) });
    const ctl = makeCTL({ cashInUrl: 'https://anchor/dep_1' });
    remit.openDepositWindow(ctl);
    expect(ctl.state.popupBlocked).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('freighterMessage', () => {
  it('reads both error shapes', () => {
    expect(remit.freighterMessage({ code: -1, message: 'nope' })).toBe('nope');
    expect(remit.freighterMessage('old string error')).toBe('old string error');
    expect(remit.freighterMessage({})).toBe('Freighter returned an error');
  });
});

describe('audit follow-ups', () => {
  it('refuses, before any wallet prompt, a payment whose deposit is above the anchor limit', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, maxSend: { amount: '1000000.0100000', asset: 'TESTMXN' } });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('form');
    expect(ctl.state.remitError).toMatch(/at most 1,000,000 MXN/);
    expect(fw.signTransaction).not.toHaveBeenCalled();
  });

  it('a retry after an unanswered /confirm reuses the signature and the idempotency key', async () => {
    api.confirm.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toMatch(/down/);
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.confirm).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[1][1]).toBe(api.confirm.mock.calls[0][1]);
    expect(api.confirm.mock.calls[1][0].signedXdr).toBe('SIGNED');
    expect(ctl.state.remitStep).toBe('cashin');
  });

  it('a /confirm the server refused is not retried with the same signature', async () => {
    api.confirm.mockRejectedValueOnce(new ApiError(409, 'QUOTE_USED', 'used'));
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[1][1]).not.toBe(api.confirm.mock.calls[0][1]);
  });

  it('counts a TEST token only when Corra issued it', async () => {
    const { readAccount } = await import('./stellar');
    horizon.loadAccount.mockResolvedValue({ balances: [
      { asset_type: 'native', balance: '1' },
      { asset_type: 'credit_alphanum12', asset_code: 'TESTMXN', asset_issuer: 'GFAKEISSUER', balance: '999' },
    ] });
    expect((await readAccount(SENDER))?.testmxn).toBe('0');
    expect((await readAccount(SENDER))?.mxnTrusted).toBe(false);
    horizon.loadAccount.mockResolvedValue({ balances: [
      { asset_type: 'credit_alphanum12', asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer, balance: '5' },
    ] });
    expect((await readAccount(SENDER))?.testmxn).toBe('5');
  });
});

describe('double-check follow-ups', () => {
  const unreachable = () => new ApiError(0, 'UNREACHABLE', 'down', true);

  it('blocks a recipient account that does not exist (Horizon 404) before any prompt', async () => {
    api.quote.mockResolvedValue(QUOTE);
    horizon.loadAccount.mockImplementation(async (id: string) => {
      if (id === RECIPIENT) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return { sequence: '1', balances: [{ asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer, balance: '0' }] };
    });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitError).toMatch(/cannot receive TESTPHP/);
  });

  it('allows a deposit of exactly the anchor limit', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, maxSend: { amount: '1000000.0000000', asset: 'TESTMXN' } });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('review');
  });

  it('refuses before the prompt when a quote refreshed at signing goes over the anchor limit', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_big', maxSend: { amount: '1000000.0100000', asset: 'TESTMXN' } });
    const ctl = makeCTL({ quote: { ...QUOTE, expiresAt: Date.now() + 1_000 } });
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toMatch(/at most 1,000,000 MXN/);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
  });

  it('a 5xx keeps the signature for the retry, even once the quote has expired', async () => {
    api.confirm.mockRejectedValueOnce(new ApiError(502, 'HTTP_502', 'bad gateway'));
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    ctl.state.quote = { ...QUOTE, expiresAt: Date.now() - 1 }; // the server replays a known key regardless
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.confirm.mock.calls[1][1]).toBe(api.confirm.mock.calls[0][1]);
  });

  it('signs again when the recipient or the quote changed since the unanswered confirm', async () => {
    api.confirm.mockRejectedValueOnce(unreachable());
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    ctl.state.quote = { ...QUOTE, id: 'qt_other' };
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[1][1]).not.toBe(api.confirm.mock.calls[0][1]);
  });

  it('disconnecting drops the saved signature', async () => {
    api.confirm.mockRejectedValueOnce(unreachable());
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    remit.cancelRemit();
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
  });
});


describe('pay from balance', () => {
  const ON_BALANCE = { payFrom: 'balance' as const, walletSpendable: '400.0000000' };
  const senderHolds = (balance: string, selling = '0') => horizon.loadAccount.mockImplementation(async (id: string) => id === SENDER
    ? { sequence: '1', balances: [{ asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer, balance, selling_liabilities: selling }] }
    : id === PAY ? paymentAccountRecord(PAY)
    : { sequence: '1', balances: [{ asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer, balance: '0' }] });

  it('RB1 defaults to the balance only when the spendable balance covers the cap exactly', async () => {
    api.quote.mockResolvedValue(QUOTE);
    for (const [bal, selling, want] of [
      ['334.2587992', '0', 'balance'], ['334.2587991', '0', 'anchor'], ['400.0000000', '100.0000000', 'anchor'],
    ]) {
      senderHolds(bal, selling);
      const ctl = makeCTL({ remitStep: 'form' });
      await remit.getQuote(ctl);
      expect(ctl.state.payFrom, bal + '/' + selling).toBe(want);
      expect(ctl.state.remitStep).toBe('review');
    }
  });

  it('RB2 signs once in balance mode and hands the blob to /send, with no login, setup or deposit', async () => {
    const ctl = makeCTL({ ...ON_BALANCE, anchorToken: null, anchorTokenExp: 0 });
    await remit.signAndSend(ctl);
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'balance', sender: SENDER, recipient: RECIPIENT });
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(anchor.anchorLogin).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(api.setup).not.toHaveBeenCalled();
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.send.mock.calls[0][0]).toEqual({ quoteId: 'qt_1', sender: SENDER, recipient: RECIPIENT, signedXdr: 'SIGNED' });
    expect(typeof api.send.mock.calls[0][1]).toBe('string');
    expect(ctl.state.remitStep).toBe('track');
    expect(ctl.state.remitError).toBeNull();
    expect(api.watch).toHaveBeenCalledWith('pmt_b', expect.any(Function), expect.any(Function));
  });

  it('RB3 never asks the anchor for a SEP-38 quote', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_2' });
    const ctl = makeCTL({ ...ON_BALANCE, quote: { ...QUOTE, expiresAt: Date.now() + 1_000 },
      anchorQuote: { id: 'aq_old', expiresAt: Date.now() + 10_000, price: '1', sellAmount: '334.26', sellAsset: 'x' } });
    await remit.signAndSend(ctl);
    expect(anchor.firmQuote).not.toHaveBeenCalled();
    expect(api.send.mock.calls[0][0].quoteId).toBe('qt_2');
  });

  it('RB4 says another payment is settling and stays on Review', async () => {
    api.send.mockRejectedValueOnce(new ApiError(409, 'PAYMENT_IN_PROGRESS', 'busy', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Another payment from your account is still settling. Wait until it is credited or fails, then press Sign and send again.');
    expect(ctl.state.remitStep).toBe('review');
  });

  it('RB5 explains an insufficient balance and re-reads it', async () => {
    api.send.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_BALANCE', 'short'));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Your balance no longer covers this payment (it needs up to 334.26 TESTMXN). Add money on the Balance tab, or pay at the anchor instead.');
    expect(ctl.refreshBalances).toHaveBeenCalledTimes(1);
    expect(ctl.state.payFrom).toBe('balance');
  });

  it('RB6 an expired quote forces a fresh quote on the next press', async () => {
    api.send.mockRejectedValueOnce(new ApiError(409, 'QUOTE_EXPIRED', 'expired', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('The quote expired before Corra received your signature. Press Sign and send to sign against a fresh quote.');
    expect(ctl.state.quote?.expiresAt).toBe(0);
  });

  it('RB7 a stale sequence drops the signature: the next press prompts again', async () => {
    api.send.mockRejectedValueOnce(new ApiError(422, 'UNBOUND_TRANSACTION', "sequence is not the payment account's next"));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Another Corra payment or pool step used your payment account\'s next sequence number after you signed, so this signature cannot be used. Press Sign and send to sign again.');
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
    expect(api.send.mock.calls[1][1]).not.toBe(api.send.mock.calls[0][1]);
  });

  it('RB8 an unanswered /send is retried with the same blob and key, one prompt', async () => {
    api.send.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('down (UNREACHABLE) Your signature is kept; pressing Sign and send again retries it without a new prompt. Check History before sending again.');
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(2);
    expect(api.send.mock.calls[1][1]).toBe(api.send.mock.calls[0][1]);
    expect(api.send.mock.calls[1][0].signedXdr).toBe('SIGNED');
    expect(ctl.state.remitStep).toBe('track');
  });

  it('RB9 stops before the prompt when a refreshed cap is above the spendable balance', async () => {
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_up', maxSend: { amount: '450.0000000', asset: 'TESTMXN' } });
    const ctl = makeCTL({ ...ON_BALANCE, quote: { ...QUOTE, expiresAt: Date.now() + 1_000 } });
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Your balance 400.00 TESTMXN no longer covers the new cap 450.00 TESTMXN. Add money on the Balance tab, or pay at the anchor instead. Nothing was signed.');
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('RB14 a balance choice that no longer covers the cap runs the anchor path the screen shows', async () => {
    const ctl = makeCTL({ payFrom: 'balance', walletSpendable: '100.0000000' });
    await remit.signAndSend(ctl);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'presigned' });
    expect(ctl.state.remitStep).toBe('cashin');
    expect(ctl.state.remitError).toBeNull();
  });

  it('RB15 after INSUFFICIENT_BALANCE the re-read balance decides the choice, and the next press is the anchor path', async () => {
    api.send.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_BALANCE', 'short'));
    const ctl = makeCTL(ON_BALANCE);
    (ctl.refreshBalances as any).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 0));
      ctl.set({ walletSpendable: '100.0000000' });
    });
    await remit.signAndSend(ctl);
    expect(ctl.state.walletSpendable).toBe('100.0000000');
    expect(ctl.state.payFrom).toBe('anchor');
    await remit.signAndSend(ctl);
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitStep).toBe('cashin');
  });

  it('RB16 while an unanswered /send may still land, the anchor choice refuses and never calls /confirm', async () => {
    api.send.mockRejectedValueOnce(new ApiError(503, 'UPSTREAM', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(remit.balanceRetryPending(ctl.state)).toBe(true);
    ctl.state.payFrom = 'anchor';
    await remit.signAndSend(ctl);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitError).toBe('Your payment from the balance may already be on its way; press Sign and send to finish it, or check History.');
    expect(ctl.state.payFrom).toBe('balance');
  });

  it('RB17 an unanswered /send is retried with the same blob even after the spendable balance drops', async () => {
    api.send.mockRejectedValueOnce(new ApiError(503, 'UPSTREAM', 'down', true))
      .mockRejectedValueOnce(new ApiError(503, 'UPSTREAM', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    ctl.state.walletSpendable = '100.0000000';
    await remit.signAndSend(ctl);
    // Still unanswered: the choice stays on the balance, so the next press retries again.
    expect(ctl.state.payFrom).toBe('balance');
    await remit.signAndSend(ctl);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.send).toHaveBeenCalledTimes(3);
    expect(api.send.mock.calls[2][1]).toBe(api.send.mock.calls[0][1]);
    expect(ctl.state.remitStep).toBe('track');
    expect(remit.balanceRetryPending(ctl.state)).toBe(false);
  });

  it('RB10 the anchor option still runs Phase 1 when the balance covers', async () => {
    const ctl = makeCTL({ ...ON_BALANCE, payFrom: 'anchor' });
    await remit.signAndSend(ctl);
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'presigned' });
    expect(ctl.state.remitStep).toBe('cashin');
  });

  it('RB11 re-signs a failed balance payment from the balance via /resign, with no deposit', async () => {
    api.quote.mockResolvedValue(QUOTE);
    api.resign.mockResolvedValue({ ...PAYMENT, id: 'pmt_r', kind: 'balance', state: 'CASH_IN' });
    const old = { ...PAYMENT, kind: 'balance', state: 'FAILED', events: [] };
    const ctl = makeCTL({ payment: old, remitStep: 'track', walletSpendable: '400.0000000' });
    await remit.resend(ctl);
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'balance' });
    expect(api.resign.mock.calls[0][0]).toEqual({ supersedesId: 'pmt_1', quoteId: 'qt_1', signedXdr: 'SIGNED' });
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(anchor.firmQuote).not.toHaveBeenCalled();
    expect(ctl.refreshBalances).toHaveBeenCalled();
    expect(ctl.state.remitStep).toBe('track');
    expect(ctl.state.payment?.id).toBe('pmt_r');
  });

  it('RB22 an unanswered /resign keeps its blob and key: the next press replays them, never signs again', async () => {
    api.quote.mockResolvedValue(QUOTE);
    api.resign.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const old = { ...PAYMENT, kind: 'balance', state: 'FAILED', events: [] };
    const ctl = makeCTL({ payment: old, remitStep: 'track', walletSpendable: '400.0000000' });
    await remit.resend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitError).toContain('Your signature is kept; pressing Sign a new payment again retries it without a new prompt.');
    api.resign.mockResolvedValueOnce({ ...PAYMENT, id: 'pmt_r', kind: 'balance', state: 'CASH_IN' });
    await remit.resend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.resign).toHaveBeenCalledTimes(2);
    expect(api.resign.mock.calls[1]).toEqual(api.resign.mock.calls[0]);
    expect(api.send).not.toHaveBeenCalled();
    expect(ctl.state.payment?.id).toBe('pmt_r');
    // Answered: the kept record is gone, so a later failure signs a fresh payment.
    ctl.set({ payment: { ...old, id: 'pmt_r' } });
    await remit.resend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(2);
  });

  it('RB23 a refused balance resend points at the Track screen buttons, not at an anchor choice it lacks', async () => {
    api.quote.mockResolvedValue(QUOTE);
    const old = { ...PAYMENT, kind: 'balance', state: 'FAILED', events: [] };
    const way = 'Add money on the Balance tab and press Sign a new payment again, or press Send another to pay at the anchor.';
    const short = makeCTL({ payment: old, remitStep: 'track', walletSpendable: '100.0000000' });
    await remit.resend(short);
    expect(short.state.remitError).toBe('Your balance 100.00 TESTMXN no longer covers the new cap 334.26 TESTMXN. ' + way + ' Nothing was signed.');
    api.resign.mockRejectedValueOnce(new ApiError(422, 'INSUFFICIENT_BALANCE', 'short'));
    const ctl = makeCTL({ payment: old, remitStep: 'track', walletSpendable: '400.0000000' });
    await remit.resend(ctl);
    expect(ctl.state.remitError).toBe('Your balance no longer covers this payment (it needs up to 334.26 TESTMXN). ' + way);
    expect(remit.sendErrorText(new ApiError(422, 'INSUFFICIENT_BALANCE', 'short'), QUOTE)).toContain('or pay at the anchor instead.');
  });

  it('RB24 a failed quote refresh on the balance path never claims a kept signature; the next press signs once', async () => {
    api.quote.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL({ ...ON_BALANCE, quote: { ...QUOTE, expiresAt: Date.now() + 1_000 } });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
    expect(ctl.state.remitError).toBe('down (UNREACHABLE) Check History before sending again.');
    api.quote.mockResolvedValueOnce({ ...QUOTE, id: 'qt_2' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[0][0].quoteId).toBe('qt_2');
    expect(ctl.state.remitStep).toBe('track');
  });

  it('RB25 lost /confirm, then the balance choice: no balance prompt and no /send, the press replays /confirm with its key', async () => {
    api.confirm.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL({ walletSpendable: '400.0000000' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    ctl.set({ payFrom: 'balance' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(build.buildStrictReceive.mock.calls.some((c: any[]) => c[0].mode === 'balance')).toBe(false);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.confirm).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[1][1]).toBe(api.confirm.mock.calls[0][1]);
    expect(api.confirm.mock.calls[1][0].signedXdr).toBe('SIGNED');
    expect(ctl.state.payment?.id).toBe('pmt_1');
  });

  it('RB26 lost /confirm on another quote, then the balance choice: refused before any prompt, pointing at History', async () => {
    api.confirm.mockRejectedValueOnce(new ApiError(503, 'UNAVAILABLE', 'down', true));
    const ctl = makeCTL({ walletSpendable: '400.0000000' });
    await remit.signAndSend(ctl);
    ctl.set({ quote: { ...QUOTE, id: 'qt_2' }, payFrom: 'balance' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.send).not.toHaveBeenCalled();
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitError).toBe(remit.CASH_IN_MAY_HAVE_LANDED);
    expect(ctl.state.remitStep).toBe('review');
  });

  it('RB27 a 429 on /send covers the per-account and the per-network limit', async () => {
    api.send.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'slow down'));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    expect(ctl.state.remitError).toBe('Too many sends from this account or this network in the last 10 minutes. Wait a few minutes, then try again.');
  });

  it('RB12 flags a signed Phase 1 payment waiting for its cash-in; a failed list does not block the quote', async () => {
    api.quote.mockResolvedValue(QUOTE);
    api.accountPayments.mockResolvedValueOnce({ payments: [{ ...PAYMENT, kind: 'cash_in', state: 'SIGNED' }] });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(api.accountPayments).toHaveBeenCalledWith(SENDER, 'sender', 20);
    expect(ctl.state.signedWaiting).toBe(true);
    api.accountPayments.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const other = makeCTL({ remitStep: 'form' });
    await remit.getQuote(other);
    expect(other.state.signedWaiting).toBe(false);
    expect(other.state.remitStep).toBe('review');
  });

  it('RB13 a balance blob kept after an unanswered /send blocks a payment on a new quote, and is never replayed to /confirm', async () => {
    api.send.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    // A new quote (back, then Review again) must not start a second payment while the first may have landed.
    ctl.state.quote = { ...QUOTE, id: 'qt_new' };
    ctl.state.payFrom = 'anchor';
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(api.send).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitError).toBe('Your payment from the balance may already be on its way; press Sign and send to finish it, or check History.');
    // Back on the kept payment: the next press retries its blob, never a new one.
    expect(ctl.state.quote?.id).toBe('qt_1');
    expect(ctl.state.payFrom).toBe('balance');
    expect(remit.balanceRetryPending(ctl.state)).toBe(true);
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(api.send.mock.calls[1][1]).toBe(api.send.mock.calls[0][1]);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(ctl.state.remitStep).toBe('track');
  });

  it('RB18 lost /send, Back, new quote, anchor: no new quote, no /confirm, a warning', async () => {
    api.send.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    ctl.set({ remitStep: 'form', remitError: null, destDigits: '500' });
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_new' });
    senderHolds('400.0000000');
    await remit.getQuote(ctl);
    expect(ctl.state.quote?.id).toBe('qt_1');
    expect(ctl.state.remitStep).toBe('review');
    expect(ctl.state.remitError).toBe('Your payment from the balance may already be on its way; press Sign and send to finish it, or check History.');
    ctl.state.payFrom = 'anchor';
    await remit.signAndSend(ctl);
    expect(api.confirm).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state.remitError).toBe('Your payment from the balance may already be on its way; press Sign and send to finish it, or check History.');
    // A resend of an older failed payment is a new payment too.
    ctl.set({ payment: { ...PAYMENT, kind: 'balance', state: 'FAILED', events: [] }, remitStep: 'track' });
    await remit.resend(ctl);
    expect(api.resign).not.toHaveBeenCalled();
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
  });

  it('RB19 a lost /send that landed is found on the next quote: shown on track, no new quote', async () => {
    api.send.mockRejectedValueOnce(new ApiError(503, 'UPSTREAM', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    const landed = { ...PAYMENT, id: 'pmt_b', kind: 'balance', state: 'CREDITED', quote: QUOTE };
    api.accountPayments.mockResolvedValueOnce({ payments: [landed] });
    api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_new' });
    ctl.set({ remitStep: 'form', remitError: null });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('track');
    expect(ctl.state.payment?.id).toBe('pmt_b');
    expect(api.watch).toHaveBeenCalledWith('pmt_b', expect.any(Function), expect.any(Function));
    expect(ctl.state.remitError).toBe('Your earlier payment from the balance reached Corra, so no new quote was taken. Check it here before sending again.');
    expect(remit.balanceRetryPending({ ...ctl.state, quote: QUOTE })).toBe(false);
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('RB20 once the kept quote expired, the next quote replays the kept blob with its key, then goes on', async () => {
    api.send.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
    const ctl = makeCTL(ON_BALANCE);
    await remit.signAndSend(ctl);
    const key = api.send.mock.calls[0][1];
    // The server answers the known key with the stored payment.
    api.send.mockResolvedValueOnce({ ...PAYMENT, id: 'pmt_b', kind: 'balance', state: 'ONCHAIN' });
    vi.useFakeTimers({ now: Date.now() + 130_000, toFake: ['Date'] });
    try {
      api.quote.mockResolvedValue({ ...QUOTE, id: 'qt_new', expiresAt: Date.now() + 120_000 });
      senderHolds('400.0000000');
      ctl.set({ remitStep: 'form', remitError: null });
      await remit.getQuote(ctl);
      expect(api.send).toHaveBeenCalledTimes(2);
      expect(api.send.mock.calls[1]).toEqual([{ quoteId: 'qt_1', sender: SENDER, recipient: RECIPIENT, signedXdr: 'SIGNED' }, key]);
      expect(ctl.state.remitStep).toBe('track');
      expect(ctl.state.payment?.id).toBe('pmt_b');
      // A key the server never saw gets a 4xx: the blob is dropped and the new quote goes on.
      api.send.mockRejectedValueOnce(new ApiError(0, 'UNREACHABLE', 'down', true));
      ctl.set({ remitStep: 'review', quote: QUOTE, payFrom: 'balance' });
      vi.setSystemTime(Date.now() - 130_000);
      await remit.signAndSend(ctl);
      vi.setSystemTime(Date.now() + 130_000);
      api.send.mockRejectedValueOnce(new ApiError(409, 'QUOTE_EXPIRED', 'expired', true));
      ctl.set({ remitStep: 'form', remitError: null });
      await remit.getQuote(ctl);
      expect(api.send).toHaveBeenCalledTimes(4);
      expect(ctl.state.quote?.id).toBe('qt_new');
      expect(ctl.state.remitStep).toBe('review');
      expect(remit.balanceRetryPending(ctl.state)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('RB21 after a reload, a recent balance payment to the same recipient is flagged before any new sign', async () => {
    api.quote.mockResolvedValue(QUOTE);
    senderHolds('400.0000000');
    const recent = { ...PAYMENT, id: 'pmt_r', publicId: 'CORRA-R', kind: 'balance', state: 'CASH_IN', createdAt: Date.now() - 60_000 };
    api.accountPayments.mockResolvedValueOnce({ payments: [recent] });
    const ctl = makeCTL({ remitStep: 'form' });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('review');
    expect(ctl.state.remitError).toBe('You sent CORRA-R from your balance to this recipient in the last 5 minutes. Check History before sending again.');
    for (const other of [{ ...recent, createdAt: Date.now() - 6 * 60_000 }, { ...recent, state: 'FAILED' }, { ...recent, recipientAccount: SENDER }, { ...recent, kind: 'cash_in' }]) {
      api.accountPayments.mockResolvedValueOnce({ payments: [other] });
      const c = makeCTL({ remitStep: 'form' });
      await remit.getQuote(c);
      expect(c.state.remitError).toBeNull();
    }
  });

  it('RQ1 a Horizon blip at quote time never lowers a finished setup', async () => {
    api.quote.mockResolvedValue(QUOTE);
    horizon.loadAccount.mockRejectedValue(new Error('timeout'));
    const ctl = makeCTL({ remitStep: 'form', setupDone: true });
    await remit.getQuote(ctl);
    expect(ctl.state.remitStep).toBe('review');
    expect(ctl.state.setupDone).toBe(true);
    // A lagging replica that does not show the trustline yet does not lower it either.
    senderHolds('0');
    horizon.loadAccount.mockImplementation(async (id: string) => ({ sequence: '1', balances: id === SENDER ? [] : [{ asset_code: 'TESTPHP', asset_issuer: TESTNET.corridorIssuer, balance: '0' }] }));
    const lag = makeCTL({ remitStep: 'form', setupDone: true });
    await remit.getQuote(lag);
    expect(lag.state.setupDone).toBe(true);
    // It still rises once Horizon shows the trustline and the payment account.
    senderHolds('1.0000000');
    signer.records = [paymentAccountRecord(PAY)];
    const fresh = makeCTL({ remitStep: 'form', setupDone: false, paymentAccount: null });
    await remit.getQuote(fresh);
    expect(fresh.state.setupDone).toBe(true);
  });
});

const S = await import('@stellar/stellar-sdk');
const stellar = await vi.importActual<typeof import('@corra/stellar')>('@corra/stellar');

describe('payment account (spec-varial-fix S1/S3)', () => {
  const SPONSOR = TESTNET.feeSponsor;
  const NP = TESTNET.networkPassphrase;
  const SEED = /S[A-Z2-7]{55}/;
  const now = () => Math.floor(Date.now() / 1000);
  const ownSetup = (accountExists: boolean) => stellar.buildSponsoredSetup({
    networkPassphrase: NP, sponsor: SPONSOR, sponsorSequence: '11', account: SENDER, accountExists, trust: [{ code: 'TESTMXN', issuer: TESTNET.corridorIssuer }], now: now(),
  }).toXDR();
  const paymentSetup = (z: string, signerKey = SENDER) => stellar.buildPaymentAccountSetup({
    networkPassphrase: NP, sponsor: SPONSOR, sponsorSequence: '10', sender: signerKey, paymentAccount: z, now: now(),
  }).toXDR();
  let stored: Record<string, string>;

  beforeEach(() => {
    stored = {};
    vi.stubGlobal('localStorage', { getItem: (k: string) => stored[k] ?? null, setItem: (k: string, v: string) => { stored[k] = v; } });
    fw.signTransaction.mockImplementation(async (xdr: string) => ({ signedTxXdr: xdr, signerAddress: SENDER }));
  });
  afterEach(() => vi.unstubAllGlobals());

  const submitted = () => horizon.submitTransaction.mock.calls.map((c) => c[0] as InstanceType<typeof S.Transaction>);

  it('PA1 new account: the payment account first, signed by a throwaway key only; then one Freighter prompt for the account itself', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z), xdr: ownSetup(false) }));
    const ctl = makeCTL({ setupDone: false, paymentAccount: null });
    await remit.ensureSetup(ctl, remit.currentGeneration());
    const [account, trust, z] = api.setup.mock.calls[0];
    expect([account, trust]).toEqual([SENDER, ['MXN']]);
    expect(S.StrKey.isValidEd25519PublicKey(z)).toBe(true);
    expect(z).not.toBe(SENDER);
    const [first, second] = submitted();
    expect(first.operations.map((o) => o.type)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'setOptions', 'endSponsoringFutureReserves']);
    expect(first.signatures).toHaveLength(1);
    const sig: any = (first.signatures[0] as any).signature;
    expect(S.Keypair.fromPublicKey(z).verify(Buffer.from(first.hash()), Buffer.from(sig instanceof Uint8Array ? sig : sig.value))).toBe(true);
    expect(second.operations.map((o) => o.type)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves']);
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(fw.signTransaction.mock.calls[0][0]).toBe(ownSetup(false));
    // S3: the account just created, not a re-read.
    expect(ctl.state).toMatchObject({ setupDone: true, paymentAccount: z });
    // The throwaway key's secret is never sent or kept.
    expect(JSON.stringify([api.setup.mock.calls, fw.signTransaction.mock.calls])).not.toMatch(SEED);
    expect(JSON.stringify(stored)).not.toMatch(SEED);
    expect(JSON.stringify(ctl.state)).not.toMatch(SEED);
  });

  it('PA2 an existing trusted account (4.2): only the payment account, no Freighter prompt', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    const ctl = makeCTL({ setupDone: false, paymentAccount: null });
    await remit.ensureSetup(ctl, remit.currentGeneration());
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(submitted()).toHaveLength(1);
    expect(ctl.state.setupDone).toBe(true);
    expect(ctl.state.paymentAccount).toBe(api.setup.mock.calls[0][2]);
  });

  it('PA3 a tampered payment-account setup is refused before any signature or submission', async () => {
    const tampered = (z: string) => {
      const tx = new S.TransactionBuilder(new S.Account(SPONSOR, '10'), { fee: '1000', networkPassphrase: NP, timebounds: { minTime: 0, maxTime: now() + 300 } })
        .addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: z, source: SPONSOR }))
        .addOperation(S.Operation.createAccount({ destination: z, startingBalance: '0', source: SPONSOR }))
        .addOperation(S.Operation.setOptions({ source: z, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1, signer: { ed25519PublicKey: SENDER, weight: 1 } }))
        .addOperation(S.Operation.setOptions({ source: z, signer: { ed25519PublicKey: SPONSOR, weight: 1 } }))
        .addOperation(S.Operation.endSponsoringFutureReserves({ source: z }))
        .build();
      return tx.toXDR();
    };
    for (const make of [tampered, (z: string) => paymentSetup(z, RECIPIENT)]) {
      vi.clearAllMocks();
      api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: make(z), xdr: ownSetup(false) }));
      const ctl = makeCTL({ setupDone: false, paymentAccount: null });
      await expect(remit.ensureSetup(ctl, remit.currentGeneration())).rejects.toThrow();
      expect(horizon.submitTransaction).not.toHaveBeenCalled();
      expect(fw.signTransaction).not.toHaveBeenCalled();
      expect(ctl.state.setupDone).toBe(false);
    }
  });

  it('PA4 a known payment account is never re-created: no key is sent', async () => {
    api.setup.mockResolvedValue({ xdr: ownSetup(true) });
    const ctl = makeCTL({ setupDone: false, paymentAccount: PAY });
    await remit.ensureSetup(ctl, remit.currentGeneration());
    expect(api.setup.mock.calls[0][2]).toBeUndefined();
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state).toMatchObject({ setupDone: true, paymentAccount: PAY });
    // Nothing left to set up (409) is done, not an error.
    api.setup.mockRejectedValue(new ApiError(409, 'NOTHING_TO_SET_UP', 'nothing'));
    const done = makeCTL({ setupDone: false, paymentAccount: PAY });
    await remit.ensureSetup(done, remit.currentGeneration());
    expect(done.state.setupDone).toBe(true);
  });

  it('PA5 a balance payment from an account without one sets it up first with no extra prompt, then signs 4.4 on it', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    horizon.loadAccount.mockImplementation(async (id: string) => id === SENDER ? { sequence: '1', balances: [] } : { ...paymentAccountRecord(id), sequence: '5000' });
    const ctl = makeCTL({ payFrom: 'balance', walletSpendable: '400.0000000', setupDone: false, paymentAccount: null });
    await remit.signAndSend(ctl);
    const z = api.setup.mock.calls[0][2];
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'balance', sender: SENDER, paymentAccount: z, paymentSequence: '5000' });
    expect(fw.signTransaction).toHaveBeenCalledTimes(1); // the payment only
    expect(ctl.state.remitError).toBeNull();
  });

  it('PA6 signPayment builds 4.3 on the payment account\'s sequence, not the sender\'s', async () => {
    horizon.loadAccount.mockImplementation(async (id: string) => id === PAY ? { ...paymentAccountRecord(PAY), sequence: '7000' } : { sequence: '1', balances: [] });
    const ctl = makeCTL();
    await remit.signAndSend(ctl);
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ mode: 'presigned', sender: SENDER, paymentAccount: PAY, paymentSequence: '7000' });
  });

  it('PA7 a merged payment account (404) is forgotten: nothing is signed and the next press sets up a new one', async () => {
    horizon.loadAccount.mockImplementation(async (id: string) => {
      if (id === PAY) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return { sequence: '1', balances: [] };
    });
    const ctl = makeCTL({ payFrom: 'balance', walletSpendable: '400.0000000' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(ctl.state).toMatchObject({ setupDone: false, paymentAccount: null, remitError: remit.PAYMENT_ACCOUNT_GONE });
  });

  it('PA11 C6-3 a known payment account reshaped on chain (an extra signer) is forgotten like a merged one: nothing is signed', async () => {
    horizon.loadAccount.mockImplementation(async (id: string) => {
      if (id !== PAY) return { sequence: '1', balances: [] };
      const rec = paymentAccountRecord(PAY);
      return { ...rec, signers: [...rec.signers, { key: RECIPIENT, weight: 1, type: 'ed25519_public_key' }] };
    });
    const ctl = makeCTL({ payFrom: 'balance', walletSpendable: '400.0000000' });
    await remit.signAndSend(ctl);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(build.buildStrictReceive).not.toHaveBeenCalled();
    expect(ctl.state).toMatchObject({ setupDone: false, paymentAccount: null, remitError: remit.PAYMENT_ACCOUNT_GONE });
    expect(remit.PAYMENT_ACCOUNT_GONE).toMatch(/no longer usable/);
  });

  it('PA9 C1-1 a 404 right after this page created the payment account is a replica behind, not a merge: signs on its starting sequence', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    // Created in ledger 5; the replica that answers next has not ingested it yet.
    horizon.submitTransaction.mockResolvedValue({ ledger: 5 });
    horizon.loadAccount.mockImplementation(async (id: string) => {
      if (id !== SENDER) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return { sequence: '1', balances: [] };
    });
    const ctl = makeCTL({ payFrom: 'balance', walletSpendable: '400.0000000', setupDone: false, paymentAccount: null });
    await remit.signAndSend(ctl);
    const z = api.setup.mock.calls[0][2];
    expect(build.buildStrictReceive.mock.calls[0][0]).toMatchObject({ paymentAccount: z, paymentSequence: (5n << 32n).toString() });
    expect(fw.signTransaction).toHaveBeenCalledTimes(1);
    expect(ctl.state).toMatchObject({ setupDone: true, paymentAccount: z, remitError: null });
  });

  it('PA10 C1-4 an existing trusted account without a payment account never says Freighter while it sets up', async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    const ctl = makeCTL({ setupDone: false, paymentAccount: null });
    const busy: (string | null)[] = [];
    const set = ctl.set;
    ctl.set = (p: any) => { if (p && 'remitBusy' in p) busy.push(p.remitBusy); set(p); };
    await remit.ensureSetup(ctl, remit.currentGeneration());
    expect(busy).toEqual(['Setting up your account (sponsored, no Freighter prompt)…']);
    expect(ctl.state.mxnTrusted).toBe(true);
    // A new account: the Freighter line shows only once the wallet prompt is next.
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z), xdr: ownSetup(false) }));
    const fresh = makeCTL({ setupDone: false, paymentAccount: null });
    const busy2: (string | null)[] = [];
    const set2 = fresh.set;
    fresh.set = (p: any) => { if (p && 'remitBusy' in p) busy2.push(p.remitBusy); set2(p); };
    await remit.ensureSetup(fresh, remit.currentGeneration());
    expect(busy2).toEqual(['Setting up your account (sponsored, no Freighter prompt)…', 'Freighter: set up your account, one time only (sponsored, you pay no XLM)']);
  });

  it('PA8 a balance payment refused while a signed one waits for its cash-in says what to do', () => {
    expect(remit.sendErrorText(new ApiError(409, 'SIGNED_PAYMENT_WAITING', 'x', true)))
      .toBe('You have a signed payment waiting for its cash-in, so paying from your balance stays blocked until it is credited or expires. Finish its deposit, or pay at the anchor instead.');
  });

  it('RS-C1 channel-sourced setups (Unit 5): signs with z, submits the payment account first, then prompts the wallet', async () => {
    const C = S.Keypair.random().publicKey();
    const via = { account: C, sequence: '7000' };
    let own = '';
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => {
      own = stellar.buildSponsoredSetup({
        networkPassphrase: NP, sponsor: SPONSOR, sponsorSequence: '11', txSource: { account: C, sequence: '7001' }, account: SENDER, accountExists: false,
        trust: [{ code: 'TESTMXN', issuer: TESTNET.corridorIssuer }], now: now(),
      }).toXDR();
      const paymentAccountXdr = stellar.buildPaymentAccountSetup({
        networkPassphrase: NP, sponsor: SPONSOR, sponsorSequence: '10', txSource: via, sender: SENDER, paymentAccount: z, now: now(),
      }).toXDR();
      return { paymentAccountXdr, xdr: own };
    });
    const ctl = makeCTL({ setupDone: false, paymentAccount: null });
    await remit.ensureSetup(ctl, remit.currentGeneration());
    const z = api.setup.mock.calls[0][2];
    const [first, second] = submitted();
    expect([first.source, first.sequence, second.source, second.sequence]).toEqual([C, '7001', C, '7002']);
    expect(first.signatures).toHaveLength(1);
    expect(S.Keypair.fromPublicKey(z).verify(Buffer.from(first.hash()), first.signatures[0].signature)).toBe(true);
    expect(fw.signTransaction.mock.calls).toEqual([[own, expect.anything()]]);
    expect(horizon.submitTransaction.mock.invocationCallOrder[0]).toBeLessThan(fw.signTransaction.mock.invocationCallOrder[0]);
    expect(ctl.state).toMatchObject({ setupDone: true, paymentAccount: z });
  });

  it('RS-C2 a payment-account setup whose begin is sourced by a stranger, not TESTNET.feeSponsor, is refused before any signature or submit', async () => {
    const stranger = S.Keypair.random().publicKey();
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({
      paymentAccountXdr: stellar.buildPaymentAccountSetup({
        networkPassphrase: NP, sponsor: stranger, sponsorSequence: '10', txSource: { account: S.Keypair.random().publicKey(), sequence: '7000' },
        sender: SENDER, paymentAccount: z, now: now(),
      }).toXDR(),
      xdr: ownSetup(false),
    }));
    const ctl = makeCTL({ setupDone: false, paymentAccount: null });
    await expect(remit.ensureSetup(ctl, remit.currentGeneration())).rejects.toThrow(/sponsor beginning sponsorship/);
    expect(horizon.submitTransaction).not.toHaveBeenCalled();
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(ctl.state.setupDone).toBe(false);
  });
});

describe('ensureSetup for the recipient\'s cash-out (D3)', () => {
  const NP = TESTNET.networkPassphrase;
  const now = () => Math.floor(Date.now() / 1000);
  const paymentSetup = (z: string) => stellar.buildPaymentAccountSetup({
    networkPassphrase: NP, sponsor: TESTNET.feeSponsor, sponsorSequence: '10', sender: SENDER, paymentAccount: z, now: now(),
  }).toXDR();
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    fw.signTransaction.mockImplementation(async (xdr: string) => ({ signedTxXdr: xdr, signerAddress: SENDER }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("RP1 ['PHP'] returns early only when the account trusts TESTPHP and has a payment account; MXN still keys on setupDone", async () => {
    await remit.ensureSetup(makeCTL({ setupDone: false, phpTrusted: true, paymentAccount: PAY }), remit.currentGeneration(), 'cashOutBusy', ['PHP']);
    expect(api.setup).not.toHaveBeenCalled();
    await remit.ensureSetup(makeCTL({ setupDone: true, phpTrusted: false, paymentAccount: PAY }), remit.currentGeneration());
    expect(api.setup).not.toHaveBeenCalled();
    api.setup.mockRejectedValue(new ApiError(409, 'NOTHING_TO_SET_UP', 'nothing'));
    await remit.ensureSetup(makeCTL({ setupDone: true, phpTrusted: false, paymentAccount: PAY }), remit.currentGeneration(), 'cashOutBusy', ['PHP']);
    expect(api.setup).toHaveBeenCalledWith(SENDER, ['PHP'], undefined);
  });

  it("RP2 a recipient that trusts TESTPHP but has no payment account: /setup with ['PHP'] and a throwaway key, no prompt; ends phpTrusted, setupDone untouched", async () => {
    api.setup.mockImplementation(async (_a: string, _t: string[], z: string) => ({ paymentAccountXdr: paymentSetup(z) }));
    const ctl = makeCTL({ setupDone: false, mxnTrusted: false, phpTrusted: true, paymentAccount: null });
    await remit.ensureSetup(ctl, remit.currentGeneration(), 'cashOutBusy', ['PHP']);
    const [account, trust, z] = api.setup.mock.calls[0];
    expect([account, trust]).toEqual([SENDER, ['PHP']]);
    expect(fw.signTransaction).not.toHaveBeenCalled();
    expect(ctl.state).toMatchObject({ phpTrusted: true, paymentAccount: z, setupDone: false, mxnTrusted: false, remitBusy: null });
    expect(ctl.state.cashOutBusy).toBeTruthy();
  });
});
