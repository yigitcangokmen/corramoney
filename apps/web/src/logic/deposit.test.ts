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
  setup: vi.fn(),
  createDeposit: vi.fn(),
  linkDeposit: vi.fn(),
  deposit: vi.fn(),
  watchDeposit: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));

const horizon = vi.hoisted(() => ({ loadAccount: vi.fn(), submitTransaction: vi.fn() }));
vi.mock('@stellar/stellar-sdk', async (orig) => {
  const real = await orig<typeof import('@stellar/stellar-sdk')>();
  return { ...real, Horizon: { ...real.Horizon, Server: vi.fn(() => horizon) } };
});
vi.mock('@corra/stellar', async (orig) => ({ ...(await orig<typeof import('@corra/stellar')>()), buildStrictReceive: vi.fn(() => ({ toXDR: () => 'UNSIGNED' })) }));

const { TESTNET } = await import('@corra/shared');
const { ApiError } = await import('./api');
const realApi = (await vi.importActual<typeof import('./api')>('./api')).api;
const remit = await import('./remit');
const deposit = await import('./deposit');

const SENDER = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const PAY = 'GAOIFT2MYJYEKA7MEEKXHEYCN6KRCFD7USFW5SJVYBAGL6WMHTG4NFEG';
const KEY = 'corra_deposits_' + SENDER;

const DEP: any = {
  id: 'dep_1', account: SENDER, anchorRef: null, moreInfoUrl: null, memo: 'MEMO=',
  requested: { amount: '600.0000000', asset: 'TESTMXN' }, credited: null, txHash: null,
  status: 'PENDING', matchedBy: null, reason: null, createdAt: Date.now(), updatedAt: Date.now(),
};

function makeCTL(overrides: Partial<AppState> = {}): Ctl & { state: AppState } {
  const state: any = {
    tab: 'balance', pick: 'PH', addr: '', remitStep: 'form', destDigits: '1000', quote: null, anchorQuote: null,
    setupDone: true, paymentAccount: PAY, anchorToken: 'jwt', anchorTokenExp: Date.now() + 3_600_000, payment: null, cashInUrl: null,
    remitBusy: null, remitError: null, trackError: null, popupBlocked: false, depositSkipped: false, freighterMissing: false,
    sign: null, signState: 'ask', wallet: 0, history: [],
    walletMode: 'freighter', pubkey: SENDER, connecting: false,
    payFrom: 'anchor', walletSpendable: '0', otherBalances: {}, balanceAt: 1, signedWaiting: false,
    depositStep: 'form', depositAmount: '600', deposit: null, depositUrl: null, depositBusy: null,
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

let store: Record<string, string>;
const stored = () => JSON.parse(store[KEY] ?? '{}');
let stopWatch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  remit.cancelRemit();
  deposit.cancelDeposit();
  store = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
  });
  vi.stubGlobal('window', { open: vi.fn(() => ({})) });
  fw.getNetworkDetails.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET.networkPassphrase });
  fw.getAddress.mockResolvedValue({ address: SENDER });
  fw.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED', signerAddress: SENDER });
  anchor.anchorLogin.mockResolvedValue({ token: 'jwt2', exp: Date.now() + 3_600_000 });
  anchor.startDeposit.mockResolvedValue({ id: 'ref_1', url: 'https://anchor/page?token=t1' });
  api.createDeposit.mockResolvedValue(DEP);
  api.linkDeposit.mockResolvedValue({ ...DEP, anchorRef: 'ref_1' });
  stopWatch = vi.fn();
  api.watchDeposit.mockReturnValue(stopWatch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('startAddMoney', () => {
  it('DW1 starts an unbound deposit with Corra\'s memo, links it and waits, without opening a window', async () => {
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(api.createDeposit).toHaveBeenCalledWith(SENDER, '600.00');
    expect(anchor.startDeposit.mock.calls[0]).toEqual(['jwt', SENDER, '600.00', 'MEMO=']);
    expect(api.linkDeposit).toHaveBeenCalledWith('dep_1', 'ref_1');
    expect(ctl.state.depositStep).toBe('waiting');
    expect(ctl.state.depositUrl).toBe('https://anchor/page?token=t1');
    expect(ctl.state.deposit?.anchorRef).toBe('ref_1');
    expect(ctl.state.depositError).toBeNull();
    expect(ctl.state.depositBusy).toBeNull();
    expect(ctl.state.remitBusy).toBeNull();
    expect((window.open as any)).not.toHaveBeenCalled();
    expect(api.watchDeposit).toHaveBeenCalledWith('dep_1', expect.any(Function), expect.any(Function));
    expect(stored().dep_1).toMatchObject({ ref: 'ref_1', linked: true });
  });

  it('DW2 remembers ref and page before linking; a lost link is not an error and is relinked on the next connect', async () => {
    let atLink: any;
    api.linkDeposit.mockImplementationOnce(async () => {
      atLink = stored().dep_1;
      throw new ApiError(0, 'UNREACHABLE', 'down', true);
    });
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(atLink).toMatchObject({ ref: 'ref_1', url: 'https://anchor/page?token=t1' });
    expect(atLink.linked).toBeUndefined();
    expect(ctl.state.depositStep).toBe('waiting');
    expect(ctl.state.depositError).toBeNull();

    await deposit.relinkRemembered(ctl);
    expect(api.linkDeposit).toHaveBeenCalledTimes(2);
    expect(api.linkDeposit.mock.calls[1]).toEqual(['dep_1', 'ref_1']);
    expect(stored().dep_1.linked).toBe(true);
  });

  it('DW3 a link answered 409 already-linked is not an error', async () => {
    api.linkDeposit.mockRejectedValueOnce(new ApiError(409, 'DEPOSIT_ALREADY_LINKED', 'linked'));
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositStep).toBe('waiting');
    expect(ctl.state.depositError).toBeNull();
    expect(stored().dep_1.linked).toBe(true);
  });

  it('DW4 accepts 1.00 to 1,000,000.00 MXN with up to 2 decimals', () => {
    const table: [string, boolean][] = [['0.99', false], ['1', true], ['1.5', true], ['1000000', true],
      ['1000000.01', false], ['5.123', false], ['', false], ['12345678', false]];
    for (const [s, ok] of table) expect(deposit.validDeposit(s), s).toBe(ok);
  });

  it('DW5 an anchor failure goes back to the form; the retry reuses the same deposit record and memo', async () => {
    anchor.startDeposit.mockRejectedValueOnce(new Error('anchor down'));
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositStep).toBe('form');
    expect(ctl.state.depositError).toBe('The anchor did not answer: anchor down. Nothing was charged; try again.');
    await deposit.startAddMoney(ctl);
    expect(api.createDeposit).toHaveBeenCalledTimes(1);
    expect(anchor.startDeposit).toHaveBeenCalledTimes(2);
    expect(anchor.startDeposit.mock.calls[1][3]).toBe('MEMO=');
    expect(ctl.state.depositStep).toBe('waiting');
  });

  it('DW6 a changed amount after a failure records a new deposit', async () => {
    anchor.startDeposit.mockRejectedValueOnce(new Error('anchor down'));
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    ctl.state.depositAmount = '700';
    api.createDeposit.mockResolvedValueOnce({ ...DEP, id: 'dep_2', requested: { amount: '700.0000000', asset: 'TESTMXN' } });
    await deposit.startAddMoney(ctl);
    expect(api.createDeposit).toHaveBeenCalledTimes(2);
    expect(api.createDeposit.mock.calls[1]).toEqual([SENDER, '700.00']);
  });

  it('DW7 explains the deposit limit, per account or per network', async () => {
    api.createDeposit.mockRejectedValueOnce(new ApiError(429, 'RATE_LIMITED', 'too many', true));
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositError).toBe('Too many deposits from this account or this network in the last 10 minutes. Wait a few minutes, then try again.');
    expect(anchor.startDeposit).not.toHaveBeenCalled();
  });

  it('DW20 refuses an anchor deposit page that is not an http(s) link: never stored, remembered or opened', async () => {
    anchor.startDeposit.mockResolvedValueOnce({ id: 'ref_1', url: 'javascript:alert(document.domain)' });
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositStep).toBe('form');
    expect(ctl.state.depositUrl).toBeNull();
    expect(ctl.state.depositError).toBe(deposit.UNSAFE_ANCHOR_PAGE);
    expect(JSON.stringify(stored())).not.toContain('javascript:');
    deposit.openAnchorPage(ctl);
    expect(window.open).not.toHaveBeenCalled();
  });

  it('DW8 an account without the trustline goes back to setup', async () => {
    api.createDeposit.mockRejectedValueOnce(new ApiError(422, 'ACCOUNT_NOT_READY', 'set it up', true));
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.setupDone).toBe(false);
    expect(ctl.state.depositError).toBe('Your account is not set up for TESTMXN yet. Set it up first: one Freighter prompt, no XLM needed.');
  });

  it('DW9 on the wrong network nothing is requested', async () => {
    fw.getNetworkDetails.mockResolvedValue({ network: 'PUBLIC', networkPassphrase: 'Public Global Stellar Network ; September 2015' });
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositError).toBe('Switch Freighter to Testnet. It is on PUBLIC now.');
    expect(api.createDeposit).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    expect(ctl.state.depositStep).toBe('form');
  });

  it('DW10 an expired anchor session signs in again first, with the prompt text on the Balance tab', async () => {
    const ctl = makeCTL({ anchorToken: 'old', anchorTokenExp: Date.now() - 1 });
    let busy: any;
    anchor.anchorLogin.mockImplementationOnce(async () => {
      busy = { depositBusy: ctl.state.depositBusy, remitBusy: ctl.state.remitBusy };
      return { token: 'jwt2', exp: Date.now() + 3_600_000 };
    });
    await deposit.startAddMoney(ctl);
    expect(anchor.anchorLogin.mock.invocationCallOrder[0]).toBeLessThan(anchor.startDeposit.mock.invocationCallOrder[0]);
    expect(busy.depositBusy).toMatch(/^Freighter: your anchor session expired/);
    expect(busy.remitBusy).toBeNull();
    expect(anchor.startDeposit.mock.calls[0][0]).toBe('jwt2');
    expect(ctl.state.remitBusy).toBeNull();
  });

  it('DW19 a declined SEP-10 prompt shows Freighter\'s words, not the anchor copy', async () => {
    fw.signTransaction.mockResolvedValueOnce({ error: { code: -4, message: 'The user rejected this request.' } });
    anchor.anchorLogin.mockImplementationOnce(async (_pk: string, sign: (x: string) => Promise<string>) => {
      await sign('CHALLENGE');
      return { token: 'jwt2', exp: Date.now() + 3_600_000 };
    });
    const ctl = makeCTL({ anchorToken: 'old', anchorTokenExp: Date.now() - 1 });
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositError).toBe('The user rejected this request.');
    expect(ctl.state.depositStep).toBe('form');
    expect(ctl.state.depositBusy).toBeNull();
    expect(api.createDeposit).not.toHaveBeenCalled();
    expect(anchor.startDeposit).not.toHaveBeenCalled();
    // An anchor that does not answer still gets the anchor copy.
    anchor.anchorLogin.mockRejectedValueOnce(new Error('fetch failed'));
    await deposit.startAddMoney(ctl);
    expect(ctl.state.depositError).toBe('The anchor did not answer: fetch failed. Nothing was charged; try again.');
  });

  it('DW15 a disconnect mid-flow lands nothing and links nothing', async () => {
    let release!: (v: any) => void;
    anchor.startDeposit.mockReturnValueOnce(new Promise((r) => (release = r)));
    const ctl = makeCTL();
    const run = deposit.startAddMoney(ctl);
    await vi.waitFor(() => expect(anchor.startDeposit).toHaveBeenCalled());
    remit.cancelRemit();
    deposit.cancelDeposit();
    release({ id: 'ref_1', url: 'https://anchor/page?token=t1' });
    await run;
    expect(api.linkDeposit).not.toHaveBeenCalled();
    expect(api.watchDeposit).not.toHaveBeenCalled();
    expect(ctl.state.depositUrl).toBeNull();
    expect(ctl.state.depositStep).not.toBe('waiting');
  });
});

describe('anchor page and watcher', () => {
  it('DW11 falls back to a link when the browser blocks the window', () => {
    const ctl = makeCTL({ depositUrl: 'https://anchor/page' });
    (window.open as any).mockReturnValueOnce(null);
    deposit.openAnchorPage(ctl);
    expect(ctl.state.depositPopupBlocked).toBe(true);
    deposit.openAnchorPage(ctl);
    expect(window.open).toHaveBeenLastCalledWith('https://anchor/page', 'corra-anchor-deposit', 'width=480,height=720');
    expect(ctl.state.depositPopupBlocked).toBe(false);
  });

  it('DW12 CONFIRMED shows the credit and re-reads the balance once', async () => {
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    const onChange = api.watchDeposit.mock.calls[0][1];
    onChange({ ...DEP, status: 'CONFIRMED', credited: { amount: '600.0000000', asset: 'TESTMXN' } });
    expect(ctl.state.depositStep).toBe('credited');
    expect(ctl.refreshBalances).toHaveBeenCalledTimes(1);
  });

  it('DW13 EXPIRED shows the expired state', async () => {
    const ctl = makeCTL();
    await deposit.startAddMoney(ctl);
    api.watchDeposit.mock.calls[0][1]({ ...DEP, status: 'EXPIRED', reason: 'no credit within 24h' });
    expect(ctl.state.depositStep).toBe('expired');
  });

  it('DW14 resumes the newest waiting deposit; its page only within 9 minutes', async () => {
    const now = Date.now();
    store[KEY] = JSON.stringify({
      dep_old: { ref: 'r0', url: 'https://anchor/old', linked: true, at: now - 3_600_000 },
      dep_1: { ref: 'ref_1', url: 'https://anchor/page', linked: true, at: now - 60_000 },
    });
    api.deposit.mockResolvedValue({ ...DEP, anchorRef: 'ref_1' });
    const fresh = makeCTL();
    await deposit.resumeDeposit(fresh);
    expect(api.deposit).toHaveBeenCalledWith('dep_1');
    expect(fresh.state.depositStep).toBe('waiting');
    expect(fresh.state.depositUrl).toBe('https://anchor/page');
    expect(api.watchDeposit).toHaveBeenCalledWith('dep_1', expect.any(Function), expect.any(Function));

    store[KEY] = JSON.stringify({ dep_1: { ref: 'ref_1', url: 'https://anchor/page', linked: true, at: now - 10 * 60_000 } });
    const old = makeCTL();
    await deposit.resumeDeposit(old);
    expect(old.state.depositStep).toBe('waiting');
    expect(old.state.depositUrl).toBeNull();

    api.deposit.mockResolvedValue({ ...DEP, status: 'CONFIRMED' });
    const done = makeCTL();
    await deposit.resumeDeposit(done);
    expect(done.state.depositStep).toBe('form');
    expect(done.state.deposit).toBeNull();
  });

  it('DW21 a remembered deposit page that is not an http(s) link is not resumed', async () => {
    store[KEY] = JSON.stringify({ dep_1: { ref: 'ref_1', url: 'javascript:alert(1)', linked: true, at: Date.now() - 60_000 } });
    api.deposit.mockResolvedValue({ ...DEP, anchorRef: 'ref_1' });
    const ctl = makeCTL();
    await deposit.resumeDeposit(ctl);
    expect(ctl.state.depositStep).toBe('waiting');
    expect(ctl.state.depositUrl).toBeNull();
  });

  it('DW14b a deposit recorded but never opened at the anchor resumes into the form and is reused', async () => {
    store[KEY] = JSON.stringify({ dep_1: { at: Date.now() - 60_000 } });
    api.deposit.mockResolvedValue(DEP);
    const ctl = makeCTL({ depositAmount: '' });
    await deposit.resumeDeposit(ctl);
    expect(ctl.state.depositStep).toBe('form');
    expect(ctl.state.deposit?.id).toBe('dep_1');
    expect(ctl.state.depositAmount).toBe('600.00');
    expect(ctl.state.depositUrl).toBeNull();
    expect(api.watchDeposit).not.toHaveBeenCalled();
    await deposit.startAddMoney(ctl);
    expect(api.createDeposit).not.toHaveBeenCalled();
    expect(anchor.startDeposit.mock.calls[0][3]).toBe('MEMO=');
    expect(ctl.state.depositStep).toBe('waiting');
  });

  it('DW16 polls every 3 s, then every 10 s after 2 minutes; stops on CONFIRMED, on 404 and after 5 failures', async () => {
    vi.useFakeTimers();
    const ok = (status: string) => ({ ok: true, status: 200, json: async () => ({ ...DEP, status }) });
    const fetch = vi.fn(async () => ok('PENDING'));
    vi.stubGlobal('fetch', fetch);
    const onChange = vi.fn();
    const stop = realApi.watchDeposit('dep_1', onChange);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as any[])[0]).toMatch(/\/deposits\/dep_1$/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(118_000); // t = 121 s: polls at 0, 3, ..., 120
    expect(fetch).toHaveBeenCalledTimes(41);
    await vi.advanceTimersByTimeAsync(8_000); // t = 129 s
    expect(fetch).toHaveBeenCalledTimes(41);
    await vi.advanceTimersByTimeAsync(1_000); // t = 130 s
    expect(fetch).toHaveBeenCalledTimes(42);
    stop();

    // CONFIRMED stops it.
    fetch.mockReset();
    fetch.mockResolvedValueOnce(ok('PENDING')).mockResolvedValue(ok('CONFIRMED'));
    const seen = vi.fn();
    realApi.watchDeposit('dep_1', seen);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(seen.mock.calls.at(-1)![0].status).toBe('CONFIRMED');

    // A 404 stops it and reports.
    fetch.mockReset();
    fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'DEPOSIT_NOT_FOUND', message: 'unknown deposit' } }) } as any);
    const gone = vi.fn();
    realApi.watchDeposit('dep_x', vi.fn(), gone);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(gone).toHaveBeenCalledTimes(1);

    // Five failures in a row stop it and report once.
    fetch.mockReset();
    fetch.mockRejectedValue(new TypeError('network'));
    const lost = vi.fn();
    realApi.watchDeposit('dep_1', vi.fn(), lost);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(lost).toHaveBeenCalledTimes(1);
  });
});

describe('storage and setup', () => {
  it('DW17 keeps the newest 20 deposits and reads garbage as empty', () => {
    for (let i = 0; i < 25; i++) deposit.rememberDeposit(SENDER, 'dep_' + i, { at: 1000 + i });
    const ids = Object.keys(deposit.rememberedDeposits(SENDER));
    expect(ids).toHaveLength(20);
    expect(ids).not.toContain('dep_4');
    expect(ids).toContain('dep_5');
    expect(ids).toContain('dep_24');
    for (const junk of ['not json', '[1,2]', 'null', '{"dep_1":"x"}']) {
      store[KEY] = junk;
      expect(deposit.rememberedDeposits(SENDER), junk).toEqual({});
    }
  });

  it('DW18 setup shows its prompt on the Balance tab and explains the /setup limit', async () => {
    const ctl = makeCTL({ setupDone: false });
    let busy: any;
    api.setup.mockImplementationOnce(async () => {
      busy = { depositBusy: ctl.state.depositBusy, remitBusy: ctl.state.remitBusy };
      throw new ApiError(429, 'RATE_LIMITED', 'too many', true);
    });
    await deposit.setupAccount(ctl);
    expect(busy.depositBusy).toMatch(/^Setting up your account/);
    expect(busy.remitBusy).toBeNull();
    expect(ctl.state.depositBusy).toBeNull();
    expect(ctl.state.depositError).toBe('Too many account setups from this network in the last 10 minutes. Wait a few minutes, then try again.');
  });
});
