import { describe, it, expect, vi, beforeEach } from 'vitest';
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
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));

const horizon = vi.hoisted(() => ({ loadAccount: vi.fn(), submitTransaction: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});
vi.mock('@corra/stellar', () => ({ buildStrictReceive: () => ({ toXDR: () => 'UNSIGNED' }) }));

const { TESTNET } = await import('@corra/shared');
const { ApiError } = await import('./api');
const remit = await import('./remit');

const SENDER = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const RECIPIENT = 'GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO';

const QUOTE: any = {
  id: 'qt_1', mode: 'strict_receive', corridor: { from: 'MX/MXN', to: 'PH/PHP' },
  source: { amount: '329.3190139', asset: 'TESTMXN' }, dest: { amount: '1000.0000000', asset: 'TESTPHP' },
  maxSend: { amount: '334.2587992', asset: 'TESTMXN' }, path: [], slippageBps: 150,
  expiresAt: Date.now() + 120_000,
};
const PAYMENT: any = { id: 'pmt_1', publicId: 'CORRA-1', state: 'SIGNED', recipientAccount: RECIPIENT, quote: QUOTE, legs: [] };

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { state: AppState } {
  const state: any = {
    tab: 'send', pick: 'PH', addr: RECIPIENT, remitStep: 'review', destDigits: '1000', quote: QUOTE,
    anchorQuote: { id: 'aq_old', expiresAt: Date.now() + 600_000, price: '1', sellAmount: '334.26', sellAsset: 'iso4217:MXN' },
    setupDone: true, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    pos: {}, vaultDigits: '', vaultPick: 'blend', sign: null, signState: 'ask', wallet: 0, history: [],
    walletMode: 'freighter', pubkey: SENDER, connecting: false,
    ...overrides,
  };
  return {
    state,
    set: (p: any) => Object.assign(state, typeof p === 'function' ? p(state) : p),
    refreshBalances: async () => {},
  } as any;
}

let stopWatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  remit.cancelRemit();
  fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
  fw.getAddress.mockResolvedValue({ address: SENDER });
  fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: SENDER });
  horizon.loadAccount.mockResolvedValue({
    sequence: '1',
    balances: ['TESTMXN', 'TESTPHP'].map((c) => ({ asset_code: c, asset_issuer: TESTNET.corridorIssuer })),
  });
  api.confirm.mockResolvedValue(PAYMENT);
  api.resign.mockResolvedValue({ ...PAYMENT, id: 'pmt_2' });
  api.linkCashIn.mockResolvedValue({});
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
      : { sequence: '1', balances: [{ asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer }] });
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
    const { getBalances } = await import('./stellar');
    horizon.loadAccount.mockResolvedValue({ balances: [
      { asset_type: 'native', balance: '1' },
      { asset_type: 'credit_alphanum12', asset_code: 'TESTMXN', asset_issuer: 'GFAKEISSUER', balance: '999' },
    ] });
    expect((await getBalances(SENDER)).TESTMXN).toBeUndefined();
    horizon.loadAccount.mockResolvedValue({ balances: [
      { asset_type: 'credit_alphanum12', asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer, balance: '5' },
    ] });
    expect((await getBalances(SENDER)).TESTMXN).toBe('5');
  });
});

describe('double-check follow-ups', () => {
  const unreachable = () => new ApiError(0, 'UNREACHABLE', 'down', true);

  it('blocks a recipient account that does not exist (Horizon 404) before any prompt', async () => {
    api.quote.mockResolvedValue(QUOTE);
    horizon.loadAccount.mockImplementation(async (id: string) => {
      if (id === RECIPIENT) throw Object.assign(new Error('Not Found'), { response: { status: 404 } });
      return { sequence: '1', balances: [{ asset_code: 'TESTMXN', asset_issuer: TESTNET.corridorIssuer }] };
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

