import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
  accountPayments: vi.fn(),
  accountDeposits: vi.fn(),
  accountPoolOps: vi.fn(),
  payment: vi.fn(),
}));
vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), api }));

const { ApiError } = await import('./api');
const { cashOutNote, depositNote, loadHistory, mergeHistory, needsRefresh, safeLink } = await import('./history');

const ME = 'GDSPQYYAUDROEMIS2R62ARTXB45DY4RBCY4AU35AEEGG4MKPQUSOXONR';
const pay = (id: string, createdAt: number, state = 'CREDITED'): any => ({ id, publicId: 'CORRA-' + id, kind: 'balance', state, createdAt });
const dep = (id: string, createdAt: number, status = 'CONFIRMED'): any => ({ id, status, createdAt });

let store: Record<string, string>;

beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; } });
  api.accountPayments.mockResolvedValue({ payments: [] });
  api.accountDeposits.mockResolvedValue({ deposits: [] });
  api.accountPoolOps.mockResolvedValue({ ops: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe('history', () => {
  it('H1 merges sent, received and deposits newest first, each with its type', () => {
    const rows = mergeHistory([pay('a', 10)], [pay('b', 30)], [dep('d', 20)]);
    expect(rows.map((r) => [r.type, r.at])).toEqual([['received', 30], ['deposit', 20], ['sent', 10]]);
  });

  it('H2 a self-send appears once, as sent', () => {
    const rows = mergeHistory([pay('a', 10)], [pay('a', 10)], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('sent');
  });

  it('H3 only http and https links survive', () => {
    expect(safeLink('https://anchor.example/more_info?x=1')).toBe('https://anchor.example/more_info?x=1');
    expect(safeLink('http://localhost:8091/sep24/more_info')).toBe('http://localhost:8091/sep24/more_info');
    for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'not a url', '', null]) expect(safeLink(bad as any), String(bad)).toBeNull();
  });

  it('H4 keeps refreshing while a payment settles or a deposit waits', () => {
    expect(needsRefresh(mergeHistory([pay('a', 1)], [], [dep('d', 2)]))).toBe(false);
    expect(needsRefresh(mergeHistory([pay('a', 1, 'ONCHAIN')], [], []))).toBe(true);
    expect(needsRefresh(mergeHistory([], [], [dep('d', 2, 'PENDING')]))).toBe(true);
    expect(needsRefresh(mergeHistory([], [], [dep('d', 2, 'EXPIRED')]))).toBe(false);
  });

  it('H5 an orchestrator without the account list falls back to the payments remembered here', async () => {
    store['corra_payments_' + ME] = JSON.stringify(['p1', 'p2']);
    api.accountPayments.mockImplementation(async (_a: string, role: string) => {
      throw new ApiError(404, 'HTTP_404', 'Not Found');
    });
    api.accountDeposits.mockRejectedValue(new ApiError(404, 'HTTP_404', 'Not Found'));
    api.payment.mockImplementation(async (id: string) => {
      if (id === 'p2') throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'gone');
      return pay(id, 5);
    });
    const h = await loadHistory(ME);
    expect(api.payment).toHaveBeenCalledTimes(2);
    expect(h.rows.map((r) => r.type === 'sent' && r.p.id)).toEqual(['p1']);
    expect(h.unreachable).toBe(0);
  });

  it('H6 one unreachable list is counted; the other rows still show', async () => {
    api.accountPayments.mockImplementation(async (_a: string, role: string) => (role === 'sender'
      ? { payments: [pay('a', 10)] }
      : Promise.reject(new ApiError(0, 'UNREACHABLE', 'down', true))));
    api.accountDeposits.mockResolvedValue({ deposits: [dep('d', 20)] });
    const h = await loadHistory(ME);
    expect(h.unreachable).toBe(1);
    expect(h.rows.map((r) => r.type)).toEqual(['deposit', 'sent']);
    expect(api.payment).not.toHaveBeenCalled();
  });

  it('H7 a waiting deposit with a partial chain credit says how much arrived so far', () => {
    const base: any = { status: 'PENDING', requested: { amount: '600.0000000', asset: 'TESTMXN' }, credited: null, reason: null };
    expect(depositNote(base)).toBe('');
    expect(depositNote({ ...base, credited: { amount: '450.0000000', asset: 'TESTMXN' } })).toBe('credited 450.00 of 600.00 so far');
    expect(depositNote({ ...base, status: 'CONFIRMED', credited: { amount: '450.0000000', asset: 'TESTMXN' }, reason: 'short credit' }))
      .toBe('credited 450.00 of 600.00 (short credit)');
    expect(depositNote({ ...base, status: 'EXPIRED' })).toBe('no payment within 24 hours');
  });

  it('H8 pool rows merge by time with their link; 404/503 add no row and no unreachable; 500 counts; SUBMITTED needs a refresh', async () => {
    const op = (id: string, createdAt: number, status = 'SUCCESS', kind = 'supply'): any => ({
      id, kind, status, createdAt, txHash: 'ab'.repeat(32), amount: { amount: '20.0000000', asset: 'TESTMXN' }, resultCode: null, ledger: 7,
    });
    api.accountPayments.mockImplementation(async (_a: string, role: string) => ({ payments: role === 'sender' ? [pay('a', 10)] : [] }));
    api.accountDeposits.mockResolvedValue({ deposits: [dep('d', 20)] });
    api.accountPoolOps.mockResolvedValue({ ops: [op('w', 40, 'SUCCESS', 'withdraw'), op('s', 30)] });
    const h = await loadHistory(ME);
    expect(api.accountPoolOps).toHaveBeenCalledWith(ME, 20);
    expect(h.rows.map((r) => [r.type, r.at])).toEqual([['pool', 40], ['pool', 30], ['deposit', 20], ['sent', 10]]);
    expect(h.unreachable).toBe(0);
    expect(needsRefresh(h.rows)).toBe(false);
    expect(needsRefresh(mergeHistory([], [], [], [op('p', 1, 'SUBMITTED')]))).toBe(true);

    for (const status of [404, 503]) {
      api.accountPoolOps.mockRejectedValueOnce(new ApiError(status, 'POOL_NOT_CONFIGURED', 'no pool'));
      const none = await loadHistory(ME);
      expect(none.unreachable).toBe(0);
      expect(none.rows.some((r) => r.type === 'pool')).toBe(false);
    }
    api.accountPoolOps.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'boom'));
    expect((await loadHistory(ME)).unreachable).toBe(1);
  });

  it('H9 a pool row links and names Corra\'s fee only once it reached a ledger; a withdraw shows its amount as an upper bound', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PoolRow } = await import('../components/History');
    const row = (o: object) => renderToStaticMarkup(createElement(PoolRow, { r: { type: 'pool', at: 1, o: {
      id: 'pop_1', kind: 'supply', status: 'SUCCESS', createdAt: 1, txHash: 'ab'.repeat(32), amount: { amount: '20.0000000', asset: 'TESTMXN' },
      resultCode: null, ledger: 7, ...o } } as any }));

    const landed = row({});
    expect(landed).toContain('stellar.expert/explorer/testnet/tx/' + 'ab'.repeat(32));
    expect(landed).toContain('fee paid by Corra · ledger 7');
    expect(landed).toContain('>20.00 TESTMXN<');

    const neverLanded = row({ status: 'FAILED', resultCode: 'tx_bad_seq', ledger: null });
    expect(neverLanded).not.toContain('stellar.expert');
    expect(neverLanded).not.toContain('fee paid by Corra');
    expect(neverLanded).toContain('tx_bad_seq');
    expect(neverLanded).toContain('>Failed<');

    // The RPC no longer held the submit's ledger: the row must not claim it failed.
    const unknown = row({ status: 'FAILED', resultCode: 'unknown', ledger: null });
    expect(unknown).toContain('>Check the position<');
    expect(unknown).toContain('Corra could not find out whether this landed. Check the position.');
    expect(unknown).not.toContain('>Failed<');

    // 'all' asks ceil(1.01 x position): the pool clamps, so the stored amount is what was asked, not what moved.
    expect(row({ kind: 'withdraw', amount: { amount: '20.2000000', asset: 'TESTMXN' } })).toContain('up to 20.20 TESTMXN');
    // Pool amounts carry up to 7 decimals: a sub-cent move must not show as 0.00 or round up to 0.01.
    expect(row({ amount: { amount: '0.0040000', asset: 'TESTMXN' } })).toContain('>0.004 TESTMXN<');
    expect(row({ amount: { amount: '0.0050000', asset: 'TESTMXN' } })).toContain('>0.005 TESTMXN<');
    expect(row({ amount: { amount: '1.2345678', asset: 'TESTMXN' } })).toContain('>1.2345678 TESTMXN<');
  });
});

describe('cash-out note (D3)', () => {
  const withLeg = (leg: object | null): any => ({ id: 'p', legs: leg ? [{ kind: 'cash_out', ...leg }] : [] });
  it('HC1 Cashed out for an anchor-confirmed leg, Phase 1 mock payout for a mock ref, nothing otherwise', () => {
    expect(cashOutNote(withLeg({ status: 'CONFIRMED', externalRef: 'w-1' }))).toBe('Cashed out');
    expect(cashOutNote(withLeg({ status: 'CONFIRMED', externalRef: 'mock-payout:CORRA-OLD' }))).toBe('Phase 1 mock payout');
    expect(cashOutNote(withLeg({ status: 'PENDING', externalRef: 'w-1', txHash: 'h' }))).toBe('');
    expect(cashOutNote(withLeg(null))).toBe('');
  });
});
