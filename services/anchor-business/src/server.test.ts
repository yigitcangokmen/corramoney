import { createHmac } from 'node:crypto';
import * as S from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  buildServer, createPayoutPoller, createPlatformClient, matchWithdrawal, verifyInteractiveJwt, type BusinessConfig, type DistributionPayment, type PlatformClient,
} from './server';

const SECRET = 'test-interactive-secret-0123456789abcdef';
const ISSUER = S.Keypair.random().publicKey();
const ASSET = `stellar:TESTMXN:${ISSUER}`;
const now = () => Math.floor(Date.now() / 1000);

function jwt(claims: object, secret = SECRET, alg = 'HS256') {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ alg, typ: 'JWT' })}.${b64(claims)}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
}

const app = buildServer(
  {
    platformApi: 'http://platform.invalid', jwtSecret: SECRET, horizonUrl: 'https://horizon.invalid',
    networkPassphrase: S.Networks.TESTNET, distributionSecret: S.Keypair.random().secret(),
    assetCode: 'TESTMXN', assetIssuer: ISSUER, moreInfoSecret: 'more-info-secret', withdrawAssetCode: 'TESTPHP',
  },
  { logger: false },
);

describe('verifyInteractiveJwt', () => {
  it('accepts a live token signed with the platform secret', () => {
    expect(verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }), SECRET, now()).jti).toBe('tx1');
  });

  it('rejects a wrong secret, an expired token, a missing transaction id and alg confusion', () => {
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }, 'other-secret'), SECRET, now())).toThrow(/bad signature/);
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() - 1 }), SECRET, now())).toThrow(/expired/);
    expect(() => verifyInteractiveJwt(jwt({ exp: now() + 60 }), SECRET, now())).toThrow(/transaction id/);
    expect(() => verifyInteractiveJwt(jwt({ jti: 'tx1', exp: now() + 60 }, SECRET, 'none'), SECRET, now())).toThrow(/alg/);
  });

  it('the simulate endpoint refuses to move funds without a valid session', async () => {
    const r = await app.inject({ method: 'POST', url: '/sep24/simulate', payload: { token: jwt({ jti: 'x', exp: now() + 60 }, 'forged'), amount: '10' } });
    expect(r.statusCode).toBe(401);
  });
});

describe('SEP-38 /rate callback', () => {
  it('prices MXN <-> TESTMXN at 1:1 with no fee, firm quotes carry id and expiry', async () => {
    const ind = await app.inject({ url: `/rate?type=indicative&sell_asset=iso4217:MXN&buy_asset=${ASSET}&sell_amount=100` });
    expect(ind.json().rate).toEqual({ price: '1', sell_amount: '100', buy_amount: '100', fee: { total: '0', asset: 'iso4217:MXN' } });
    const firm = (await app.inject({ url: `/rate?type=firm&sell_asset=${ASSET}&buy_asset=iso4217:MXN&buy_amount=5.5` })).json().rate;
    expect(firm.buy_amount).toBe('5.5');
    expect(firm.id).toBeTruthy();
    expect(Date.parse(firm.expires_at)).toBeGreaterThan(Date.now());
  });

  it('refuses unknown pairs and ambiguous amounts', async () => {
    expect((await app.inject({ url: `/rate?type=firm&sell_asset=iso4217:USD&buy_asset=${ASSET}&sell_amount=1` })).statusCode).toBe(422);
    expect((await app.inject({ url: `/rate?type=firm&sell_asset=iso4217:MXN&buy_asset=${ASSET}&sell_amount=1&buy_amount=1` })).statusCode).toBe(400);
  });
});

describe('/sep24/simulate is bound to the platform record (audit regression)', () => {
  it('pays only the amount the deposit requested, and only once', async () => {
    const { createServer } = await import('node:http');
    const txs: Record<string, object> = {
      open: { kind: 'deposit', status: 'incomplete', amount_expected: { amount: '334.2600000', asset: ASSET } },
      done: { kind: 'deposit', status: 'completed', amount_expected: { amount: '10.0000000', asset: ASSET } },
    };
    const platform = createServer((req, res) => {
      const id = String(req.url).split('/').pop()!;
      res.writeHead(txs[id] ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(txs[id] ?? {}));
    });
    await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
    const port = (platform.address() as { port: number }).port;
    const bound = buildServer(
      {
        platformApi: `http://127.0.0.1:${port}`, jwtSecret: SECRET, horizonUrl: 'https://horizon.invalid',
        networkPassphrase: S.Networks.TESTNET, distributionSecret: S.Keypair.random().secret(),
        assetCode: 'TESTMXN', assetIssuer: ISSUER, moreInfoSecret: 'more-info-secret', withdrawAssetCode: 'TESTPHP',
      },
      { logger: false },
    );
    const sim = (jti: string, amount: string) =>
      bound.inject({ method: 'POST', url: '/sep24/simulate', payload: { token: jwt({ jti, exp: now() + 60 }), amount } });
    try {
      const more = await sim('open', '1000000');
      expect(more.statusCode).toBe(400);
      expect(more.json().error).toMatch(/requested deposit/);
      expect((await sim('done', '10')).statusCode).toBe(409);
    } finally {
      platform.close();
    }
  });
});

describe('D3 withdrawals (TESTPHP)', () => {
  const MORE = 'more-info-secret';
  const PHP_ASSET = `stellar:TESTPHP:${ISSUER}`;
  const distKey = S.Keypair.random();
  const DIST = distKey.publicKey();
  const cfg: BusinessConfig = {
    platformApi: 'http://platform.invalid', jwtSecret: SECRET, horizonUrl: 'https://horizon.invalid', networkPassphrase: S.Networks.TESTNET,
    distributionSecret: distKey.secret(), assetCode: 'TESTMXN', assetIssuer: ISSUER, moreInfoSecret: MORE, withdrawAssetCode: 'TESTPHP',
  };
  const STARTED = '2026-11-25T00:00:00.000Z';
  const T = Date.parse(STARTED);

  /** A platform with records by id; every RPC is recorded. */
  function fakePlatform(records: Record<string, any>, o: { rpcFails?: boolean; readFails?: boolean } = {}) {
    const rpcs: { method: string; params: any }[] = [];
    const platform: PlatformClient = {
      async rpc(method, params) { rpcs.push({ method, params }); if (o.rpcFails) throw new Error(`${method}: refused`); return {}; },
      async getTransaction(id) { if (o.readFails || !records[id]) throw new Error(`platform GET /transactions/${id}: 404`); return records[id]; },
      async listTransactions(statuses) { return Object.values(records).filter((r) => statuses.includes(r.status)); },
    };
    return { platform, rpcs };
  }
  const withdrawal = (over: object = {}) => ({
    id: 'w1-aaaaaaaa', kind: 'withdrawal', status: 'incomplete', started_at: STARTED, amount_expected: { amount: '1000', asset: PHP_ASSET }, ...over,
  });
  const token = (jti = 'w1-aaaaaaaa', exp = now() + 60) => jwt({ jti, exp });

  it('AB1 interactive: a withdrawal renders the read-only amount and Confirm withdrawal; a deposit still renders the SPEI page', async () => {
    const { platform } = fakePlatform({ 'w1-aaaaaaaa': withdrawal(), d1: { id: 'd1', kind: 'deposit', status: 'incomplete' } });
    const a = buildServer(cfg, { logger: false, platform });
    const w = (await a.inject({ url: `/sep24/interactive?token=${token()}` })).body;
    expect(w).toContain('Withdraw TESTPHP (testnet anchor)');
    expect(w).toContain('1000 TESTPHP');
    expect(w).toContain('Confirm withdrawal');
    expect(w).toContain('simulated cash pickup, Manila');
    expect(w).not.toContain('<input');
    const d = (await a.inject({ url: `/sep24/interactive?token=${token('d1')}&data.amount=10` })).body;
    expect(d).toContain('Simulate SPEI transfer received');
    const none = (await buildServer(cfg, { logger: false, platform: fakePlatform({ 'w1-aaaaaaaa': withdrawal({ amount_expected: undefined }) }).platform })
      .inject({ url: `/sep24/interactive?token=${token()}` })).body;
    expect(none).toContain('This withdrawal has no amount');
    expect(none).not.toContain('Confirm withdrawal');
    expect((await buildServer(cfg, { logger: false, platform: fakePlatform({}, { readFails: true }).platform })
      .inject({ url: `/sep24/interactive?token=${token()}` })).statusCode).toBe(502);
  });

  it('AB2 withdraw-confirm refuses in order, is idempotent on a second click, and sends exactly the request_onchain_funds params once', async () => {
    const records: Record<string, any> = {
      'w1-aaaaaaaa': withdrawal({ amount_expected: { amount: '1000.1234567', asset: PHP_ASSET } }),
      dep: { id: 'dep', kind: 'deposit', status: 'incomplete' },
      anc: withdrawal({ id: 'anc', status: 'pending_anchor' }),
      put: withdrawal({ id: 'put', status: 'pending_user_transfer_start' }),
      mxn: withdrawal({ id: 'mxn', amount_expected: { amount: '10', asset: `stellar:TESTMXN:${ISSUER}` } }),
      zero: withdrawal({ id: 'zero', amount_expected: { amount: '0.5', asset: PHP_ASSET } }),
      big: withdrawal({ id: 'big', amount_expected: { amount: '1000000.0000001', asset: PHP_ASSET } }),
    };
    const { platform, rpcs } = fakePlatform(records);
    const a = buildServer(cfg, { logger: false, platform });
    const confirm = (tok: string) => a.inject({ method: 'POST', url: '/sep24/withdraw-confirm', payload: { token: tok } });
    expect((await confirm(jwt({ jti: 'w1-aaaaaaaa', exp: now() + 60 }, 'forged'))).statusCode).toBe(401);
    expect((await confirm(token('w1-aaaaaaaa', now() - 1))).statusCode).toBe(401);
    expect((await confirm(token('dep'))).statusCode).toBe(409);
    const anc = await confirm(token('anc'));
    expect(anc.statusCode).toBe(409);
    expect(anc.json().error).toBe('withdrawal is already pending_anchor');
    expect((await confirm(token('mxn'))).statusCode).toBe(400);
    expect((await confirm(token('zero'))).statusCode).toBe(400);
    expect((await confirm(token('big'))).statusCode).toBe(400);
    const again = await confirm(token('put'));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ transaction_id: 'put', status: 'pending_user_transfer_start' });
    expect(rpcs).toEqual([]);
    const ok = await confirm(token());
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ transaction_id: 'w1-aaaaaaaa', status: 'pending_user_transfer_start' });
    expect(rpcs).toEqual([{ method: 'request_onchain_funds', params: {
      transaction_id: 'w1-aaaaaaaa', message: 'confirmed by the recipient; waiting for the TESTPHP payment',
      amount_in: { asset: PHP_ASSET, amount: '1000.1234567' }, amount_out: { asset: 'iso4217:PHP', amount: '1000.12' },
      amount_expected: { amount: '1000.1234567' }, fee_details: { total: '0', asset: PHP_ASSET },
    } }]);
    const failing = buildServer(cfg, { logger: false, platform: fakePlatform({ 'w1-aaaaaaaa': withdrawal() }, { rpcFails: true }).platform });
    const r = await failing.inject({ method: 'POST', url: '/sep24/withdraw-confirm', payload: { token: token() } });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/request_onchain_funds/);
  });

  it('AB2d (C6-2) a withdrawal token posted to /sep24/simulate is 409 not a deposit, before any RPC', async () => {
    const { platform, rpcs } = fakePlatform({ 'w1-aaaaaaaa': withdrawal({ amount_expected: { amount: '1000', asset: PHP_ASSET } }) });
    const r = await buildServer(cfg, { logger: false, platform })
      .inject({ method: 'POST', url: '/sep24/simulate', payload: { token: token(), amount: '1000' } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: 'not a deposit' });
    expect(rpcs).toEqual([]);
  });

  it('AB2b (S4-2) a double click: the RPC of the losing confirm fails, the re-read shows pending_user_transfer_start, so 200 not 502', async () => {
    const record = withdrawal();
    const rpcs: string[] = [];
    const platform: PlatformClient = {
      // The other click's request_onchain_funds landed first: this one is refused, the record has moved on.
      async rpc(method) { rpcs.push(method); record.status = 'pending_user_transfer_start'; throw new Error(`${method}: refused`); },
      async getTransaction() { return { ...record }; },
      async listTransactions() { return []; },
    };
    const r = await buildServer(cfg, { logger: false, platform }).inject({ method: 'POST', url: '/sep24/withdraw-confirm', payload: { token: token() } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ transaction_id: 'w1-aaaaaaaa', status: 'pending_user_transfer_start' });
    expect(rpcs).toEqual(['request_onchain_funds']);
  });

  it('AB2c (S4-2) the withdraw page disables Confirm on click and re-enables it only on an error', async () => {
    const { platform } = fakePlatform({ 'w1-aaaaaaaa': withdrawal() });
    const html = (await buildServer(cfg, { logger: false, platform }).inject({ url: `/sep24/interactive?token=${token()}` })).body;
    const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
    const go: any = { disabled: false };
    const out: any = { textContent: '' };
    const run = async (answer: () => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>) => {
      let calls = 0;
      new Function('document', 'fetch', script)({ getElementById: (id: string) => (id === 'go' ? go : out) }, () => { calls++; return answer(); });
      const first = go.onclick();
      expect(go.disabled).toBe(true);
      await first;
      return calls;
    };
    expect(await run(async () => ({ ok: true, status: 200, json: async () => ({}) }))).toBe(1);
    expect(go.disabled).toBe(true);
    expect(out.textContent).toMatch(/^Confirmed/);
    go.disabled = false;
    await run(async () => ({ ok: false, status: 502, json: async () => ({ error: 'refused' }) }));
    expect(go.disabled).toBe(false);
    expect(out.textContent).toBe('Error: refused');
    await run(async () => { throw new Error('offline'); });
    expect(go.disabled).toBe(false);
    expect(out.textContent).toBe('Error: offline');
  });

  const pay = (over: Partial<DistributionPayment> = {}): DistributionPayment => ({
    hash: 'h1', to: DIST, assetCode: 'TESTPHP', assetIssuer: ISSUER, amount: '1000.0000000', memoType: 'id', memo: '881016339300600955',
    at: T + 5000, successful: true, ...over,
  });
  const pending = (over: object = {}) => withdrawal({ status: 'pending_user_transfer_start', memo: '881016339300600955', memo_type: 'id', ...over });
  const PHP = { code: 'TESTPHP', issuer: ISSUER };

  it('AB3 matchWithdrawal: memo, amount, asset and destination; everything else ignored; wrong amount reported', () => {
    expect(matchWithdrawal(pending(), [pay()], DIST, PHP)).toEqual({ kind: 'match', hash: 'h1' });
    for (const other of [
      pay({ memo: '1' }), pay({ assetCode: 'TESTMXN' }), pay({ assetIssuer: S.Keypair.random().publicKey() }), pay({ successful: false }),
      pay({ to: S.Keypair.random().publicKey() }), pay({ at: T - 61_000 }), pay({ memoType: 'none', memo: null }), pay({ memoType: 'text' }),
    ]) expect(matchWithdrawal(pending(), [other], DIST, PHP)).toBeNull();
    const hashHex = 'ab'.repeat(32);
    const b64 = Buffer.from(hashHex, 'hex').toString('base64');
    expect(matchWithdrawal(pending({ memo: hashHex, memo_type: 'hash' }), [pay({ memoType: 'hash', memo: b64 })], DIST, PHP)).toMatchObject({ kind: 'match' });
    expect(matchWithdrawal(pending({ memo: 'pickup', memo_type: 'text' }), [pay({ memoType: 'text', memo: 'pickup' })], DIST, PHP)).toMatchObject({ kind: 'match' });
    expect(matchWithdrawal(pending({ memo: 'pickup', memo_type: 'text' }), [pay({ memoType: 'text', memo: 'Pickup' })], DIST, PHP)).toBeNull();
    expect(matchWithdrawal(pending(), [pay({ amount: '999.9999999' })], DIST, PHP)).toEqual({ kind: 'wrong_amount', hash: 'h1', amount: '999.9999999' });
    expect(matchWithdrawal(pending(), [pay({ hash: 'bad', amount: '1' }), pay({ hash: 'good' })], DIST, PHP)).toEqual({ kind: 'match', hash: 'good' });
  });

  it('AB3 two exact payments with the same memo (newest first, as Horizon lists them): the older one wins, also within one ledger', () => {
    expect(matchWithdrawal(pending(), [pay({ hash: 'copy', at: T + 9000 }), pay({ hash: 'first', at: T + 5000 })], DIST, PHP))
      .toEqual({ kind: 'match', hash: 'first' });
    expect(matchWithdrawal(pending(), [pay({ hash: 'copy' }), pay({ hash: 'first' })], DIST, PHP)).toEqual({ kind: 'match', hash: 'first' });
  });

  function poller(records: Record<string, any>, payments: DistributionPayment[], t = T + 60_000, complete = true) {
    const { platform, rpcs } = fakePlatform(records);
    const asked: number[] = [];
    const logs: any[] = [];
    const p = createPayoutPoller({ cfg, platform,
      chain: { async paymentsTo(account, since) { expect(account).toBe(DIST); asked.push(since); return { payments, complete }; } },
      log: (o) => logs.push(o), now: () => t });
    return { tick: p.tick, rpcs, asked, logs };
  }

  it('AB4 tick: a match is reported received with its hash and amount; a received one completes with a sim-cash-pickup reference', async () => {
    const a = poller({ w: pending({ id: 'w-1111111122' }), r: withdrawal({ id: 'r-2222222233', status: 'pending_anchor' }) }, [pay()]);
    await a.tick();
    expect(a.rpcs).toEqual([
      { method: 'notify_offchain_funds_sent', params: { transaction_id: 'r-2222222233', message: 'cash pickup simulated (testnet)',
        funds_sent_at: new Date(T + 60_000).toISOString(), external_transaction_id: 'sim-cash-pickup-r-222222' } },
      { method: 'notify_onchain_funds_received', params: { transaction_id: 'w-1111111122', message: 'TESTPHP received', stellar_transaction_id: 'h1',
        amount_in: { amount: '1000' } } },
    ]);
    expect(a.asked).toEqual([T - 60_000]);
  });

  it('AB4b a deposit in either status is never touched', async () => {
    const a = poller({
      d1: { id: 'd1', kind: 'deposit', status: 'pending_anchor', started_at: STARTED, amount_expected: { amount: '1000', asset: `stellar:TESTMXN:${ISSUER}` } },
      d2: { id: 'd2', kind: 'deposit', status: 'pending_user_transfer_start', started_at: STARTED, memo: '881016339300600955', memo_type: 'id',
        amount_expected: { amount: '1000', asset: PHP_ASSET } },
    }, [pay()]);
    await a.tick();
    expect(a.rpcs).toEqual([]);
    expect(a.asked).toEqual([]);
  });

  it('AB4c a wrong amount is one notify_transaction_error', async () => {
    const a = poller({ w: pending() }, [pay({ amount: '1' })]);
    await a.tick();
    expect(a.rpcs).toEqual([{ method: 'notify_transaction_error', params: {
      transaction_id: 'w1-aaaaaaaa', message: 'payment h1 of 1 TESTPHP does not match the expected 1000' } }]);
  });

  it('AB4d unpaid after 24 hours expires; RPC errors are logged, not thrown', async () => {
    const a = poller({ w: pending() }, [], T + 24 * 3_600_000 + 1);
    await a.tick();
    expect(a.rpcs).toEqual([{ method: 'notify_transaction_expired', params: { transaction_id: 'w1-aaaaaaaa', message: 'no payment within 24 hours' } }]);
    const logs: object[] = [];
    const { platform } = fakePlatform({ w: pending() }, { rpcFails: true });
    await createPayoutPoller({ cfg, platform, chain: { paymentsTo: async () => ({ payments: [pay()], complete: true }) }, log: (o) => logs.push(o), now: () => T + 60_000 }).tick();
    expect(logs).toContainEqual(expect.objectContaining({ evt: 'withdraw.rpc_failed', id: 'w1-aaaaaaaa' }));
  });

  it('AB4h (S5-1) a failing RPC logs withdraw.rpc_failed and never the success event', async () => {
    for (const [records, payments, ok] of [
      [{ r: withdrawal({ id: 'r-2222222233', status: 'pending_anchor' }) }, [], 'withdraw.paid_out'],
      [{ w: pending() }, [pay()], 'withdraw.received'],
      [{ w: pending() }, [pay({ amount: '1' })], 'withdraw.mismatch'],
    ] as const) {
      const logs: any[] = [];
      const { platform } = fakePlatform(records as any, { rpcFails: true });
      await createPayoutPoller({ cfg, platform, chain: { paymentsTo: async () => ({ payments: [...payments], complete: true }) },
        log: (o) => logs.push(o), now: () => T + 60_000 }).tick();
      expect(logs.map((l) => l.evt)).toContain('withdraw.rpc_failed');
      expect(logs.map((l) => l.evt)).not.toContain(ok);
    }
  });

  it('AB4i (S5-4) the payment window did not reach back to the start: an old unmatched withdrawal is not expired, and that is logged', async () => {
    const a = poller({ w: pending() }, [], T + 24 * 3_600_000 + 1, false);
    await a.tick();
    expect(a.rpcs).toEqual([]);
    expect(a.logs).toContainEqual(expect.objectContaining({ evt: 'withdraw.window_incomplete' }));
    // A match found within the truncated window is still reported.
    const b = poller({ w: pending() }, [pay()], T + 24 * 3_600_000 + 1, false);
    await b.tick();
    expect(b.rpcs.map((r: any) => r.method)).toEqual(['notify_onchain_funds_received']);
  });

  it('AB4f (C3-3) older than 24 hours but paid: reported received, not expired; the payment window reaches back to its start', async () => {
    const a = poller({ w: pending() }, [pay()], T + 24 * 3_600_000 + 1);
    await a.tick();
    expect(a.rpcs).toEqual([{ method: 'notify_onchain_funds_received', params: { transaction_id: 'w1-aaaaaaaa', message: 'TESTPHP received',
      stellar_transaction_id: 'h1', amount_in: { amount: '1000' } } }]);
    expect(a.asked).toEqual([T - 60_000]);
  });

  it('AB4g (S3-3) a withdrawal of another asset (TESTMXN, or TESTPHP of another issuer) in either status is never touched', async () => {
    const other = S.Keypair.random().publicKey();
    const records: Record<string, any> = {};
    for (const [n, asset] of [['m', `stellar:TESTMXN:${ISSUER}`], ['o', `stellar:TESTPHP:${other}`]]) {
      records[n + '1'] = pending({ id: n + '1', amount_expected: { amount: '1000', asset } });
      records[n + '2'] = withdrawal({ id: n + '2', status: 'pending_anchor', amount_expected: { amount: '1000', asset } });
    }
    const a = poller(records, [pay(), pay({ assetCode: 'TESTMXN' }), pay({ assetIssuer: other })]);
    await a.tick();
    expect(a.rpcs).toEqual([]);
    expect(a.asked).toEqual([]);
  });

  it('AB4e more than one page of open withdrawals: the platform client reads every page, and the newest (paid) one is reported received', async () => {
    // 120 open withdrawals, oldest first; only the newest is paid. The platform pages by page_size and 0-based page_number.
    const open = Array.from({ length: 120 }, (_, i) => pending({ id: `w-${String(i).padStart(4, '0')}-xxxx`, memo: String(1000 + i) }));
    const fetched: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') return new Response(JSON.stringify([{ jsonrpc: '2.0', id: 1, result: {} }]));
      const q = new URL(url).searchParams;
      fetched.push(`${q.get('page_number')}/${q.get('page_size')}`);
      const size = Number(q.get('page_size') ?? 20);
      const page = Number(q.get('page_number') ?? 0);
      return new Response(JSON.stringify({ records: open.slice(page * size, (page + 1) * size) }));
    }));
    try {
      const rpcs: string[] = [];
      const real = createPlatformClient('http://platform.invalid');
      const platform: PlatformClient = { ...real, async rpc(method, params) { rpcs.push(`${method}:${params.transaction_id}`); return {}; } };
      await createPayoutPoller({ cfg, platform, chain: { paymentsTo: async () => ({ payments: [pay({ memo: '1119', hash: 'newest' })], complete: true }) }, log: () => {}, now: () => T + 60_000 }).tick();
      expect(fetched).toEqual(['0/50', '1/50', '2/50']);
      expect(rpcs).toEqual(['notify_onchain_funds_received:w-0119-xxxx']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('AB5 more_info: a valid signature with an expired exp renders; bad signature, wrong aud, transaction_id != jti -> 401; HTML-escaped', async () => {
    const { platform } = fakePlatform({ 'w1-aaaaaaaa': withdrawal({
      status: 'completed', destination_account: DIST, stellar_transactions: [{ id: 'abc123' }], external_transaction_id: '<b>sim</b>',
      amount_in: { amount: '1000', asset: PHP_ASSET }, amount_out: { amount: '1000', asset: 'iso4217:PHP' }, completed_at: '2026-11-25T00:01:00Z',
    }) });
    const a = buildServer(cfg, { logger: false, platform });
    const more = (claims: object, secret = MORE, q = '') => a.inject({ url: `/sep24/more_info?token=${jwt(claims, secret)}${q}` });
    const ok = await more({ jti: 'w1-aaaaaaaa', exp: now() - 3600, aud: ['sep24_more_info'] }, MORE, '&transaction_id=w1-aaaaaaaa');
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('completed');
    expect(ok.body).toContain(DIST);
    expect(ok.body).toContain('https://stellar.expert/explorer/testnet/tx/abc123');
    expect(ok.body).toContain('&#60;b&#62;sim&#60;/b&#62;');
    expect(ok.body).not.toContain('<b>sim</b>');
    expect(ok.body).toContain('Payout simulated (testnet). No cash moved.');
    expect((await more({ jti: 'w1-aaaaaaaa', exp: now() + 60 }, 'forged')).statusCode).toBe(401);
    expect((await more({ jti: 'w1-aaaaaaaa', aud: ['sep24_interactive'] })).statusCode).toBe(401);
    expect((await more({ jti: 'w1-aaaaaaaa' }, MORE, '&transaction_id=other')).statusCode).toBe(401);
  });
});
