/**
 * Integration tests: HTTP API + saga + real Postgres. Needs `docker compose up -d postgres`.
 * The chain is faked (FakeGateway) so the tests are deterministic and offline.
 */
import * as S from '@stellar/stellar-sdk';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cashInMemo, fiatAsset, fromDecimal, moneyFromWire, type AssetId, type Money, type Payment, type Quote } from '@corra/shared';
import {
  assertPaymentAccountSetup, buildCashOutPayment, buildStrictReceive, ChannelRefusal, createChannels, createSponsor, type Deposit, type PathResult, type PoolChain, type PoolLanded, type PoolScope, type PoolSendOutcome,
  type Sponsor, type StellarGateway, type SubmitOutcome,
} from '@corra/stellar';
import { createCashOuts, createDeposits, createSaga, DEPOSIT_CADENCE, InMemoryDepositStore, SagaError, type DepositStore } from '@corra/settlement-saga';
import { buildApp, LOCAL_SETUP_LIMITS } from './app';
import { parseSep24Callback } from './callback';
import { createClientDomainSigner } from './client-domain';
import { PostgresDepositStore } from './db/deposit-store';
import { createDbPool } from './db/pool';
import { PostgresPoolOpStore } from './db/pool-store';
import { migrate, PostgresSagaStore } from './db/store';
import { createPoolOps, POOL_OP_LOST_MS, type PoolOps } from './pool-ops';
import { drainAndClose } from './reconcile-loop';
import { createPrepareSetup, type SetupChain } from './setup';
import * as PF from '../../../packages/stellar/test/pool-fixtures';

const NP = S.Networks.TESTNET;
const ISSUER = S.Keypair.random().publicKey();
const ANCHOR_DIST = S.Keypair.random().publicKey();
const anchorKey = S.Keypair.random();
const clientDomainKey = S.Keypair.random();
const USDC = { code: 'USDC', issuer: S.Keypair.random().publicKey() };
const MXN = { code: 'TESTMXN', issuer: ISSUER };
const HOST = 'host.docker.internal:8787';
/** The sender's payment account: the transaction source of its payments. */
const PAY = S.Keypair.random().publicKey();
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://corra:corra@localhost:5434/corra';
/** Per-run database names, so two runs on one Postgres never share (or drop) each other's database. */
const RUN = String(process.pid);
const dbName = (name: string) => `${name}_${RUN}`;
const urlOf = (name: string) => BASE_URL.replace(/\/[^/]+$/, `/${name}`);
/** Every app a test builds; all are closed (and their background work drained) before the next TRUNCATE. */
const opened: { close(): Promise<unknown> }[] = [];
const track = <A extends { close(): Promise<unknown> }>(a: A) => (opened.push(a), a);

class FakeGateway implements StellarGateway {
  route: PathResult | null = { path: [USDC], source: fromDecimal(MXN, '329.3190139') };
  deposits: (Deposit & { memo: string })[] = [];
  landed = new Map<string, 'SUCCESS' | 'FAILED'>();
  submits = 0;
  /** The sender's spendable TESTMXN. */
  balance: Money | null = fromDecimal(MXN, '10000');
  /** What accountSequence reports for the payment account; 0 keeps a presigned blob inside its window. */
  sequence: bigint | null = 0n;
  trusts = true;
  /** Hash memo per transaction hash, as getTransaction reports it. */
  memos = new Map<string, string>();
  /** When set, submissions wait for it. */
  gate: Promise<void> | null = null;
  /** The next submission lands FAILED (op_underfunded). */
  failNext = false;
  async findStrictReceivePath() { return this.route; }
  async findDeposit({ memo }: { memo?: string }) { return this.deposits.find((d) => memo === undefined || d.memo === memo) ?? null; }
  async accountTrusts() { return this.trusts; }
  async accountSequence() { return this.sequence; }
  /** The sender's payment account; null = none. */
  paymentAccount: string | null = PAY;
  async paymentAccountOf() { return this.paymentAccount; }
  async isPaymentAccountOf(account: string) { return account === this.paymentAccount; }
  async accountBalance() { return this.balance; }
  async getTransaction(h: string) {
    const s = this.landed.get(h);
    const memo = this.memos.get(h);
    return s ? { status: s, ledger: 1, ...(memo ? { memoHash: memo } : {}) } : { status: 'NOT_FOUND' as const };
  }
  async submitPayment(xdr: string): Promise<SubmitOutcome> {
    this.submits++;
    if (this.gate) await this.gate;
    await new Promise((r) => setTimeout(r, 20));
    const inner = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    const hash = Array.from(inner.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
    if (this.failNext) {
      this.failNext = false;
      this.landed.set(hash, 'FAILED');
      return { kind: 'failed', hash, codes: { operations: ['op_underfunded'] } };
    }
    this.landed.set(hash, 'SUCCESS');
    return { kind: 'success', hash, ledger: 1 };
  }
}

let pool: pg.Pool;
let gw: FakeGateway;
let store: PostgresSagaStore;
let app: ReturnType<typeof buildApp>;
const sender = S.Keypair.random();
const recipient = S.Keypair.random().publicKey();
/** The cash-out (D3) on the test store; the anchor distribution account and TESTPHP of the test issuer. */
const makeCashOuts = (g: StellarGateway = gw) => createCashOuts({
  store, gateway: g, networkPassphrase: NP, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: { code: 'TESTPHP', issuer: ISSUER },
});

/** True while `pid` is a live process on this host. */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: BASE_URL });
  admin.on('error', () => {});
  // A crashed or interrupted run leaves its databases behind: drop those whose run is gone, never a live run's.
  const left = (await admin.query("SELECT datname FROM pg_database WHERE datname ~ '^corra_(test|upgrade[23]?)_[0-9]+$'")).rows;
  for (const { datname } of left) {
    if (!alive(Number(datname.slice(datname.lastIndexOf('_') + 1)))) await admin.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
  }
  // The fixed names of older runs: without FORCE, a database another session still uses is refused and kept.
  for (const legacy of ['corra_test', 'corra_upgrade', 'corra_upgrade2', 'corra_upgrade3']) {
    await admin.query(`DROP DATABASE IF EXISTS ${legacy}`).catch(() => {});
  }
  await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_test')} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName('corra_test')}`);
  await admin.end();
  // pool.end() resolves before its sockets close: afterAll's FORCE drop may end a backend that has not
  // exited yet, and that 57P01 must not surface as an uncaught pool error (C2-1).
  pool = createDbPool(urlOf(dbName('corra_test')), () => {});
  await migrate(pool);
}, 60_000);

afterEach(async () => { await Promise.all(opened.splice(0).map((a) => a.close())); });

afterAll(async () => {
  await Promise.all(opened.splice(0).map((a) => a.close()));
  await app?.close();
  await pool?.end();
  const admin = new pg.Pool({ connectionString: BASE_URL });
  admin.on('error', () => {});
  await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_test')} WITH (FORCE)`);
  await admin.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE payment_events, legs, payments, quotes, deposits, pool_ops CASCADE');
  gw = new FakeGateway();
  store = new PostgresSagaStore(pool);
  const saga = createSaga({
    store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER,
    anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor',
  });
  const deposits = createDeposits({
    store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: fiatAsset('MXN'),
  });
  app = track(buildApp({
    saga, deposits, cashOuts: makeCashOuts(), networkPassphrase: NP, corsOrigins: ['http://localhost:5180'],
    clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
    anchorSigningKey: async () => anchorKey.publicKey(),
    // As createPrepareSetup: the account's own setup takes its rate-limit token first.
    prepareSetup: async (_account, _trust, _paymentAccount, admit) => {
      if (admit && !admit()) throw new SagaError('RATE_LIMITED', 429, 'too many requests, try again later', true);
      return { xdr: 'unused' };
    },
  }));
});

const quoteBody = { corridor: { from: 'MX/MXN', to: 'PH/PHP' }, destAmount: { amount: '1000', asset: 'TESTPHP', issuer: ISSUER } };

async function quoteAndSign() {
  const q = (await app.inject({ method: 'POST', url: '/quote', payload: quoteBody })).json();
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: '100', recipient,
    dest: moneyFromWire(q.dest), sendMax: moneyFromWire(q.maxSend), path: q.path, now: Math.floor(Date.now() / 1000),
  });
  tx.sign(sender);
  return { q, signedXdr: tx.toXDR() };
}

const confirm = (payload: object, key?: string) =>
  app.inject({ method: 'POST', url: '/confirm', payload, headers: key ? { 'idempotency-key': key } : {} });

function signedCallback(body: object, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const sig = anchorKey.sign(Buffer.from(`${t}.${HOST}.${raw}`));
  return {
    method: 'POST' as const, url: '/callbacks/sep24', payload: raw,
    headers: { 'content-type': 'application/json', host: HOST, signature: `t=${t}, s=${Buffer.from(sig).toString('base64')}` },
  };
}

const waitFor = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('timed out');
};

describe('HTTP lifecycle on Postgres', () => {
  it('quote -> confirm -> link cash-in -> signed callback -> CREDITED, with a gapless timeline', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const created = await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k1');
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p.state).toBe('SIGNED');
    expect(p.kind).toBe('cash_in');
    expect(p).not.toHaveProperty('signedXdr');
    expect(p).not.toHaveProperty('idemKey');

    const replay = await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(p.id);

    await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'ap-tx-1' } });
    gw.deposits.push({ hash: 'dep1', amount: moneyFromWire(q.maxSend) as Money, at: Date.now(), memo: await cashInMemo(p.id) });

    const cb = await app.inject(signedCallback({ transaction: { id: 'ap-tx-1', kind: 'deposit', status: 'completed' } }));
    expect(cb.statusCode).toBe(200);

    await waitFor(async () => (await app.inject({ url: `/payments/${p.id}` })).json().state === 'CREDITED');
    const done = (await app.inject({ url: `/payments/${p.id}` })).json();
    expect(done.events.map((e: any) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(done.legs.find((l: any) => l.kind === 'onchain').status).toBe('CONFIRMED');
    // OC1 CREDITED: the recipient holds the asset; the cash-out leg waits for the recipient's withdrawal.
    const cashOut = done.legs.find((l: any) => l.kind === 'cash_out');
    expect(cashOut).toMatchObject({ status: 'PENDING', anchorId: 'corra-anchor', amount: q.dest });
    expect(cashOut).not.toHaveProperty('externalRef');
    expect(done.events.at(-1).data).not.toHaveProperty('payoutRef');
    expect(gw.submits).toBe(1);
    // The id people see works as well as the internal one.
    const byPublic = (await app.inject({ url: `/payments/${done.publicId}` })).json();
    expect(byPublic.id).toBe(p.id);
  });

  it('maps saga errors to the documented HTTP codes', async () => {
    const { q, signedXdr } = await quoteAndSign();
    expect((await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr })).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const wrong = await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient: S.Keypair.random().publicKey(), signedXdr }, 'k2');
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('UNBOUND_TRANSACTION');

    expect((await confirm({ quoteId: 'qt_nope', sender: sender.publicKey(), recipient, signedXdr }, 'k3')).statusCode).toBe(404);

    const badRef = await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr, anchorQuote: { id: 42 } }, 'k-bad-aq');
    expect(badRef.statusCode).toBe(400);
    const withRef = await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr, anchorQuote: { id: 'ap-quote-1', expiresAt: 1_900_000_000_000 } }, 'k-aq');
    expect(withRef.statusCode).toBe(201);
    expect(withRef.json().quote).toMatchObject({ anchorQuoteId: 'ap-quote-1', anchorQuoteExpiresAt: 1_900_000_000_000 });

    gw.route = null;
    const noPath = await app.inject({ method: 'POST', url: '/quote', payload: quoteBody });
    expect(noPath.statusCode).toBe(422);
    expect(noPath.json().error).toMatchObject({ code: 'NO_PATH', retriable: true });
  });
});

describe('Postgres progress protocol', () => {
  it('concurrent transitions from the same state: exactly one wins, no duplicate events', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k4')).json();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.transition(p.id, 'SIGNED', 'CASH_IN', { legs: [{ kind: 'cash_in', status: 'CONFIRMED' }] },
          { type: 'CASH_IN', from: 'SIGNED', to: 'CASH_IN' })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await store.events(p.id)).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('duplicate callbacks submit once (T5) and a lost callback is recovered by the reconciler (T4)', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k5')).json();
    await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'ap-tx-5' } });
    gw.deposits.push({ hash: 'dep5', amount: moneyFromWire(q.maxSend), at: Date.now(), memo: await cashInMemo(p.id) });
    const body = { transaction: { id: 'ap-tx-5', kind: 'deposit', status: 'completed' } };
    await Promise.all([app.inject(signedCallback(body)), app.inject(signedCallback(body)), app.inject(signedCallback(body))]);
    await waitFor(async () => (await store.getPayment(p.id))!.state === 'CREDITED');
    expect(gw.submits).toBe(1);
  });
});

describe('callback authentication', () => {
  const body = { transaction: { id: 'x', kind: 'deposit', status: 'completed' } };

  it('rejects missing, forged and stale signatures', async () => {
    const unsigned = await app.inject({ method: 'POST', url: '/callbacks/sep24', payload: body, headers: { host: HOST } });
    expect(unsigned.statusCode).toBe(401);

    const forged = signedCallback(body);
    forged.headers.signature = forged.headers.signature.replace(/s=.*/, `s=${Buffer.from(S.Keypair.random().sign(Buffer.from('x'))).toString('base64')}`);
    expect((await app.inject(forged)).statusCode).toBe(401);

    const tampered = signedCallback(body);
    tampered.payload = JSON.stringify({ transaction: { id: 'other', kind: 'deposit', status: 'completed' } });
    expect((await app.inject(tampered)).statusCode).toBe(401);

    expect((await app.inject(signedCallback(body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
    expect((await app.inject(signedCallback(body))).statusCode).toBe(200);
  });
});

describe('client_domain co-signing', () => {
  it('publishes its SIGNING_KEY and co-signs a real SEP-10 challenge', async () => {
    const toml = (await app.inject({ url: '/.well-known/stellar.toml' })).body;
    expect(toml).toContain(`SIGNING_KEY="${clientDomainKey.publicKey()}"`);

    const challenge = S.WebAuth.buildChallengeTx(
      anchorKey, sender.publicKey(), 'anchor.test', 300, NP, 'anchor.test', undefined, 'corra.test', clientDomainKey.publicKey(),
    );
    const r = await app.inject({ method: 'POST', url: '/sep10/client-domain', payload: { transaction: challenge } });
    expect(r.statusCode).toBe(200);
    const signed = S.TransactionBuilder.fromXDR(r.json().transaction, NP) as S.Transaction;
    expect(signed.signatures).toHaveLength(2); // anchor + client domain
  });

  it('refuses to sign anything that is not a SEP-10 challenge from the anchor', async () => {
    const payment = new S.TransactionBuilder(new S.Account(anchorKey.publicKey(), '0'), { fee: '100', networkPassphrase: NP })
      .addOperation(S.Operation.payment({ destination: recipient, asset: S.Asset.native(), amount: '1', source: clientDomainKey.publicKey() }))
      .setTimeout(30).build().toXDR();
    const r = await app.inject({ method: 'POST', url: '/sep10/client-domain', payload: { transaction: payment } });
    expect(r.statusCode).toBe(422);

    const foreign = S.WebAuth.buildChallengeTx(
      S.Keypair.random(), sender.publicKey(), 'evil.test', 300, NP, 'evil.test', undefined, 'corra.test', clientDomainKey.publicKey(),
    );
    expect((await app.inject({ method: 'POST', url: '/sep10/client-domain', payload: { transaction: foreign } })).statusCode).toBe(422);
  });
});

describe('Postgres hardening (audit regressions)', () => {
  it('concurrent confirms with the same Idempotency-Key all get the same payment', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const body = { quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr };
    const rs = await Promise.all(Array.from({ length: 5 }, () => confirm(body, 'k-race')));
    expect(rs.map((r) => r.statusCode).every((c) => c === 200 || c === 201)).toBe(true);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
  });

  it('a cash-in reference is write-once and cannot be reused by another payment', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-link')).json();
    expect((await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'r1' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'r1' } })).statusCode).toBe(200);
    const relink = await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'r2' } });
    expect(relink.statusCode).toBe(409);
    expect(relink.json().error.code).toBe('CASH_IN_ALREADY_LINKED');
  });

  it('the database refuses to reopen a terminal payment or rewrite the timeline', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-term')).json();
    await pool.query("UPDATE payments SET state = 'EXPIRED', signed_xdr = NULL WHERE id = $1", [p.id]);
    await expect(pool.query("UPDATE payments SET state = 'SIGNED' WHERE id = $1", [p.id])).rejects.toThrow(/terminal/);
    await expect(pool.query("UPDATE payments SET state = 'BOGUS' WHERE id = $1", [p.id])).rejects.toThrow();
    await expect(pool.query('DELETE FROM payment_events WHERE payment_id = $1', [p.id])).rejects.toThrow(/append-only/);
    await expect(pool.query('UPDATE payment_events SET seq = 99 WHERE payment_id = $1', [p.id])).rejects.toThrow(/append-only/);
  });

  it('one signed transaction cannot back two payments', async () => {
    const { q, signedXdr } = await quoteAndSign();
    await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-tx1');
    const q2 = (await app.inject({ method: 'POST', url: '/quote', payload: quoteBody })).json();
    const r = await confirm({ quoteId: q2.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-tx2');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('DUPLICATE_TRANSACTION');
  });
});

describe('API hardening (audit regressions)', () => {
  it('/setup accepts only one or two distinct known corridor codes', async () => {
    const acct = S.Keypair.random().publicKey();
    for (const trust of [['FOO'], ['MXN', 'MXN'], ['MXN', 'PHP', 'BRL'], [], 'MXN']) {
      const r = await app.inject({ method: 'POST', url: '/setup', payload: { account: acct, trust } });
      expect(r.statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/setup', payload: { account: acct, trust: ['MXN'] } })).statusCode).toBe(200);
  });

  it('/setup is rate limited per account and per IP', async () => {
    const acct = S.Keypair.random().publicKey();
    expect((await app.inject({ method: 'POST', url: '/setup', payload: { account: acct } })).statusCode).toBe(200);
    const again = await app.inject({ method: 'POST', url: '/setup', payload: { account: acct } });
    expect(again.statusCode).toBe(429);
    expect(again.json().error.code).toBe('RATE_LIMITED');
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/setup', payload: { account: S.Keypair.random().publicKey() } })).statusCode);
    }
    expect(codes).toContain(429);
  });

  it('malformed JSON is a 400, not a 500', async () => {
    const r = await app.inject({ method: 'POST', url: '/quote', payload: '{bad json', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
  });

  it('the event stream honours the CORS allowlist', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-sse')).json();
    await pool.query("UPDATE payments SET state = 'EXPIRED', signed_xdr = NULL WHERE id = $1", [p.id]);
    await pool.query("INSERT INTO payment_events (payment_id, seq, type, from_state, to_state) VALUES ($1, 3, 'EXPIRED', 'SIGNED', 'EXPIRED')", [p.id]);
    const evil = await app.inject({ url: `/payments/${p.id}/events`, headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ok = await app.inject({ url: `/payments/${p.id}/events`, headers: { origin: 'http://localhost:5180' } });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5180');
  });

  it('client_domain co-signing refuses another domain', async () => {
    const other = S.WebAuth.buildChallengeTx(
      anchorKey, sender.publicKey(), 'anchor.test', 300, NP, 'anchor.test', undefined, 'evil.example', clientDomainKey.publicKey(),
    );
    const r = await app.inject({ method: 'POST', url: '/sep10/client-domain', payload: { transaction: other } });
    expect(r.statusCode).toBe(422);
  });
});

describe('migrations (audit regressions)', () => {
  it('002 upgrades a ledger in which one signed transaction backs several payments', async () => {
    const admin = new pg.Pool({ connectionString: BASE_URL });
    admin.on('error', () => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade')} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName('corra_upgrade')}`);
    const db = new pg.Pool({ connectionString: urlOf(dbName('corra_upgrade')) });
    try {
      await db.query(readFileSync(new URL('./db/migrations/001_init.sql', import.meta.url), 'utf8'));
      const row = (id: string, state: string, at: string, blob: string | null) => db.query(
        `INSERT INTO payments (id, public_id, idempotency_key, sender_account, recipient_account, corridor_from, corridor_to,
           quote, source_raw, dest_raw, send_max_raw, signed_xdr, inner_tx_hash, max_time, state, created_at)
         VALUES ($1, $1, $1, 'G', 'G', 'MX/MXN', 'PH/PHP', '{}', 1, 1, 1, $4, 'same-hash', now(), $2, $3)`,
        [id, state, at, blob]);
      await row('pmt_first', 'CREDITED', '2026-10-14T07:36:57Z', null);
      await row('pmt_second', 'CREDITED', '2026-10-14T07:37:00Z', null);
      await row('pmt_pending', 'SIGNED', '2026-10-14T07:37:22Z', 'AAAA');

      await migrate(db);
      await migrate(db); // every boot runs every migration again

      const rows = (await db.query('SELECT id, state, inner_tx_hash, signed_xdr FROM payments ORDER BY created_at')).rows;
      expect(rows.map((r) => [r.id, r.state, r.inner_tx_hash])).toEqual([
        ['pmt_first', 'CREDITED', 'same-hash'],
        ['pmt_second', 'CREDITED', 'same-hash:duplicate:pmt_second'],
        ['pmt_pending', 'EXPIRED', 'same-hash:duplicate:pmt_pending'],
      ]);
      expect(rows[2].signed_xdr).toBeNull();
      const ev = (await db.query(`SELECT type, data FROM payment_events WHERE payment_id = 'pmt_pending'`)).rows;
      expect(ev).toEqual([{ type: 'EXPIRED', data: { reason: 'the signed transaction already backs pmt_first' } }]);
    } finally {
      // FORCE may end a backend that has not exited yet: its 57P01 must not surface as an unhandled pool error.
      db.on('error', () => {});
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade')} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  it('002 also upgrades the other legacy shapes it would refuse, and a second boot changes nothing', async () => {
    const admin = new pg.Pool({ connectionString: BASE_URL });
    admin.on('error', () => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade2')} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName('corra_upgrade2')}`);
    const db = new pg.Pool({ connectionString: urlOf(dbName('corra_upgrade2')) });
    try {
      await db.query(readFileSync(new URL('./db/migrations/001_init.sql', import.meta.url), 'utf8'));
      const row = (id: string, state: string, at: string, hash: string, blob: string | null, supersedes: string | null) => db.query(
        `INSERT INTO payments (id, public_id, idempotency_key, sender_account, recipient_account, corridor_from, corridor_to,
           quote, source_raw, dest_raw, send_max_raw, signed_xdr, inner_tx_hash, max_time, supersedes_id, state, created_at)
         VALUES ($1, $1, $1, 'G', 'G', 'MX/MXN', 'PH/PHP', '{}', 1, 1, 1, $5, $4, now(), $6, $2, $3)`,
        [id, state, at, hash, blob, supersedes]);
      await row('pmt_a', 'CREDITED', '2026-10-01T00:00:00Z', 'h1', null, null);
      await row('pmt_a_dup', 'ONCHAIN', '2026-10-01T00:01:00Z', 'h1', null, null);   // its tx landed for pmt_a
      await row('pmt_old', 'EXPIRED', '2026-10-01T00:02:00Z', 'h2', 'LEFT-BEHIND', null); // finished, kept its blob
      await row('pmt_rs1', 'EXPIRED', '2026-10-01T00:03:00Z', 'h3', null, 'pmt_old');
      await row('pmt_rs2', 'SIGNED', '2026-10-01T00:04:00Z', 'h4', 'AAAA', 'pmt_old');   // second re-sign of pmt_old

      await migrate(db);
      const before = (await db.query('SELECT * FROM payments ORDER BY id')).rows;
      await migrate(db);
      expect((await db.query('SELECT * FROM payments ORDER BY id')).rows).toEqual(before);

      const by = Object.fromEntries(before.map((r) => [r.id, r]));
      expect(by.pmt_a_dup.state).toBe('FAILED');
      expect(by.pmt_old.signed_xdr).toBeNull();
      expect(by.pmt_rs1.supersedes_id).toBe('pmt_old');
      expect(by.pmt_rs2.supersedes_id).toBeNull();
      expect(by.pmt_rs2.state).toBe('SIGNED'); // still live, only the duplicate link is dropped
    } finally {
      // FORCE may end a backend that has not exited yet: its 57P01 must not surface as an unhandled pool error.
      db.on('error', () => {});
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade2')} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);
});


const TESTMXN = fiatAsset('MXN');
const depositOf = (account: string, amount = '500.00') =>
  app.inject({ method: 'POST', url: '/deposits', payload: { account, amount } });
const getDeposit = async (id: string) => (await app.inject({ url: `/deposits/${id}` })).json();

describe('D1 deposit routes', () => {
  it('O1 POST /deposits, GET /deposits/:id and the account list, newest first', async () => {
    const acct = S.Keypair.random().publicKey();
    const r = await depositOf(acct);
    expect(r.statusCode).toBe(201);
    const d = r.json();
    expect(d).toMatchObject({ account: acct, status: 'PENDING', anchorRef: null, moreInfoUrl: null, credited: null });
    expect(d.requested).toEqual({ amount: '500.0000000', asset: 'TESTMXN', issuer: TESTMXN.issuer });
    expect(d.memo).toBe(await cashInMemo(d.id));
    expect(d).not.toHaveProperty('anchorId');
    expect(await getDeposit(d.id)).toEqual(d);

    const newer = (await depositOf(acct, '700')).json();
    const list = await app.inject({ url: `/accounts/${acct}/deposits?limit=1` });
    expect(list.json().deposits.map((x: any) => x.id)).toEqual([newer.id]);
    expect((await app.inject({ url: `/accounts/${acct}/deposits` })).json().deposits).toHaveLength(2);

    const missing = await app.inject({ url: '/deposits/dep_nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('DEPOSIT_NOT_FOUND');
  });

  it('O2 validates the account, the amount and the list limit', async () => {
    const acct = S.Keypair.random().publicKey();
    for (const payload of [{ account: 'GBAD', amount: '500' }, { account: acct, amount: '0.5' }, { account: acct, amount: '1000000.01' },
      { account: acct, amount: '1.234' }, { account: acct, amount: 500 }, { account: acct, amount: 'abc' }, { account: acct }]) {
      expect((await app.inject({ method: 'POST', url: '/deposits', payload })).statusCode).toBe(400);
    }
    // An array holding a valid account stringifies to one; it must not slip past the check or the per-account limit.
    for (let i = 0; i < 4; i++) {
      expect((await app.inject({ method: 'POST', url: '/deposits', payload: { account: [acct], amount: '1' } })).statusCode).toBe(400);
    }
    expect((await depositOf(acct, '1000000.00')).statusCode).toBe(201);
    gw.trusts = false;
    const notReady = await depositOf(S.Keypair.random().publicKey());
    expect(notReady.statusCode).toBe(422);
    expect(notReady.json().error).toMatchObject({ code: 'ACCOUNT_NOT_READY', retriable: true });
    for (const q of ['0', '101', 'x']) {
      expect((await app.inject({ url: `/accounts/${acct}/deposits?limit=${q}` })).statusCode).toBe(400);
    }
  });

  it('O3 the 4th deposit of one account within 10 minutes is rate limited', async () => {
    const acct = S.Keypair.random().publicKey();
    for (let i = 0; i < 3; i++) expect((await depositOf(acct)).statusCode).toBe(201);
    const r = await depositOf(acct);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('RATE_LIMITED');
  });

  it('O4 link is write-once, unique per anchor ref, and never takes a URL from the client', async () => {
    const acct = S.Keypair.random().publicKey();
    const a = (await depositOf(acct)).json();
    const b = (await depositOf(acct)).json();
    const link = (id: string, payload: object) => app.inject({ method: 'POST', url: `/deposits/${id}/link`, payload });
    const ok = await link(a.id, { ref: 'ap-1', moreInfoUrl: 'https://evil.example/phish' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ anchorRef: 'ap-1', moreInfoUrl: null });
    expect((await link(a.id, { ref: 'ap-1' })).statusCode).toBe(200);
    const other = await link(a.id, { ref: 'ap-2' });
    expect(other.statusCode).toBe(409);
    expect(other.json().error.code).toBe('DEPOSIT_ALREADY_LINKED');
    const taken = await link(b.id, { ref: 'ap-1' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.message).toMatch(/another deposit/);
    expect((await link(b.id, { ref: 'has space' })).statusCode).toBe(400);
    expect((await link('dep_nope', { ref: 'ap-3' })).statusCode).toBe(404);
    expect((await getDeposit(a.id)).moreInfoUrl).toBeNull();
  });
});

describe('deposit reconcile cadence on Postgres (J34, J42)', () => {
  it('O-U6-1 Postgres listOpenDeposits returns the in-memory store\'s ids in the same order for one fixture', async () => {
    const T = Date.now();
    let t = T;
    const clock = () => t;
    const mem = new InMemoryDepositStore(clock);
    const pg_ = new PostgresDepositStore(pool, clock);
    const MIN = 60_000;
    const HOUR = 60 * MIN;
    // [age at now, last check ago (null: never), status]
    const rows: [number, number | null, 'PENDING' | 'EXPIRED' | 'CONFIRMED'][] = [
      [1 * MIN, null, 'PENDING'], [5 * MIN, 1 * MIN, 'PENDING'], [9 * MIN, 40_000, 'PENDING'], [30 * MIN, 3 * MIN, 'PENDING'],
      [90 * MIN, 1 * MIN, 'PENDING'], [3 * HOUR, 11 * MIN, 'PENDING'], [5 * HOUR, 9 * MIN, 'PENDING'], [26 * HOUR, 2 * HOUR, 'EXPIRED'],
      [8 * 24 * HOUR, 2 * HOUR, 'EXPIRED'], [2 * HOUR, null, 'CONFIRMED'],
    ];
    const both = async (fn: (st: DepositStore) => Promise<unknown>) => { await fn(mem); await fn(pg_); };
    for (const [i, [age, ago, status]] of rows.entries()) {
      t = T - age;
      const id = `dep_ou61_${i}`;
      const d = {
        id, account: S.Keypair.random().publicKey(), anchorId: 'corra-anchor', anchorRef: null, moreInfoUrl: null, memo: `memo-ou61-${i}`,
        requested: fromDecimal(TESTMXN, '1'), credited: null, txHash: null, status: 'PENDING' as const, matchedBy: null, reason: null,
        createdAt: t, updatedAt: t,
      };
      await both((st) => st.createDeposit(d));
      if (status === 'EXPIRED') await both((st) => st.expireDeposit(id, 'no credit within 24h'));
      if (status === 'CONFIRMED') await both((st) => st.confirmDeposit(id, { credited: d.requested, txHash: 'h', matchedBy: 'chain', reason: null }));
      if (ago !== null) {
        t = T - ago;
        await both((st) => st.touchDeposit(id));
      }
    }
    const q = { ...DEPOSIT_CADENCE, limit: 10 };
    const expected = (await mem.listOpenDeposits(T, q)).map((d) => d.id);
    // by due time: the EXPIRED one due an hour ago, the mid and old ones due a minute ago, then the young ones
    expect(expected).toEqual(['dep_ou61_7', 'dep_ou61_3', 'dep_ou61_5', 'dep_ou61_0', 'dep_ou61_1', 'dep_ou61_2']);
    expect((await pg_.listOpenDeposits(T, q)).map((d) => d.id)).toEqual(expected);
  });
});

describe('D1 callback dispatch', () => {
  it('O5 payment refs first, then deposits by ref, then by the memo of stellar_transaction_id', async () => {
    // A Phase 1 payment's ref still settles the payment.
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-o5')).json();
    await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'ap-pay' } });
    gw.deposits.push({ hash: 'pay-dep', amount: moneyFromWire(q.maxSend), at: Date.now(), memo: await cashInMemo(p.id) });
    await app.inject(signedCallback({ transaction: { id: 'ap-pay', kind: 'deposit', status: 'completed' } }));
    await waitFor(async () => (await store.getPayment(p.id))!.state === 'CREDITED');

    // A linked deposit, by ref; the URL comes from the signed body.
    const acct = S.Keypair.random().publicKey();
    const d = (await depositOf(acct)).json();
    await app.inject({ method: 'POST', url: `/deposits/${d.id}/link`, payload: { ref: 'ap-d1' } });
    gw.deposits.push({ hash: 'dtx1', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: d.memo });
    await app.inject(signedCallback({ transaction: {
      id: 'ap-d1', kind: 'deposit', status: 'completed', stellar_transaction_id: 'dtx1', more_info_url: 'https://anchor.test/tx/ap-d1' } }));
    await waitFor(async () => (await getDeposit(d.id)).status === 'CONFIRMED');
    expect(await getDeposit(d.id)).toMatchObject({ matchedBy: 'ref', txHash: 'dtx1', moreInfoUrl: 'https://anchor.test/tx/ap-d1',
      credited: { amount: '500.0000000' } });

    // Never linked: found by the memo of the anchor's transaction, and its ref bound.
    const e = (await depositOf(acct)).json();
    gw.deposits.push({ hash: 'dtx2', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: e.memo });
    gw.landed.set('dtx2', 'SUCCESS');
    gw.memos.set('dtx2', e.memo);
    await app.inject(signedCallback({ transaction: { id: 'ap-d2', kind: 'deposit', status: 'completed', stellar_transaction_id: 'dtx2', to: acct } }));
    await waitFor(async () => (await getDeposit(e.id)).status === 'CONFIRMED');
    expect(await getDeposit(e.id)).toMatchObject({ matchedBy: 'callback_tx', anchorRef: 'ap-d2' });

    // Anchor Platform reports no transaction hash, only the memo it paid (in hex) and the account.
    const m = (await depositOf(acct)).json();
    gw.deposits.push({ hash: 'dtx4', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: m.memo });
    await app.inject(signedCallback({ transaction: { id: 'ap-d4', kind: 'deposit', status: 'completed', to: acct,
      deposit_memo_type: 'hash', deposit_memo: Buffer.from(m.memo, 'base64').toString('hex') } }));
    await waitFor(async () => (await getDeposit(m.id)).status === 'CONFIRMED');
    expect(await getDeposit(m.id)).toMatchObject({ matchedBy: 'callback_tx', anchorRef: 'ap-d4', txHash: 'dtx4' });

    // Unknown everything: 200, nothing written. A forged one: 401, nothing written.
    const f = (await depositOf(S.Keypair.random().publicKey())).json();
    expect((await app.inject(signedCallback({ transaction: { id: 'nope', kind: 'deposit', status: 'completed' } }))).statusCode).toBe(200);
    gw.deposits.push({ hash: 'dtx3', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: f.memo });
    gw.landed.set('dtx3', 'SUCCESS');
    gw.memos.set('dtx3', f.memo);
    const forged = signedCallback({ transaction: { id: 'ap-f', kind: 'deposit', status: 'completed', stellar_transaction_id: 'dtx3' } });
    forged.payload = JSON.stringify({ transaction: { id: 'ap-g', kind: 'deposit', status: 'completed', stellar_transaction_id: 'dtx3' } });
    expect((await app.inject(forged)).statusCode).toBe(401);
    await new Promise((r) => setTimeout(r, 100));
    expect(await getDeposit(f.id)).toMatchObject({ status: 'PENDING', anchorRef: null });
  });

  it('O5d a signed callback before the credit is visible binds its ref on Postgres, correcting a squatted one; the chain confirms later', async () => {
    const acct = S.Keypair.random().publicKey();
    const d = (await depositOf(acct)).json();
    await app.inject({ method: 'POST', url: `/deposits/${d.id}/link`, payload: { ref: 'bogus' } });
    gw.landed.set('dtx-lag', 'SUCCESS'); // the transaction is known, the credit walk lags behind
    gw.memos.set('dtx-lag', d.memo);
    await app.inject(signedCallback({ transaction: { id: 'ap-lag', kind: 'deposit', status: 'completed', stellar_transaction_id: 'dtx-lag', to: acct } }));
    await waitFor(async () => (await getDeposit(d.id)).anchorRef === 'ap-lag');
    expect(await getDeposit(d.id)).toMatchObject({ status: 'PENDING', matchedBy: null });

    gw.deposits.push({ hash: 'dtx-lag', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: d.memo });
    const later = createDeposits({
      store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: TESTMXN,
      now: () => Date.now() + 31_000,
    });
    expect(await later.reconcileDeposits()).toBe(1);
    expect(await getDeposit(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', anchorRef: 'ap-lag', txHash: 'dtx-lag' });
  });

  it('O5e on Postgres: EXPIRED at 24 h, a late credit flips it within the hour, an EXPIRED one past 7 days is not re-checked', async () => {
    let now = Date.now();
    const deps = createDeposits({
      store: new PostgresDepositStore(pool, () => now), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: TESTMXN,
      now: () => now,
    });
    const d = await deps.create(S.Keypair.random().publicKey(), fromDecimal(TESTMXN, '500'));
    now = d.createdAt + 24 * 3_600_000;
    expect(await deps.reconcileDeposits()).toBe(1);
    expect(await getDeposit(d.id)).toMatchObject({ status: 'EXPIRED', reason: 'no credit within 24h' });
    gw.deposits.push({ hash: 'dtx-late', amount: fromDecimal(TESTMXN, '500'), at: now, memo: d.memo });
    now += 3_600_000 - 1;
    expect(await deps.reconcileDeposits()).toBe(0);
    now += 1;
    expect(await deps.reconcileDeposits()).toBe(1);
    expect(await getDeposit(d.id)).toMatchObject({ status: 'CONFIRMED', matchedBy: 'chain', reason: 'credited after expiry', txHash: 'dtx-late' });

    const old = await deps.create(S.Keypair.random().publicKey(), fromDecimal(TESTMXN, '1'));
    await pool.query("UPDATE deposits SET status = 'EXPIRED', created_at = $2, updated_at = $2 WHERE id = $1", [old.id, new Date(now - 8 * 24 * 3_600_000)]);
    gw.deposits.push({ hash: 'dtx-old', amount: fromDecimal(TESTMXN, '1'), at: now, memo: old.memo });
    expect(await deps.reconcileDeposits()).toBe(0);
    expect((await getDeposit(old.id)).status).toBe('EXPIRED');
  });

  it('O5f on Postgres: a deposit whose check throws has its updated_at moved forward, so it leaves the head of the queue', async () => {
    let now = Date.now();
    const down = Object.assign(Object.create(gw), { findDeposit: async () => { throw new Error('horizon down'); } }) as FakeGateway;
    const deps = createDeposits({
      store: new PostgresDepositStore(pool, () => now), gateway: down, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: TESTMXN,
      now: () => now,
    });
    const d = await deps.create(S.Keypair.random().publicKey(), fromDecimal(TESTMXN, '500'));
    now += 31_000;
    expect(await deps.reconcileDeposits()).toBe(0);
    const row = (await pool.query('SELECT updated_at FROM deposits WHERE id = $1', [d.id])).rows[0];
    expect(row.updated_at.getTime()).toBe(now);
    expect((await getDeposit(d.id)).status).toBe('PENDING');
  });

  it("O5 a callback naming a balance payment's marker ref changes nothing", async () => {
    gw.sequence = 5000n;
    const { q, xdr } = await quoteAndSignBalance();
    const p = (await send({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr }, 's-o5')).json();
    // The marker leg has no anchor, so no anchor reference can ever find the payment.
    expect(await store.findPaymentByCashInRef('corra-anchor', `balance:${p.publicId}`)).toBeNull();
    await waitFor(async () => (await store.getPayment(p.id))!.state === 'CREDITED');
    const before = await store.events(p.id);
    await app.inject(signedCallback({ transaction: { id: `balance:${p.publicId}`, kind: 'deposit', status: 'completed' } }));
    await new Promise((r) => setTimeout(r, 100));
    expect(await store.events(p.id)).toEqual(before);
  });

  it("O5b a payment's cash-in leg holding a deposit's ref does not swallow the deposit's callback", async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-o5b')).json();
    const d = (await depositOf(S.Keypair.random().publicKey())).json();
    await app.inject({ method: 'POST', url: `/deposits/${d.id}/link`, payload: { ref: 'ap-shared' } });
    // Anyone can read the deposit's ref and claim it for a payment's cash-in.
    expect((await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'ap-shared' } })).statusCode).toBe(200);
    gw.deposits.push({ hash: 'dtx-shared', amount: fromDecimal(TESTMXN, '500'), at: Date.now(), memo: d.memo });
    await app.inject(signedCallback({ transaction: {
      id: 'ap-shared', kind: 'deposit', status: 'completed', more_info_url: 'https://anchor.test/tx/ap-shared' } }));
    await waitFor(async () => (await getDeposit(d.id)).status === 'CONFIRMED');
    expect(await getDeposit(d.id)).toMatchObject({ matchedBy: 'ref', moreInfoUrl: 'https://anchor.test/tx/ap-shared' });
    expect((await store.getPayment(p.id))!.state).toBe('SIGNED'); // the chain decides for the payment too
  });

  it('O5c a short credit stays PENDING with both figures on Postgres; the next credit confirms the sum', async () => {
    const acct = S.Keypair.random().publicKey();
    const d = (await depositOf(acct)).json();
    await app.inject({ method: 'POST', url: `/deposits/${d.id}/link`, payload: { ref: 'ap-short' } });
    gw.deposits.push({ hash: 'short-1', amount: fromDecimal(TESTMXN, '1'), at: Date.now(), memo: d.memo });
    const done = signedCallback({ transaction: { id: 'ap-short', kind: 'deposit', status: 'completed' } });
    await app.inject(done);
    await waitFor(async () => (await getDeposit(d.id)).credited !== null);
    expect(await getDeposit(d.id)).toMatchObject({ status: 'PENDING', matchedBy: null, txHash: 'short-1', credited: { amount: '1.0000000' } });
    // The gateway sums every credit with the memo and stamps the latest hash.
    gw.deposits = [{ hash: 'short-2', amount: fromDecimal(TESTMXN, '501'), at: Date.now(), memo: d.memo }];
    await app.inject(done);
    await waitFor(async () => (await getDeposit(d.id)).status === 'CONFIRMED');
    expect(await getDeposit(d.id)).toMatchObject({ matchedBy: 'ref', txHash: 'short-2', credited: { amount: '501.0000000' }, reason: null });
  });
});

async function quoteAndSignBalance(to = recipient, seq = gw.sequence!) {
  const q = (await app.inject({ method: 'POST', url: '/quote', payload: quoteBody })).json();
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: String(seq), recipient: to,
    dest: moneyFromWire(q.dest), sendMax: moneyFromWire(q.maxSend), path: q.path, now: Math.floor(Date.now() / 1000), mode: 'balance',
  });
  tx.sign(sender);
  return { q, xdr: tx.toXDR() };
}

const send = (payload: object, key?: string) =>
  app.inject({ method: 'POST', url: '/send', payload, headers: key ? { 'idempotency-key': key } : {} });

describe('D1 POST /send', () => {
  beforeEach(() => { gw.sequence = 5000n; });

  it('O6 creates a balance payment in CASH_IN and settles it; refusals map to the documented codes', async () => {
    const { q, xdr } = await quoteAndSignBalance();
    const body = { quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr };
    const created = await send(body, 's1');
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({ kind: 'balance', state: 'CASH_IN' });
    expect(p).not.toHaveProperty('signedXdr');
    expect(p).not.toHaveProperty('idemKey');
    expect(p.legs.find((l: any) => l.kind === 'cash_in')).toMatchObject({ status: 'CONFIRMED', externalRef: `balance:${p.publicId}` });
    await waitFor(async () => (await app.inject({ url: `/payments/${p.id}` })).json().state === 'CREDITED');
    const done = (await app.inject({ url: `/payments/${p.id}` })).json();
    expect(done.events.at(-1)).toMatchObject({ type: 'CREDITED', data: { ledger: 1 } });

    const replay = await send(body, 's1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(p.id);
    // A /send key replayed on /confirm is another request, not a success.
    const crossKind = await confirm(body, 's1');
    expect(crossKind.statusCode).toBe(409);
    expect(crossKind.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await send(body)).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const cashIn = await app.inject({ method: 'POST', url: `/payments/${p.id}/cash-in`, payload: { ref: 'x' } });
    expect(cashIn.statusCode).toBe(409);
    expect(cashIn.json().error.code).toBe('CASH_IN_ALREADY_LINKED');

    gw.sequence = 5001n;
    const errOf = async (payload: object, key: string) => {
      const r = await send(payload, key);
      return { status: r.statusCode, ...r.json().error };
    };
    const phase1 = await quoteAndSign();
    expect(await errOf({ quoteId: phase1.q.id, sender: sender.publicKey(), recipient, signedXdr: phase1.signedXdr }, 's2'))
      .toMatchObject({ status: 422, code: 'UNBOUND_TRANSACTION' });

    const low = await quoteAndSignBalance();
    gw.balance = fromDecimal(MXN, '1');
    expect(await errOf({ quoteId: low.q.id, sender: sender.publicKey(), recipient, signedXdr: low.xdr }, 's3'))
      .toMatchObject({ status: 422, code: 'INSUFFICIENT_BALANCE', retriable: true });
    gw.balance = fromDecimal(MXN, '10000');

    gw.trusts = false;
    expect(await errOf({ quoteId: low.q.id, sender: sender.publicKey(), recipient, signedXdr: low.xdr }, 's4'))
      .toMatchObject({ status: 422, code: 'RECIPIENT_NO_TRUSTLINE' });
    gw.trusts = true;

    // The first payment's quote, signed for another recipient so the blob itself is new.
    const other = S.Keypair.random().publicKey();
    const usedBlob = buildStrictReceive({
      networkPassphrase: NP, sender: sender.publicKey(), paymentAccount: PAY, paymentSequence: '5001', recipient: other,
      dest: moneyFromWire(q.dest), sendMax: moneyFromWire(q.maxSend), path: q.path, now: Math.floor(Date.now() / 1000), mode: 'balance',
    });
    usedBlob.sign(sender);
    expect(await errOf({ quoteId: q.id, sender: sender.publicKey(), recipient: other, signedXdr: usedBlob.toXDR() }, 's5'))
      .toMatchObject({ status: 409, code: 'QUOTE_USED' });

    const c = await quoteAndSign();
    expect((await confirm({ quoteId: c.q.id, sender: sender.publicKey(), recipient, signedXdr: c.signedXdr }, 'k-conf')).statusCode).toBe(201);
    expect(await errOf({ quoteId: c.q.id, sender: sender.publicKey(), recipient, signedXdr: low.xdr }, 'k-conf'))
      .toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('O7 (T16) two balance payments of one sender: cash_in markers with no anchor and distinct refs', async () => {
    const ids: string[] = [];
    for (const [k, seq] of [['s-a', 5000n], ['s-b', 5001n]] as const) {
      gw.sequence = seq;
      const { q, xdr } = await quoteAndSignBalance();
      const p = (await send({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr }, k)).json();
      await waitFor(async () => (await store.getPayment(p.id))!.state === 'CREDITED');
      ids.push(p.id);
    }
    const legs = (await pool.query(
      "SELECT l.anchor_id, l.external_ref, p.public_id FROM legs l JOIN payments p ON p.id = l.payment_id WHERE l.kind = 'cash_in' ORDER BY p.created_at",
    )).rows;
    expect(legs.map((l) => [l.anchor_id, l.external_ref])).toEqual(legs.map((l) => [null, `balance:${l.public_id}`]));
    expect(new Set(legs.map((l) => l.external_ref)).size).toBe(2);
    // Why the marker has no anchor: one shared (anchor, ref) pair would collide on the second payment.
    await pool.query("UPDATE legs SET anchor_id = 'corra-anchor', external_ref = 'balance' WHERE payment_id = $1 AND kind = 'cash_in'", [ids[0]]);
    await expect(pool.query("UPDATE legs SET anchor_id = 'corra-anchor', external_ref = 'balance' WHERE payment_id = $1 AND kind = 'cash_in'", [ids[1]]))
      .rejects.toMatchObject({ code: '23505' });
  });

  it('O8 the database allows one balance payment in flight per sender', async () => {
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r));
    try {
      const other = S.Keypair.random().publicKey(); // two recipients, so the two blobs at one sequence differ
      const a = await quoteAndSignBalance(recipient);
      const b = await quoteAndSignBalance(other);
      const rs = await Promise.all([
        send({ quoteId: a.q.id, sender: sender.publicKey(), recipient, signedXdr: a.xdr }, 'o8-a'),
        send({ quoteId: b.q.id, sender: sender.publicKey(), recipient: other, signedXdr: b.xdr }, 'o8-b'),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const loser = rs.find((r) => r.statusCode === 409)!;
      expect(loser.json().error.code).toBe('PAYMENT_IN_PROGRESS');
      const winner = rs.find((r) => r.statusCode === 201)!.json();

      // The index itself, past the application's check: a second in-flight balance row is refused.
      const live = (await store.getPayment(winner.id))!;
      const q2 = (await app.inject({ method: 'POST', url: '/quote', payload: quoteBody })).json();
      const twin = { ...live, id: 'pmt_twin', publicId: 'CORRA-TWIN22', idemKey: 'o8-twin', innerTxHash: 'twin-hash', quote: { ...live.quote, id: q2.id },
        legs: [{ ...live.legs[0], externalRef: 'balance:CORRA-TWIN22' }] };
      await expect(store.createPayment(twin, [])).rejects.toMatchObject({ code: 'PAYMENT_IN_PROGRESS', status: 409 });

      release();
      await waitFor(async () => (await store.getPayment(winner.id))!.state === 'CREDITED');
      gw.gate = null;
      gw.sequence = 5001n;
      const c = await quoteAndSignBalance();
      expect((await send({ quoteId: c.q.id, sender: sender.publicKey(), recipient, signedXdr: c.xdr }, 'o8-c')).statusCode).toBe(201);
    } finally {
      release(); // the app's close waits for the submit behind the gate
    }
  });

  it('O14 five concurrent /send requests with one Idempotency-Key all get the same payment, never 409 or 429', async () => {
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r)); // the payment stays CASH_IN while the others run
    try {
      // The others pass the key lookup before the first commits, then reach the in-flight check after it.
      let calls = 0;
      gw.accountTrusts = async () => {
        if (calls++ > 0) while (!(await store.getPaymentByIdemKey('o14'))) await new Promise((r) => setTimeout(r, 5));
        return true;
      };
      const { q, xdr } = await quoteAndSignBalance();
      const body = { quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr };
      const rs = await Promise.all(Array.from({ length: 5 }, () => send(body, 'o14')));
      expect(rs.map((r) => [200, 201].includes(r.statusCode))).toEqual([true, true, true, true, true]);
      expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
      release();
      await waitFor(async () => (await store.getPayment(rs[0].json().id))!.state === 'CREDITED');
      gw.gate = null;
    } finally {
      release();
    }
  });

  it('O14b two concurrent /send requests with one Idempotency-Key and different recipients: 201 and 409 IDEMPOTENCY_KEY_REUSED', async () => {
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r));
    try {
      // Both pass the key lookup and the in-flight check before either commits.
      let waiting = 0;
      let open!: () => void;
      const both = new Promise<void>((r) => (open = r));
      gw.accountSequence = async () => { if (++waiting === 2) open(); await both; return 5000n; };
      const other = S.Keypair.random().publicKey();
      const a = await quoteAndSignBalance(recipient);
      const b = await quoteAndSignBalance(other);
      const rs = await Promise.all([
        send({ quoteId: a.q.id, sender: sender.publicKey(), recipient, signedXdr: a.xdr }, 'o14b'),
        send({ quoteId: b.q.id, sender: sender.publicKey(), recipient: other, signedXdr: b.xdr }, 'o14b'),
      ]);
      expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect(rs.find((r) => r.statusCode === 409)!.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
      release();
      await waitFor(async () => (await store.getPayment(rs.find((r) => r.statusCode === 201)!.json().id))!.state === 'CREDITED');
      gw.gate = null;
    } finally {
      release();
    }
  });

  it('O9 GET /accounts/:account/payments lists both kinds, newest first, without blobs or keys', async () => {
    // The balance payment first: a SIGNED pre-signed one would refuse it (SIGNED_PAYMENT_WAITING).
    const { q, xdr } = await quoteAndSignBalance();
    const b = (await send({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr }, 'o9-b')).json();
    await waitFor(async () => (await app.inject({ url: `/payments/${b.id}` })).json().state === 'CREDITED');
    const p1 = await quoteAndSign();
    const a = (await confirm({ quoteId: p1.q.id, sender: sender.publicKey(), recipient, signedXdr: p1.signedXdr }, 'o9-a')).json();
    for (const url of [`/accounts/${sender.publicKey()}/payments`, `/accounts/${recipient}/payments?role=recipient&limit=10`]) {
      const list = (await app.inject({ url })).json().payments;
      expect(list.map((p: any) => [p.id, p.kind])).toEqual([[a.id, 'cash_in'], [b.id, 'balance']]);
      for (const p of list) {
        expect(p).not.toHaveProperty('signedXdr');
        expect(p).not.toHaveProperty('idemKey');
        expect(p).not.toHaveProperty('events');
      }
    }
    expect((await app.inject({ url: `/accounts/${recipient}/payments` })).json().payments).toEqual([]);
    expect((await app.inject({ url: `/accounts/${sender.publicKey()}/payments?role=x` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/accounts/GBAD/payments' })).statusCode).toBe(400);
    gw.sequence = 5001n;
    const arr = await quoteAndSignBalance();
    for (const [s, r] of [[[sender.publicKey()], recipient], [sender.publicKey(), [recipient]]]) {
      const bad = await send({ quoteId: arr.q.id, sender: s, recipient: r, signedXdr: arr.xdr }, `o9-arr-${Array.isArray(s)}`);
      expect(bad.statusCode).toBe(400);
    }
    expect((await app.inject({ url: `/accounts/${sender.publicKey()}/payments?limit=0` })).statusCode).toBe(400);
  });
});

describe('app.close() drains background work (J-u3-C6-2)', () => {
  beforeEach(() => { gw.sequence = 5000n; });

  it('DR1 /send: close() stays pending while the submit waits at the gate, and the payment\'s write is in Postgres before it resolves', async () => {
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r));
    try {
      const { q, xdr } = await quoteAndSignBalance();
      const p = (await send({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr }, 'dr1')).json();
      await waitFor(async () => gw.submits === 1);
      let closed = false;
      const closing = app.close().then(() => { closed = true; });
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(false);
      release();
      await closing;
      expect((await store.getPayment(p.id))!.state).toBe('CREDITED');
    } finally {
      release();
    }
  });

  it('DR3 /resign of a balance payment: close() stays pending while the re-signed submit waits at the gate, and its write is in Postgres before it resolves', async () => {
    gw.failNext = true;
    const a = await quoteAndSignBalance();
    const failed = (await send({ quoteId: a.q.id, sender: sender.publicKey(), recipient, signedXdr: a.xdr }, 'dr3-a')).json();
    await waitFor(async () => (await store.getPayment(failed.id))!.state === 'FAILED');
    let release!: () => void;
    gw.gate = new Promise((r) => (release = r));
    try {
      gw.sequence = 5001n;
      const b = await quoteAndSignBalance();
      const r = await app.inject({ method: 'POST', url: '/resign', payload: { supersedesId: failed.id, quoteId: b.q.id, signedXdr: b.xdr }, headers: { 'idempotency-key': 'dr3-b' } });
      expect(r.statusCode).toBe(201);
      await waitFor(async () => gw.submits === 2);
      let closed = false;
      const closing = app.close().then(() => { closed = true; });
      await new Promise((r) => setTimeout(r, 100));
      expect(closed).toBe(false);
      release();
      await closing;
      expect((await store.getPayment(r.json().id))!.state).toBe('CREDITED');
    } finally {
      release();
    }
  });
});

describe('D1 send limits and re-sign', () => {
  beforeEach(() => { gw.sequence = 5000n; });

  it('O12 junk /send requests naming a victim do not rate limit the victim; the per-account limit counts proven sends', async () => {
    const strict = track(buildApp({
      saga: createSaga({ store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: TESTMXN }),
      cashOuts: makeCashOuts(),
      networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }),
      limits: { sendPerAccount: { max: 1, windowMs: 10 * 60_000 } },
    }));
    const post = (url: string, payload: object, key: string) => strict.inject({ method: 'POST', url, payload, headers: { 'idempotency-key': key } });
    try {
      const { q, xdr } = await quoteAndSignBalance();
      for (let i = 0; i < 3; i++) {
        const junk = await post('/send', { quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: 'AAAA' }, `junk-${i}`);
        expect(junk.statusCode).toBe(422);
        expect(junk.json().error.code).toBe('UNBOUND_TRANSACTION');
      }
      gw.failNext = true;
      const body = { quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr: xdr };
      const first = await post('/send', body, 'o12-a');
      expect(first.statusCode).toBe(201);
      await waitFor(async () => (await store.getPayment(first.json().id))!.state === 'FAILED');
      expect((await post('/send', body, 'o12-a')).statusCode).toBe(200); // a replay is never limited

      // A re-sign of a balance payment is a balance send: same limits.
      gw.sequence = 5001n;
      const again = await quoteAndSignBalance();
      const resigned = await post('/resign', { supersedesId: first.json().id, quoteId: again.q.id, signedXdr: again.xdr }, 'o12-b');
      expect(resigned.statusCode).toBe(429);
      expect(resigned.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await strict.close();
    }
  });

  it('O13 a re-signed balance payment is submitted at once, without the reconciler', async () => {
    gw.failNext = true;
    const a = await quoteAndSignBalance();
    const failed = (await send({ quoteId: a.q.id, sender: sender.publicKey(), recipient, signedXdr: a.xdr }, 'o13-a')).json();
    await waitFor(async () => (await store.getPayment(failed.id))!.state === 'FAILED');

    gw.sequence = 5001n;
    const b = await quoteAndSignBalance();
    const resign = { supersedesId: failed.id, quoteId: b.q.id, signedXdr: b.xdr };
    const r = await app.inject({ method: 'POST', url: '/resign', payload: resign, headers: { 'idempotency-key': 'o13-b' } });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ kind: 'balance', state: 'CASH_IN', supersedesId: failed.id });
    await waitFor(async () => (await store.getPayment(r.json().id))!.state === 'CREDITED');
    expect(gw.submits).toBe(2);
    const replay = await app.inject({ method: 'POST', url: '/resign', payload: resign, headers: { 'idempotency-key': 'o13-b' } });
    expect(replay.json().id).toBe(r.json().id);
  });

  it('U6-RS1/RS2 (J112) a second /resign of the same payment under a new key is 409 ALREADY_SUPERSEDED, nothing submitted; the same body and key replays the same row', async () => {
    gw.failNext = true;
    const a = await quoteAndSignBalance();
    const failed = (await send({ quoteId: a.q.id, sender: sender.publicKey(), recipient, signedXdr: a.xdr }, 'rs-a')).json();
    await waitFor(async () => (await store.getPayment(failed.id))!.state === 'FAILED');
    gw.sequence = 5001n;
    const b = await quoteAndSignBalance();
    const resign = { supersedesId: failed.id, quoteId: b.q.id, signedXdr: b.xdr };
    const first = await app.inject({ method: 'POST', url: '/resign', payload: resign, headers: { 'idempotency-key': 'rs-b' } });
    expect(first.statusCode).toBe(201);
    await waitFor(async () => (await store.getPayment(first.json().id))!.state === 'CREDITED');
    const submits = gw.submits;

    gw.sequence = 5002n;
    const c = await quoteAndSignBalance();
    const second = await app.inject({ method: 'POST', url: '/resign', payload: { supersedesId: failed.id, quoteId: c.q.id, signedXdr: c.xdr }, headers: { 'idempotency-key': 'rs-c' } });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ALREADY_SUPERSEDED');
    await new Promise((r) => setTimeout(r, 100));
    expect(gw.submits).toBe(submits);

    // /resign answers a replay with the same row and 201 (unlike /confirm's 200); nothing is sent again.
    const replay = await app.inject({ method: 'POST', url: '/resign', payload: resign, headers: { 'idempotency-key': 'rs-b' } });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
    expect(gw.submits).toBe(submits);
  });
});

describe('migration 003', () => {
  it('O10 runs twice on a Phase 1 ledger without changing rows or schema', async () => {
    const admin = new pg.Pool({ connectionString: BASE_URL });
    admin.on('error', () => {});
    await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade3')} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${dbName('corra_upgrade3')}`);
    const db = new pg.Pool({ connectionString: urlOf(dbName('corra_upgrade3')) });
    try {
      for (const f of ['001_init.sql', '002_hardening.sql']) {
        await db.query(readFileSync(new URL(`./db/migrations/${f}`, import.meta.url), 'utf8'));
      }
      const row = (id: string, state: string, blob: string | null) => db.query(
        `INSERT INTO payments (id, public_id, idempotency_key, sender_account, recipient_account, corridor_from, corridor_to,
           quote, source_raw, dest_raw, send_max_raw, signed_xdr, inner_tx_hash, max_time, state, created_at)
         VALUES ($1, $1, $1, 'G', 'G', 'MX/MXN', 'PH/PHP', '{}', 1, 1, 1, $3, $1, now(), $2, '2026-10-14T07:00:00Z')`,
        [id, state, blob]);
      const leg = (payment: string, kind: string, anchor: string | null, ref: string | null) => db.query(
        `INSERT INTO legs (id, payment_id, kind, anchor_id, external_ref, amount_raw, asset_code, asset_issuer, status)
         VALUES ($1, $2, $3, $4, $5, 1, 'TESTMXN', 'GISSUER', 'CONFIRMED')`, [`leg_${payment}_${kind}`, payment, kind, anchor, ref]);
      await row('pmt_done', 'CREDITED', null);
      await leg('pmt_done', 'cash_in', 'corra-anchor', 'ap-1');
      await leg('pmt_done', 'onchain', null, null);
      await leg('pmt_done', 'cash_out', null, 'mock-payout:CORRA-OLD');
      await row('pmt_signed', 'SIGNED', 'AAAA');

      const snapshot = async () => ({
        payments: (await db.query('SELECT * FROM payments ORDER BY id')).rows,
        legs: (await db.query('SELECT * FROM legs ORDER BY id')).rows,
        columns: (await db.query(`SELECT table_name, column_name, data_type, column_default, is_nullable FROM information_schema.columns
          WHERE table_name IN ('payments','legs','deposits','pool_ops') ORDER BY table_name, column_name`)).rows,
        indexes: (await db.query(`SELECT tablename, indexname, indexdef FROM pg_indexes
          WHERE tablename IN ('payments','legs','deposits','pool_ops') ORDER BY indexname`)).rows,
        constraints: (await db.query(`SELECT conrelid::regclass::text AS t, conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conrelid::regclass::text IN ('payments','legs','deposits','pool_ops') ORDER BY conname`)).rows,
        triggers: (await db.query(`SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger
          WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('payments','legs','deposits','pool_ops') ORDER BY tgname`)).rows,
      });

      await migrate(db);
      const first = await snapshot();
      await migrate(db);
      expect(await snapshot()).toEqual(first);

      expect(first.payments.map((p) => p.kind)).toEqual(['cash_in', 'cash_in']);
      const names = [...first.indexes.map((i) => i.indexname), ...first.constraints.map((c) => c.conname), ...first.triggers.map((t) => t.tgname)];
      for (const n of ['payments_balance_in_flight_key', 'payments_kind_check', 'deposits_confirmed_has_chain',
        'legs_cash_out_confirmed_has_ref', 'deposits_confirmed_guard', 'legs_cash_out_inflight_idx', 'legs_cash_out_tx_key']) expect(names).toContain(n);
      expect(names).not.toContain('legs_cash_out_open_idx');

      await expect(db.query("UPDATE payments SET kind = 'other' WHERE id = 'pmt_signed'")).rejects.toMatchObject({ code: '23514' });
      await expect(db.query(`INSERT INTO legs (id, payment_id, kind, amount_raw, asset_code, status)
        VALUES ('leg_x', 'pmt_signed', 'cash_out', 1, 'TESTPHP', 'CONFIRMED')`)).rejects.toMatchObject({ code: '23514' });
    } finally {
      // FORCE may end a backend that has not exited yet: its 57P01 must not surface as an unhandled pool error.
      db.on('error', () => {});
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName('corra_upgrade3')} WITH (FORCE)`);
      await admin.end();
    }
  }, 30_000);

  it('O11 a CONFIRMED deposit keeps its chain facts; reference, URL and reason stay writable', async () => {
    const insert = (id: string, status: string, chain: boolean) => pool.query(
      `INSERT INTO deposits (id, account, anchor_id, memo, asset_code, asset_issuer, amount_raw, status, tx_hash, amount_credited_raw, matched_by)
       VALUES ($1, 'G', 'corra-anchor', $1, 'TESTMXN', 'GISSUER', 5000000000, $2, $3, $4, $5)`,
      [id, status, chain ? 'h1' : null, chain ? 5000000000 : null, chain ? 'chain' : null]);
    await insert('dep_c', 'CONFIRMED', true);
    for (const set of ["status = 'EXPIRED'", "tx_hash = 'h2'", 'amount_credited_raw = 1', "matched_by = 'ref'"]) {
      await expect(pool.query(`UPDATE deposits SET ${set} WHERE id = 'dep_c'`)).rejects.toThrow(/immutable/);
    }
    await pool.query("UPDATE deposits SET external_ref = 'ap-1', more_info_url = 'https://a/1', reason = 'credited after expiry' WHERE id = 'dep_c'");

    await insert('dep_e', 'EXPIRED', false);
    await pool.query("UPDATE deposits SET status = 'CONFIRMED', tx_hash = 'h3', amount_credited_raw = 1, matched_by = 'chain' WHERE id = 'dep_e'");
    await expect(insert('dep_bad', 'CONFIRMED', false)).rejects.toMatchObject({ code: '23514' });
  });
});

/** Scripted Stellar RPC: bump goes through the real sponsor, send and status answer from the script. */
class FakePoolChain implements PoolChain {
  sends = 0;
  next: PoolSendOutcome | 'throw' = { status: 'SUCCESS', ledger: 9, feeCharged: 593_131n };
  statuses = new Map<string, PoolLanded>();
  /** The node's oldest ledger close time (unix seconds) on a NOT_FOUND answer: by default it holds everything. */
  oldestCloseTime = 0;
  /** Runs after each send: lets a test land the original envelope while the resend is refused. */
  afterSend?: () => void;
  /** The node's latest ledger close time (unix seconds) on a NOT_FOUND answer. */
  constructor(private sponsor: Sponsor, public closeTime: () => number) {}
  bump(xdr: string, nowSec: number) {
    const out = this.sponsor.feeBump(xdr, 1000, nowSec);
    const tx = S.TransactionBuilder.fromXDR(out, NP);
    return { xdr: out, hash: Array.from(tx.hash(), (b) => b.toString(16).padStart(2, '0')).join('') };
  }
  async send() {
    this.sends++;
    await new Promise((r) => setTimeout(r, 20));
    if (this.next === 'throw') throw new Error('socket hang up');
    this.afterSend?.();
    return this.next;
  }
  async status(h: string) {
    return this.statuses.get(h) ?? { status: 'NOT_FOUND' as const, latestLedgerCloseTime: this.closeTime(), oldestLedgerCloseTime: this.oldestCloseTime };
  }
}

describe('D2 pool submit', () => {
  const POOL_MXN = { code: 'TESTMXN', issuer: PF.ISSUER };
  const sponsorKey = S.Keypair.random();
  let clock: number;
  let chain: FakePoolChain;
  let poolOps: PoolOps;
  let papp: ReturnType<typeof buildApp>;
  /** What the gateway reports as the signer's payment account. */
  let paymentAccountOfSigner: string | null = PF.PAYMENT_ACCOUNT;

  function poolApp(o: { limits?: Parameters<typeof buildApp>[0]['limits']; noPool?: boolean; sponsorScope?: PoolScope } = {}) {
    const sponsor = createSponsor(sponsorKey.secret(), NP, { trustIssuer: PF.ISSUER, trustCodes: ['TESTMXN'], pool: o.sponsorScope ?? PF.SCOPE });
    chain = new FakePoolChain(sponsor, () => Math.floor(clock / 1000));
    poolOps = createPoolOps({
      store: new PostgresPoolOpStore(pool, POOL_MXN, () => clock), chain, scope: PF.SCOPE, asset: POOL_MXN,
      sponsorPublicKey: sponsor.publicKey, isPaymentAccountOf: async (a) => a === paymentAccountOfSigner, networkPassphrase: NP, now: () => clock, recheckMs: 0,
    });
    papp = track(buildApp({
      saga: createSaga({ store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts: makeCashOuts(),
      networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }),
      ...(o.noPool ? {} : { poolOps }), limits: o.limits,
    }));
    return papp;
  }
  const post = (xdr: string, key?: string) =>
    papp.inject({ method: 'POST', url: '/pool/submit', payload: { signedXdr: xdr }, headers: key ? { 'idempotency-key': key } : {} });
  const rows = async () => Number((await pool.query('SELECT count(*) FROM pool_ops')).rows[0].count);
  const supplyOf = (amount: bigint, source = PF.user) =>
    PF.canonical('supply', (d) => { d.requests = [{ request_type: 0, address: PF.FAKE_SAC, amount }]; }, source);

  beforeEach(() => {
    clock = PF.NOW * 1000;
    paymentAccountOfSigner = PF.PAYMENT_ACCOUNT;
    poolApp();
  });

  it('OP-PA the transaction source must be the signer\'s payment account: 422, no row, nothing sent', async () => {
    paymentAccountOfSigner = S.Keypair.random().publicKey();
    const r = await post(PF.canonical('supply'), 'op-pa');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'REFUSED', message: 'transaction source is not the signer\'s payment account' });
    paymentAccountOfSigner = null;
    expect((await post(PF.canonical('supply'), 'op-pa2')).statusCode).toBe(422);
    expect(await rows()).toBe(0);
    expect(chain.sends).toBe(0);
    paymentAccountOfSigner = PF.PAYMENT_ACCOUNT;
    expect((await post(PF.canonical('supply'), 'op-pa3')).statusCode).toBe(201);
  });
  afterEach(async () => { await papp?.close(); });

  it('OP1 201 SUCCESS: MoneyWire amount, string resource fee, no idempotency key', async () => {
    const r = await post(PF.canonical('supply'), 'op1');
    expect(r.statusCode).toBe(201);
    const o = r.json();
    expect(o).toMatchObject({
      account: PF.user.publicKey(), poolId: PF.FAKE_POOL, assetSac: PF.FAKE_SAC, kind: 'supply', status: 'SUCCESS', ledger: 9,
      amount: { amount: '20.0000000', asset: 'TESTMXN', issuer: PF.ISSUER }, resourceFee: '688005', resultCode: null,
    });
    expect(o.id).toMatch(/^pop_[0-9a-f]{32}$/);
    expect(o.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(o.innerHash).not.toBe(o.txHash);
    expect(o).not.toHaveProperty('idemKey');
    expect(chain.sends).toBe(1);
  });

  it('OP2 a replay is 200 with the same row, one send and no token', async () => {
    poolApp({ limits: { poolPerIp: { max: 1, windowMs: 600_000 }, poolPerAccount: { max: 1, windowMs: 600_000 } } });
    const xdr = PF.canonical('supply');
    const first = await post(xdr, 'op2');
    const again = await post(xdr, 'op2');
    expect([first.statusCode, again.statusCode]).toEqual([201, 200]);
    expect(again.json().id).toBe(first.json().id);
    expect(chain.sends).toBe(1);
  });

  it('OP2b a replay after the signed window still gets its row (key before validation)', async () => {
    const xdr = PF.canonical('withdraw');
    const first = (await post(xdr, 'op2b')).json();
    clock += 10 * 60_000;
    const again = await post(xdr, 'op2b');
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(first.id);
  });

  it('OP3 the same key with another blob is 409 IDEMPOTENCY_KEY_REUSED', async () => {
    expect((await post(PF.canonical('supply'), 'op3')).statusCode).toBe(201);
    for (const other of [PF.canonical('withdraw'), 'AAAA']) {
      const r = await post(other, 'op3');
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    }
  });

  it('OP4 the same blob under a new key is 409 DUPLICATE_TRANSACTION', async () => {
    const xdr = PF.canonical('supply');
    expect((await post(xdr, 'op4-a')).statusCode).toBe(201);
    const r = await post(xdr, 'op4-b');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('DUPLICATE_TRANSACTION');
    expect(chain.sends).toBe(1);
  });

  it('OP4b re-posting a recorded blob under new keys takes no account or global token', async () => {
    poolApp({ limits: { poolPerAccount: { max: 2, windowMs: 600_000 }, poolGlobal: { max: 2, windowMs: 86_400_000 } } });
    const xdr = PF.canonical('supply');
    expect((await post(xdr, 'op4b-0')).statusCode).toBe(201);
    for (let i = 1; i <= 5; i++) {
      const r = await post(xdr, `op4b-${i}`);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('DUPLICATE_TRANSACTION');
    }
    expect((await post(supplyOf(7n), 'op4b-next')).statusCode).toBe(201);
  });

  it('OP5 a refused blob is 422 REFUSED: no row, no send, no account token', async () => {
    poolApp({ limits: { poolPerAccount: { max: 1, windowMs: 600_000 } } });
    const r = await post(PF.canonical('withdraw', (d) => { d.requests = [{ request_type: 2, address: PF.FAKE_SAC, amount: PF.AMOUNT }]; }), 'op5');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'REFUSED', message: 'only supply or withdraw' });
    expect(await rows()).toBe(0);
    expect(chain.sends).toBe(0);
    expect((await post(PF.canonical('supply'), 'op5-ok')).statusCode).toBe(201);
    // A request map with a repeated key made scValToNative throw (500): it is a refusal (J-R3).
    const pk = PF.user.publicKey();
    const e = (k: string, v: S.xdr.ScVal) => new S.xdr.ScMapEntry({ key: S.xdr.ScVal.scvSymbol(k), val: v });
    const dup = S.xdr.ScVal.scvMap([e('address', new S.Address(PF.FAKE_SAC).toScVal()), e('amount', S.nativeToScVal(PF.AMOUNT, { type: 'i128' })),
      e('request_type', S.xdr.ScVal.scvU32(1)), e('request_type', S.xdr.ScVal.scvU32(1))]);
    const bad = await post(PF.canonical('withdraw', (d) => { d.args = [...[pk, pk, pk].map((g) => new S.Address(g).toScVal()), S.xdr.ScVal.scvVec([dup])]; }), 'op5-dup');
    expect(bad.statusCode).toBe(422);
    expect(bad.json().error).toMatchObject({ code: 'REFUSED', message: 'malformed request' });
  });

  it('OP6 per IP (31st), per account (11th) and global (3rd with max 2) limits', async () => {
    for (let i = 0; i < 30; i++) expect((await post('AAAA', `op6-ip-${i}`)).statusCode).toBe(422);
    const ip = await post('AAAA', 'op6-ip-30');
    expect(ip.statusCode).toBe(429);
    expect(ip.json().error.code).toBe('RATE_LIMITED');

    poolApp();
    for (let i = 1; i <= 10; i++) expect((await post(supplyOf(BigInt(i)), `op6-acct-${i}`)).statusCode).toBe(201);
    expect((await post(supplyOf(11n), 'op6-acct-11')).statusCode).toBe(429);

    poolApp({ limits: { poolGlobal: { max: 2, windowMs: 86_400_000 } } });
    const users = [S.Keypair.random(), S.Keypair.random(), S.Keypair.random()];
    expect((await post(supplyOf(1n, users[0]), 'op6-g-0')).statusCode).toBe(201);
    expect((await post(supplyOf(1n, users[1]), 'op6-g-1')).statusCode).toBe(201);
    expect((await post(supplyOf(1n, users[2]), 'op6-g-2')).statusCode).toBe(429);
    expect(await rows()).toBe(12);
  });

  it('OP7 a send that throws is a retriable 502 and leaves SUBMITTED; reconcile reads SUCCESS by the envelope hash', async () => {
    chain.next = 'throw';
    const r = await post(PF.canonical('supply'), 'op7');
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatchObject({ code: 'SEND_FAILED', retriable: true });
    const row = (await poolOps.list(PF.user.publicKey(), 10))[0];
    expect(row.status).toBe('SUBMITTED');
    chain.statuses.set(row.txHash!, { status: 'SUCCESS', ledger: 11, feeCharged: 1n });
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 10))[0]).toMatchObject({ status: 'SUBMITTED' }); // not idle 10 s yet
    clock += 11_000;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 10))[0]).toMatchObject({ status: 'SUCCESS', ledger: 11 });
  });

  it('OP7b a replay of a blob whose send threw sends it again: SUCCESS, one row, the same envelope hash', async () => {
    const xdr = PF.canonical('supply');
    chain.next = 'throw';
    expect((await post(xdr, 'op7b')).statusCode).toBe(502);
    chain.next = { status: 'SUCCESS', ledger: 14, feeCharged: 1n };
    const again = await post(xdr, 'op7b');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'SUCCESS', ledger: 14 });
    expect(chain.sends).toBe(2);
    expect(await rows()).toBe(1);
    // A replay of a row that landed sends nothing more.
    expect((await post(xdr, 'op7b')).json().status).toBe('SUCCESS');
    expect(chain.sends).toBe(2);
  });

  it('OP7c a replay of a SUBMITTED blob the network already has finishes it without sending', async () => {
    const xdr = PF.canonical('supply');
    chain.next = 'throw';
    expect((await post(xdr, 'op7c')).statusCode).toBe(502);
    const row = (await poolOps.list(PF.user.publicKey(), 1))[0];
    chain.statuses.set(row.txHash!, { status: 'SUCCESS', ledger: 15, feeCharged: 1n });
    const again = await post(xdr, 'op7c');
    expect(again.json()).toMatchObject({ id: row.id, status: 'SUCCESS', ledger: 15 });
    expect(chain.sends).toBe(1);
  });

  it('OP7d a resend the node refuses without a ledger is not terminal: the envelope hash settles it', async () => {
    for (const [i, refusal] of [{ status: 'FAILED', ledger: null, code: 'try_again_later' }, { status: 'FAILED', ledger: null, code: 'tx_bad_seq' }].entries()) {
      const xdr = supplyOf(BigInt(100 + i));
      clock += 1000;
      chain.next = 'throw';
      expect((await post(xdr, `op7d-${i}`)).statusCode).toBe(502);
      const row = (await poolOps.list(PF.user.publicKey(), 1))[0];
      // The first send did land; the node had not ingested it when the replay read NOT_FOUND.
      chain.next = refusal as PoolSendOutcome;
      chain.afterSend = () => chain.statuses.set(row.txHash!, { status: 'SUCCESS', ledger: 16, feeCharged: 1n });
      const again = await post(xdr, `op7d-${i}`);
      chain.afterSend = undefined;
      expect(again.statusCode).toBe(200);
      expect(again.json()).toMatchObject({ id: row.id, status: 'SUCCESS', ledger: 16, resultCode: null });
    }
  });

  it('OP7e a refused resend whose envelope the node still does not know stays SUBMITTED for the reconciler', async () => {
    const xdr = PF.canonical('supply');
    chain.next = 'throw';
    expect((await post(xdr, 'op7e')).statusCode).toBe(502);
    chain.next = { status: 'FAILED', ledger: null, code: 'tx_bad_seq' };
    clock += 1000;
    const again = await post(xdr, 'op7e');
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ status: 'SUBMITTED', resultCode: null, updatedAt: clock });
    chain.statuses.set(again.json().txHash, { status: 'SUCCESS', ledger: 17, feeCharged: 1n });
    clock += 11_000;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 1))[0]).toMatchObject({ status: 'SUCCESS', ledger: 17 });
  });

  it('OP7f the same inner hash with other signature bytes under the key is 409 IDEMPOTENCY_KEY_REUSED, nothing sent', async () => {
    const xdr = PF.canonical('supply');
    chain.next = 'throw';
    expect((await post(xdr, 'op7f')).statusCode).toBe(502);
    const tx = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    // stellar-sdk 17.4: the hint is an opaque with its bytes in .value; the signature stays valid.
    (tx.signatures[0] as any).hint.value[0] ^= 0xff;
    const mutated = tx.toXDR();
    expect(mutated).not.toBe(xdr);
    const sends = chain.sends;
    const r = await post(mutated, 'op7f');
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(chain.sends).toBe(sends);
    expect((await poolOps.list(PF.user.publicKey(), 1))[0].status).toBe('SUBMITTED');
  });

  it('OP8 NOT_FOUND under 10 minutes is touched, after 10 minutes FAILED not_found', async () => {
    chain.next = { status: 'PENDING' };
    const o = (await post(PF.canonical('supply'), 'op8')).json();
    expect(o.status).toBe('SUBMITTED');
    clock += 11_000;
    await poolOps.reconcile();
    const touched = (await poolOps.list(PF.user.publicKey(), 1))[0];
    expect(touched.status).toBe('SUBMITTED');
    expect(touched.updatedAt).toBe(clock);
    // The node still holds the ledger of the submit (its oldest ledger closed at that very second).
    chain.oldestCloseTime = Math.floor(o.createdAt / 1000);
    clock += POOL_OP_LOST_MS;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 1))[0]).toMatchObject({ status: 'FAILED', resultCode: 'not_found', ledger: null });
  });

  it('OP8c NOT_FOUND from a node that no longer holds the submit\'s ledger is FAILED unknown, not not_found', async () => {
    chain.next = { status: 'PENDING' };
    const o = (await post(PF.canonical('supply'), 'op8c')).json();
    // Corra was down past the node's retention: the op may have landed in a ledger the node dropped.
    clock += POOL_OP_LOST_MS + 60_000;
    chain.oldestCloseTime = Math.floor(o.createdAt / 1000) + 1;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 1))[0]).toMatchObject({ id: o.id, status: 'FAILED', resultCode: 'unknown', ledger: null });
  });

  it('OP8b NOT_FOUND from a node whose last ledger closed inside the signed window stays SUBMITTED', async () => {
    chain.next = { status: 'PENDING' };
    const o = (await post(PF.canonical('supply'), 'op8b')).json();
    // The node is stuck at the submit time: it may simply not have the transaction yet.
    chain.closeTime = () => PF.NOW;
    clock += POOL_OP_LOST_MS + 60_000;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 1))[0]).toMatchObject({ id: o.id, status: 'SUBMITTED', updatedAt: clock });
    // Once it has closed a ledger past the window, the op is lost.
    chain.closeTime = () => Math.floor(clock / 1000);
    clock += 11_000;
    await poolOps.reconcile();
    expect((await poolOps.list(PF.user.publicKey(), 1))[0]).toMatchObject({ status: 'FAILED', resultCode: 'not_found' });
  });

  it('OP9 a transaction that failed in a ledger is stored FAILED with its code', async () => {
    chain.next = { status: 'FAILED', ledger: 12, code: 'op_invoke_host_function_trapped' };
    const r = await post(PF.canonical('supply'), 'op9');
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ status: 'FAILED', resultCode: 'op_invoke_host_function_trapped', ledger: 12 });
  });

  it('OP9b an RPC tx_bad_seq is FAILED with no ledger; a rebuilt blob then lands', async () => {
    chain.next = { status: 'FAILED', ledger: null, code: 'tx_bad_seq' };
    expect((await post(PF.canonical('supply'), 'op9b-a')).json()).toMatchObject({ status: 'FAILED', resultCode: 'tx_bad_seq', ledger: null });
    chain.next = { status: 'SUCCESS', ledger: 13, feeCharged: 1n };
    const rebuilt = await post(PF.canonical('supply', (d) => { d.maxTime = PF.NOW + 299; }), 'op9b-b');
    expect(rebuilt.statusCode).toBe(201);
    expect(rebuilt.json().status).toBe('SUCCESS');
  });

  it('OP10 lists the account\'s ops newest first and checks limit, account and the read budget', async () => {
    const a = (await post(PF.canonical('supply'), 'op10-a')).json();
    clock += 1000;
    const b = (await post(PF.canonical('withdraw'), 'op10-b')).json();
    const list = await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops` });
    expect(list.json().ops.map((o: any) => o.id)).toEqual([b.id, a.id]);
    expect(list.json().ops[0]).not.toHaveProperty('idemKey');
    expect((await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops?limit=1` })).json().ops).toHaveLength(1);
    expect((await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops?limit=400` })).statusCode).toBe(400);
    expect((await papp.inject({ url: '/accounts/GBAD/pool-ops' })).statusCode).toBe(400);
    poolApp({ limits: { readPerIp: { max: 1, windowMs: 60_000 } } });
    expect((await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops` })).statusCode).toBe(200);
    expect((await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops` })).statusCode).toBe(429);
  });

  it('OP11 without a pool both routes are 503 POOL_NOT_CONFIGURED', async () => {
    poolApp({ noPool: true });
    for (const r of [await post(PF.canonical('supply'), 'op11'), await papp.inject({ url: `/accounts/${PF.user.publicKey()}/pool-ops` })]) {
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toMatchObject({ code: 'POOL_NOT_CONFIGURED', retriable: true });
    }
  });

  it('OP12 five parallel posts with one key make one row and one send', async () => {
    const xdr = PF.canonical('supply');
    const rs = await Promise.all(Array.from({ length: 5 }, () => post(xdr, 'op12')));
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(await rows()).toBe(1);
    expect(chain.sends).toBe(1);
  });

  it('OP13 a sponsor scoped to another pool still refuses inside bump', async () => {
    poolApp({ sponsorScope: { ...PF.SCOPE, poolId: S.StrKey.encodeContract(Buffer.alloc(32, 5)) } });
    const r = await post(PF.canonical('supply'), 'op13');
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toMatchObject({ code: 'REFUSED', message: 'only the Corra pool' });
    expect(await rows()).toBe(0);
    expect(chain.sends).toBe(0);
  });

  it('a body without a key, an oversized blob or a missing blob is 400', async () => {
    expect((await post(PF.canonical('supply'))).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post(PF.canonical('supply'), 'k'.repeat(129))).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post('A'.repeat(16_385), 'big')).json().error.code).toBe('BAD_REQUEST');
    expect((await papp.inject({ method: 'POST', url: '/pool/submit', payload: {}, headers: { 'idempotency-key': 'none' } })).statusCode).toBe(400);
  });
});

describe('/setup with a payment account (spec-varial-fix 4.1/4.2, S1)', () => {
  const sponsorKey = S.Keypair.random();
  const SP = sponsorKey.publicKey();
  const sponsor = createSponsor(sponsorKey.secret(), NP, { trustIssuer: fiatAsset('MXN').issuer!, trustCodes: ['TESTMXN', 'TESTPHP'] });
  const NOW_MS = Date.now();
  let lines: AssetId[] | null;
  let existing: string | null;
  let sapp: ReturnType<typeof buildApp>;

  beforeEach(() => {
    lines = null;
    existing = null;
    const chain: SetupChain = { sponsorSequence: async () => '1000', trustlines: async () => lines, paymentAccountOf: async () => existing };
    sapp = track(buildApp({
      saga: createSaga({ store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts: makeCashOuts(),
      networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(),
      prepareSetup: createPrepareSetup({ chain, sponsor, networkPassphrase: NP, now: () => NOW_MS }),
    }));
  });
  afterEach(async () => { await sapp?.close(); });

  const setup = (payload: object) => sapp.inject({ method: 'POST', url: '/setup', payload });
  const parse = (xdr: string) => S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
  const types = (xdr: string) => parse(xdr).operations.map((o) => o.type);

  it('new account: the payment account first (sponsor seq + 1, no sender signature), then the Phase 1 sandwich (seq + 2)', async () => {
    const p = S.Keypair.random().publicKey();
    const z = S.Keypair.random().publicKey();
    const r = await setup({ account: p, trust: ['MXN'], paymentAccount: z });
    expect(r.statusCode).toBe(200);
    const { xdr, paymentAccountXdr } = r.json();
    expect(types(paymentAccountXdr)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'setOptions', 'endSponsoringFutureReserves']);
    const za = parse(paymentAccountXdr);
    expect([za.source, za.sequence]).toEqual([SP, '1001']);
    expect(za.operations[2]).toMatchObject({ source: z, masterWeight: 0, signer: { ed25519PublicKey: p, weight: 1 } });
    // The sender is the source of no operation in it, so it signs nothing (an extra signature is tx_bad_auth_extra).
    expect(za.operations.some((o) => o.source === p)).toBe(false);
    expect(za.signatures).toHaveLength(1);
    expect(types(xdr)).toEqual(['beginSponsoringFutureReserves', 'createAccount', 'changeTrust', 'endSponsoringFutureReserves']);
    expect(parse(xdr).sequence).toBe('1002');
    expect(parse(xdr).operations.some((o) => o.type === 'setOptions')).toBe(false);
  });

  it('existing trusted account without one (4.2): only the payment account, no wallet prompt', async () => {
    lines = [fiatAsset('MXN')];
    const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(r.statusCode).toBe(200);
    expect(r.json().xdr).toBeUndefined();
    expect(parse(r.json().paymentAccountXdr).sequence).toBe('1001');
  });

  it('existing account missing the trustline: begin, changeTrust, end (no createAccount) plus the payment account', async () => {
    lines = [];
    const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(types(r.json().xdr)).toEqual(['beginSponsoringFutureReserves', 'changeTrust', 'endSponsoringFutureReserves']);
    expect(r.json().paymentAccountXdr).toBeTruthy();
  });

  it('an account that already has a payment account gets no second one; the key sent is ignored', async () => {
    existing = S.Keypair.random().publicKey();
    const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(r.statusCode).toBe(200);
    expect(r.json().paymentAccountXdr).toBeUndefined();
    expect(parse(r.json().xdr).sequence).toBe('1001');
  });

  it('nothing to set up: 409 NOTHING_TO_SET_UP', async () => {
    lines = [fiatAsset('MXN')];
    existing = S.Keypair.random().publicKey();
    const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NOTHING_TO_SET_UP');
    // A trusted account without a payment account that sends no key has nothing to set up either.
    existing = null;
    expect((await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'] })).statusCode).toBe(409);
  });

  it('a 409 does not spend the account\'s setup token: the next /setup with a payment account key still works (S3-1)', async () => {
    lines = [fiatAsset('MXN')];
    existing = null;
    const p = S.Keypair.random().publicKey();
    // Anyone can send this for the victim's account: no key, so nothing to set up.
    expect((await setup({ account: p, trust: ['MXN'] })).statusCode).toBe(409);
    const r = await setup({ account: p, trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(r.statusCode).toBe(200);
    expect(r.json().paymentAccountXdr).toBeTruthy();
    // A setup that built the account's own sandwich still spends it.
    lines = [];
    expect((await setup({ account: p, trust: ['MXN'] })).statusCode).toBe(200);
    expect((await setup({ account: p, trust: ['MXN'] })).statusCode).toBe(429);
  });

  it('S4-2 a stranger\'s payment-account-only /setup does not spend the account\'s token: its own /setup still builds', async () => {
    lines = [fiatAsset('MXN')];
    existing = null;
    const victim = S.Keypair.random().publicKey();
    const stranger = await setup({ account: victim, trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(stranger.statusCode).toBe(200);
    expect(stranger.json().xdr).toBeUndefined();
    const own = await setup({ account: victim, trust: ['MXN'], paymentAccount: S.Keypair.random().publicKey() });
    expect(own.statusCode).toBe(200);
    expect(own.json().paymentAccountXdr).toBeTruthy();
  });

  it('a merged payment account (paymentAccountOf null) gets a fresh one (M3)', async () => {
    lines = [fiatAsset('MXN')];
    existing = null;
    const z = S.Keypair.random().publicKey();
    const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: z });
    expect(parse(r.json().paymentAccountXdr).operations[0]).toMatchObject({ sponsoredId: z });
  });

  it('C5-2 a paymentAccount with a bad checksum is a 400 and spends no setup token', async () => {
    lines = [fiatAsset('MXN')];
    const good = S.Keypair.random().publicKey();
    const bad = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect(/^G[A-Z2-7]{55}$/.test(bad) && !S.StrKey.isValidEd25519PublicKey(bad)).toBe(true);
    // More tries than the per-IP setup limit (5): none of them may take a token.
    for (let i = 0; i < 8; i++) {
      const r = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: bad });
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('BAD_REQUEST');
    }
    expect((await setup({ account: bad, trust: ['MXN'] })).statusCode).toBe(400);
    const ok = await setup({ account: S.Keypair.random().publicKey(), trust: ['MXN'], paymentAccount: good });
    expect(ok.statusCode).toBe(200);
  });

  it('refuses a paymentAccount that is not a G key or is the account itself', async () => {
    const p = S.Keypair.random().publicKey();
    for (const paymentAccount of [p, 'GABC', 42, S.Keypair.random().secret()]) {
      const r = await setup({ account: p, trust: ['MXN'], paymentAccount });
      expect(r.statusCode).toBe(400);
    }
  });
});

describe('/setup with channel accounts (Unit 5)', () => {
  const sponsorKey = S.Keypair.random();
  const SP = sponsorKey.publicKey();
  const keys = Array.from({ length: 5 }, () => S.Keypair.random());
  const CH = keys.map((k) => k.publicKey());
  const trust = { trustIssuer: fiatAsset('MXN').issuer!, trustCodes: ['TESTMXN', 'TESTPHP'] };
  const sponsor = createSponsor(sponsorKey.secret(), NP, { ...trust, channels: CH });
  const NOW_MS = Date.now();
  let lines: AssetId[] | null;
  let existing: string | null;
  /** The channels' on-chain sequences, as Horizon reports them. */
  let seqs: Map<string, bigint>;
  let logged: ({ evt: string } & Record<string, unknown>)[];
  let capp: ReturnType<typeof buildApp>;

  function channelApp(limits: Parameters<typeof buildApp>[0]['limits'] = LOCAL_SETUP_LIMITS) {
    const chain: SetupChain = { sponsorSequence: async () => '1000', trustlines: async () => lines, paymentAccountOf: async () => existing };
    const channels = createChannels(keys.map((k) => k.secret()), {
      networkPassphrase: NP, sequenceOf: async (pk) => seqs.get(pk) ?? null, allowed: CH, sponsor: SP, trust,
    });
    return track(buildApp({
      saga: createSaga({ store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts: makeCashOuts(),
      networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(),
      prepareSetup: createPrepareSetup({ chain, sponsor, channels, networkPassphrase: NP, now: () => NOW_MS, log: (l) => logged.push(l) }),
      limits,
    }));
  }

  beforeEach(() => {
    lines = null;
    existing = null;
    seqs = new Map(CH.map((c) => [c, 7000n]));
    logged = [];
    capp = channelApp();
  });

  const setup = (payload: object) => capp.inject({ method: 'POST', url: '/setup', payload });
  const parse = (xdr: string) => S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
  const signedBy = (tx: S.Transaction, pk: string) => tx.signatures.some((sig) => S.Keypair.fromPublicKey(pk).verify(tx.hash(), sig.signature));
  const fresh = () => S.Keypair.random().publicKey();
  /** The transaction source and sequence of a returned XDR. */
  const at = (xdr: string) => { const t = parse(xdr); return [t.source, t.sequence]; };

  it('ST1 new account + payment account: both on one channel at 7001/7002, signed by the sponsor and the channel; begin by the sponsor', async () => {
    const p = fresh();
    const z = fresh();
    const r = await setup({ account: p, trust: ['MXN'], paymentAccount: z });
    expect(r.statusCode).toBe(200);
    const { xdr, paymentAccountXdr } = r.json();
    expect(at(paymentAccountXdr)).toEqual([CH[0], '7001']);
    expect(at(xdr)).toEqual([CH[0], '7002']);
    for (const x of [paymentAccountXdr, xdr]) {
      const t = parse(x);
      expect(t.signatures).toHaveLength(2);
      expect(signedBy(t, SP) && signedBy(t, CH[0])).toBe(true);
      expect(t.operations[0]).toMatchObject({ type: 'beginSponsoringFutureReserves', source: SP });
    }
    expect(() => assertPaymentAccountSetup(paymentAccountXdr, p, z, NP, SP)).not.toThrow();
    expect(logged).toEqual([{ evt: 'setup.channel', source: 'channel', channel: CH[0], txs: 2, reason: undefined }]);
  });

  it('ST2 three concurrent /setup for new accounts get three distinct channels', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => setup({ account: fresh(), trust: ['MXN'], paymentAccount: fresh() })));
    const sources = rs.map((r) => parse(r.json().xdr).source);
    expect(new Set(sources).size).toBe(3);
    for (const r of rs) expect(parse(r.json().paymentAccountXdr).source).toBe(parse(r.json().xdr).source);
  });

  it('ST3 six concurrent: five channels and one sponsor-sourced fallback at s+1/s+2, logged all_leased', async () => {
    const rs = await Promise.all(Array.from({ length: 6 }, () => setup({ account: fresh(), trust: ['MXN'], paymentAccount: fresh() })));
    expect(rs.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    const pairs = rs.map((r) => [at(r.json().paymentAccountXdr), at(r.json().xdr)]);
    const fallback = pairs.filter(([pa]) => pa[0] === SP);
    expect(fallback).toEqual([[[SP, '1001'], [SP, '1002']]]);
    expect(new Set(pairs.filter(([pa]) => pa[0] !== SP).map(([pa]) => pa[0]))).toEqual(new Set(CH));
    expect(logged.filter((l) => l.source === 'sponsor')).toEqual([{ evt: 'setup.channel', source: 'sponsor', channel: undefined, txs: 2, reason: 'all_leased' }]);
  });

  it('ST4 existing account lacking its trustline + payment account: the payment account on a channel at 7001, its own setup on the sponsor at s+1', async () => {
    lines = [];
    const r = (await setup({ account: fresh(), trust: ['MXN'], paymentAccount: fresh() })).json();
    expect(at(r.paymentAccountXdr)).toEqual([CH[0], '7001']);
    expect(at(r.xdr)).toEqual([SP, '1001']);
    expect(parse(r.xdr).signatures).toHaveLength(1);
  });

  it('ST5 existing trusted account + payment account: only the payment account, on a channel', async () => {
    lines = [fiatAsset('MXN')];
    const r = (await setup({ account: fresh(), trust: ['MXN'], paymentAccount: fresh() })).json();
    expect(r.xdr).toBeUndefined();
    expect(at(r.paymentAccountXdr)).toEqual([CH[0], '7001']);
  });

  it('ST6 existing account lacking its trustline that has a payment account: sponsor only, no lease taken', async () => {
    lines = [];
    existing = fresh();
    const r = (await setup({ account: fresh(), trust: ['MXN'] })).json();
    expect(at(r.xdr)).toEqual([SP, '1001']);
    expect(logged).toEqual([]);
    lines = null;
    existing = null;
    expect(at((await setup({ account: fresh(), trust: ['MXN'] })).json().xdr)).toEqual([CH[0], '7001']);
  });

  it('ST7 the per-account limit is a 429 before any lease is taken', async () => {
    const p = fresh();
    expect(at((await setup({ account: p, trust: ['MXN'] })).json().xdr)[0]).toBe(CH[0]);
    const limited = await setup({ account: p, trust: ['MXN'] });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toEqual({ code: 'RATE_LIMITED', message: 'too many requests, try again later', retriable: true });
    expect(at((await setup({ account: fresh(), trust: ['MXN'] })).json().xdr)[0]).toBe(CH[1]);
    expect(logged.map((l) => l.channel)).toEqual([CH[0], CH[1]]);
  });

  it('ST8 a refusal after acquire is a 422 and frees the channel', async () => {
    const r = await setup({ account: fresh(), trust: ['BRL'] }); // a fiat the sponsor's scope does not sponsor
    expect(r.statusCode).toBe(422);
    expect(r.json().error.code).toBe('REFUSED');
    const after = await Promise.all(Array.from({ length: 5 }, () => setup({ account: fresh(), trust: ['MXN'] })));
    expect(new Set(after.map((x) => at(x.json().xdr)[0]))).toEqual(new Set(CH));
  });

  it('ST9 a 409 NOTHING_TO_SET_UP leases nothing', async () => {
    lines = [fiatAsset('MXN')];
    existing = fresh();
    expect((await setup({ account: fresh(), trust: ['MXN'], paymentAccount: fresh() })).statusCode).toBe(409);
    expect(logged).toEqual([]);
  });

  it('ST10 new account without a payment-account key: its setup on the channel at 7001; released early once the channel reaches 7001', async () => {
    expect(at((await setup({ account: fresh(), trust: ['MXN'] })).json().xdr)).toEqual([CH[0], '7001']);
    for (let i = 1; i < 5; i++) expect(at((await setup({ account: fresh(), trust: ['MXN'] })).json().xdr)[0]).toBe(CH[i]);
    seqs.set(CH[0], 7001n); // the setup landed
    expect(at((await setup({ account: fresh(), trust: ['MXN'] })).json().xdr)).toEqual([CH[0], '7002']);
  });

  it('ST11 a channel refusal is a 422 REFUSED (the server builds what it signs, so it is a server bug)', async () => {
    const refusing = track(buildApp({
      saga: createSaga({ store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: gw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts: makeCashOuts(), networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => { throw new ChannelRefusal('channel account is not leased'); },
    }));
    const r = await refusing.inject({ method: 'POST', url: '/setup', payload: { account: fresh(), trust: ['MXN'] } });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toEqual({ code: 'REFUSED', message: 'channel account is not leased', retriable: false });
  });

  it('LL1 LOCAL_SETUP_LIMITS: the 6th /setup from one IP is not 429; the default limits answer 429', async () => {
    for (const [a, sixth] of [[capp, 200], [app, 429]] as const) {
      const codes = [];
      for (let i = 0; i < 6; i++) codes.push((await a.inject({ method: 'POST', url: '/setup', payload: { account: fresh(), trust: ['MXN'] } })).statusCode);
      expect(codes).toEqual([200, 200, 200, 200, 200, sixth]);
    }
  });
});

describe('D3 cash-out', () => {
  const PHP = { code: 'TESTPHP', issuer: ISSUER };
  const R = S.Keypair.random();
  const Z = S.Keypair.random().publicKey();
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

  /** The chain for a recipient R with payment account Z at sequence 7000 holding 1000 TESTPHP; landed envelopes are kept. */
  class CashOutGateway extends FakeGateway {
    envelopes = new Map<string, string>();
    lagging = false;
    php: Money | null = fromDecimal(PHP, '1000');
    constructor() {
      super();
      this.paymentAccount = Z;
      this.sequence = 7000n;
    }
    async accountBalance() { return this.php; }
    async getTransaction(h: string) {
      const s = this.lagging ? undefined : this.landed.get(h);
      return s ? { status: s, ledger: 7, hash: `env-${h}`, envelopeXdr: this.envelopes.get(h) } : { status: 'NOT_FOUND' as const };
    }
    async submitPayment(xdr: string): Promise<SubmitOutcome> {
      const out = await super.submitPayment(xdr);
      const inner = hex((S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction).hash());
      this.envelopes.set(inner, xdr);
      return out.kind === 'success' ? { kind: 'success', hash: `env-${inner}`, ledger: 7 } : out;
    }
  }

  let cgw: CashOutGateway;
  let capp: ReturnType<typeof buildApp>;
  let n = 0;
  const spies = { onCashIn: 0, deposits: 0, cashOuts: 0 };

  function cashOutApp(o: { spy?: boolean } = {}) {
    const saga = createSaga({ store, gateway: cgw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' });
    const deposits = createDeposits({ store: new PostgresDepositStore(pool), gateway: cgw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN });
    const cashOuts = makeCashOuts(cgw);
    if (o.spy) {
      const [a, b, c] = [saga.onCashIn, deposits.onCallback, cashOuts.onCallback];
      saga.onCashIn = (ev) => { spies.onCashIn++; return a(ev); };
      deposits.onCallback = (ev) => { spies.deposits++; return b(ev); };
      cashOuts.onCallback = (ev) => { spies.cashOuts++; return c(ev); };
    }
    return track(buildApp({
      saga, deposits, cashOuts, networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }),
    }));
  }

  beforeEach(() => {
    cgw = new CashOutGateway();
    capp = cashOutApp();
    Object.assign(spies, { onCashIn: 0, deposits: 0, cashOuts: 0 });
  });
  afterAll(async () => { await capp?.close(); });

  /** A CREDITED payment to R, written as CREDITED writes it (or with a given cash_out leg), straight into Postgres. */
  async function credited(cashOut?: Partial<Payment['legs'][number]>) {
    n++;
    const dest = fromDecimal(PHP, '1000');
    const corridor = { from: { country: 'MX', currency: 'MXN' }, to: { country: 'PH', currency: 'PHP' } } as const;
    const quote: Quote = { id: `qt_d3_${n}`, mode: 'strict_receive', corridor, source: fromDecimal(MXN, '300'), dest, path: [],
      maxSend: fromDecimal(MXN, '305'), slippageBps: 150, expiresAt: Date.now() + 60_000 };
    await store.saveQuote(quote);
    const p: Payment = {
      id: `pmt_d3_${n}`, publicId: `CORRA-D3${String(n).padStart(4, '0')}`, kind: 'balance', senderAccount: sender.publicKey(),
      recipientAccount: R.publicKey(), corridor, quote, state: 'CREDITED',
      legs: [
        { kind: 'onchain', status: 'CONFIRMED', amount: dest, txHash: `onchain_d3_${n}` },
        { kind: 'cash_out', status: 'PENDING', amount: dest, anchorId: 'corra-anchor', ...cashOut },
      ],
      idemKey: `idem_d3_${n}`, signedXdr: null, innerTxHash: `inner_d3_${n}`, maxTime: Math.floor(Date.now() / 1000), supersedesId: null,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    await store.createPayment(p, [{ type: 'CREDITED', from: 'ONCHAIN', to: 'CREDITED', data: { txHash: `onchain_d3_${n}`, ledger: 1 } }]);
    return p;
  }

  function blob(memo = '881016339300600955', amount = '1000') {
    const tx = buildCashOutPayment({
      networkPassphrase: NP, recipient: R.publicKey(), paymentAccount: Z, paymentSequence: '7000', destination: ANCHOR_DIST,
      amount: fromDecimal(PHP, amount), memo: { type: 'id', value: memo }, now: Math.floor(Date.now() / 1000),
    });
    tx.sign(R);
    return { xdr: tx.toXDR(), hash: hex(tx.hash()) };
  }
  const submit = (a: ReturnType<typeof buildApp>, id: string, payload: object) =>
    a.inject({ method: 'POST', url: `/payments/${id}/cash-out/submit`, payload });

  it('OC2 submit: 200 {txHash, ledger, replay: false, payment}; the leg holds ref and hash; events from/to CREDITED, gapless; still CREDITED', async () => {
    const p = await credited();
    const b = blob();
    const r = await submit(capp, p.id, { ref: 'ap-w-1', signedXdr: b.xdr });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ txHash: `env-${b.hash}`, ledger: 7, replay: false });
    expect(body.payment.state).toBe('CREDITED');
    expect(body.payment.legs.find((l: any) => l.kind === 'cash_out')).toMatchObject({ status: 'PENDING', externalRef: 'ap-w-1', txHash: b.hash });
    expect(body.payment.events.map((e: any) => [e.seq, e.type, e.from, e.to])).toEqual([
      [1, 'CREDITED', 'ONCHAIN', 'CREDITED'], [2, 'CASH_OUT_SUBMITTED', 'CREDITED', 'CREDITED'], [3, 'CASH_OUT_ONCHAIN', 'CREDITED', 'CREDITED'],
    ]);
    const row = (await pool.query('SELECT state, updated_at FROM payments WHERE id = $1', [p.id])).rows[0];
    expect(row.state).toBe('CREDITED');
  });

  it('OC3 400: a missing or malformed ref, a non-string or oversized signedXdr', async () => {
    const p = await credited();
    for (const payload of [
      { signedXdr: blob().xdr }, { ref: 'bad ref!', signedXdr: blob().xdr }, { ref: 'x'.repeat(129), signedXdr: blob().xdr },
      { ref: 'ap-w-1' }, { ref: 'ap-w-1', signedXdr: 42 }, { ref: 'ap-w-1', signedXdr: 'A'.repeat(4097) },
    ]) {
      const r = await submit(capp, p.id, payload);
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('BAD_REQUEST');
    }
    expect(cgw.submits).toBe(0);
  });

  it('OC4 Postgres: one ref on two payments is 409 CASH_OUT_REF_TAKEN; one blob on two legs is 409 DUPLICATE_TRANSACTION', async () => {
    const a = await credited();
    const b = await credited();
    cgw.lagging = true; // nothing visible on chain yet, so only the database constraints decide
    const one = blob('1'); // built once: a second build in the next second has another maxTime, so another hash
    expect((await submit(capp, a.id, { ref: 'ap-w-1', signedXdr: one.xdr })).statusCode).toBe(200);
    const taken = await submit(capp, b.id, { ref: 'ap-w-1', signedXdr: blob('2').xdr });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error.code).toBe('CASH_OUT_REF_TAKEN');
    const dup = await submit(capp, b.id, { ref: 'ap-w-2', signedXdr: one.xdr });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('DUPLICATE_TRANSACTION');
    const legB = (await pool.query("SELECT external_ref, tx_hash FROM legs WHERE payment_id = $1 AND kind = 'cash_out'", [b.id])).rows[0];
    expect(legB).toEqual({ external_ref: null, tx_hash: null });
  });

  it('OC5 Postgres CAS: two processes submit different blobs for one leg at once: one 200, one 409 CASH_OUT_IN_PROGRESS; null clears tx_hash', async () => {
    const p = await credited();
    const other = cashOutApp();
    try {
      cgw.lagging = true;
      let open!: () => void;
      cgw.gate = new Promise<void>((r) => { open = r; });
      const both = Promise.all([
        submit(capp, p.id, { ref: 'ap-w-1', signedXdr: blob('1').xdr }),
        submit(other, p.id, { ref: 'ap-w-2', signedXdr: blob('2').xdr }),
      ]);
      await waitFor(async () => cgw.submits >= 1);
      open();
      const codes = (await both).map((r) => (r.statusCode === 200 ? 200 : r.json().error.code)).sort();
      expect(codes).toEqual([200, 'CASH_OUT_IN_PROGRESS']);
      expect(cgw.submits).toBe(1);
    } finally {
      await other.close();
    }
    const leg = (await store.getPayment(p.id))!.legs.find((l) => l.kind === 'cash_out')!;
    const cleared = await store.recordCashOut(p.id, leg.txHash!, { txHash: null }, { type: 'X', from: 'CREDITED', to: 'CREDITED' });
    expect(cleared!.legs.find((l) => l.kind === 'cash_out')).not.toHaveProperty('txHash');
    const row = (await pool.query("SELECT external_ref, tx_hash FROM legs WHERE payment_id = $1 AND kind = 'cash_out'", [p.id])).rows[0];
    expect(row.tx_hash).toBeNull();
    expect(row.external_ref).toBe(leg.externalRef);
    expect(await store.recordCashOut(p.id, 'stale', { txHash: 'h' }, { type: 'X', from: 'CREDITED', to: 'CREDITED' })).toBeNull();
  });

  it('OC5b (C4-1) Postgres unless guard: two concurrent writers of a once-per-key event append it once; null and other keys match exactly', async () => {
    const p = await credited();
    const at = (await store.getPayment(p.id))!.legs.find((l) => l.kind === 'cash_out')!.txHash ?? null;
    const ev = (data: Record<string, unknown>) => ({ type: 'CASH_OUT_ANCHOR_FAILED', from: 'CREDITED' as const, to: 'CREDITED' as const, data });
    const unless = (match: Record<string, unknown>) => ({ type: 'CASH_OUT_ANCHOR_FAILED', match });
    const both = await Promise.all([
      store.recordCashOut(p.id, at, {}, ev({ ref: 'r', anchorStatus: null, paid: false }), unless({ ref: 'r', anchorStatus: null })),
      store.recordCashOut(p.id, at, {}, ev({ ref: 'r', anchorStatus: null, paid: false }), unless({ ref: 'r', anchorStatus: null })),
    ]);
    expect(both.filter((x) => x !== null)).toHaveLength(1);
    expect(await store.recordCashOut(p.id, at, {}, ev({ ref: 'r', anchorStatus: 'expired' }), unless({ ref: 'r', anchorStatus: 'expired' }))).not.toBeNull();
    expect(await store.recordCashOut(p.id, at, {}, ev({ ref: 'r2', anchorStatus: 'expired' }), unless({ ref: 'r2', anchorStatus: 'expired' }))).not.toBeNull();
    expect(await store.recordCashOut(p.id, at, {}, ev({ ref: 'r' }), { type: 'CASH_OUT_MISMATCH', match: { ref: 'r' } })).not.toBeNull();
    const failed = (await store.events(p.id)).filter((e) => e.type === 'CASH_OUT_ANCHOR_FAILED').map((e) => [e.data?.ref, e.data?.anchorStatus ?? null]);
    expect(failed).toEqual([['r', null], ['r', 'expired'], ['r2', 'expired'], ['r', null]]);
  });

  it('OC6 the 6th new withdrawal payment from one IP in 10 minutes is 429; a replay of an accepted blob is still 200', async () => {
    const ps = [];
    for (let i = 0; i < 6; i++) ps.push(await credited());
    const first = blob('100');
    expect((await submit(capp, ps[0].id, { ref: 'ap-w-0', signedXdr: first.xdr })).statusCode).toBe(200);
    for (let i = 1; i < 5; i++) {
      cgw.sequence = 7000n;
      expect((await submit(capp, ps[i].id, { ref: `ap-w-${i}`, signedXdr: blob(String(100 + i)).xdr })).statusCode).toBe(200);
    }
    const sixth = await submit(capp, ps[5].id, { ref: 'ap-w-5', signedXdr: blob('105').xdr });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('RATE_LIMITED');
    const replay = await submit(capp, ps[0].id, { ref: 'ap-w-0', signedXdr: first.xdr });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replay).toBe(true);
  }, 20_000);

  const withdrawalBody = (id: string, status: string, extra: object = {}) => ({
    transaction: { id, kind: 'withdrawal', status, withdraw_anchor_account: ANCHOR_DIST, withdraw_memo: '881016339300600955', withdraw_memo_type: 'id', ...extra },
  });

  it('OC7 a signed withdrawal callback reaches only the cash-out; completed + the chain -> CONFIRMED; unsigned -> 401', async () => {
    await capp.close();
    capp = cashOutApp({ spy: true });
    const p = await credited();
    const b = blob();
    expect((await submit(capp, p.id, { ref: 'ap-w-1', signedXdr: b.xdr })).statusCode).toBe(200);

    const pending = await capp.inject(signedCallback(withdrawalBody('ap-w-1', 'pending_anchor')));
    expect(pending.statusCode).toBe(200);
    await waitFor(async () => spies.cashOuts === 1);
    const done = await capp.inject(signedCallback(withdrawalBody('ap-w-1', 'completed', {
      stellar_transaction_id: `env-${b.hash}`, external_transaction_id: 'sim-cash-pickup-ap-w-1', more_info_url: 'http://localhost:8091/sep24/more_info?transaction_id=ap-w-1',
    })));
    expect(done.statusCode).toBe(200);
    await waitFor(async () => (await store.getPayment(p.id))!.legs.find((l) => l.kind === 'cash_out')!.status === 'CONFIRMED');
    expect(spies).toEqual({ onCashIn: 0, deposits: 0, cashOuts: 2 });
    const wire = (await capp.inject({ url: `/payments/${p.id}` })).json();
    expect(wire.state).toBe('CREDITED');
    expect(wire.events.map((e: any) => e.type)).toEqual(['CREDITED', 'CASH_OUT_SUBMITTED', 'CASH_OUT_ONCHAIN', 'CASH_OUT_ANCHOR_COMPLETED', 'CASHED_OUT']);
    expect(wire.events.at(-1).data).toMatchObject({ payout: 'sim-cash-pickup-ap-w-1', txHash: `env-${b.hash}` });

    const unsigned = await capp.inject({ method: 'POST', url: '/callbacks/sep24', payload: withdrawalBody('ap-w-1', 'completed'), headers: { host: HOST } });
    expect(unsigned.statusCode).toBe(401);
    // A deposit callback still goes to the saga and the deposits, not the cash-out.
    await capp.inject(signedCallback({ transaction: { id: 'ap-d-1', kind: 'deposit', status: 'completed' } }));
    await waitFor(async () => spies.deposits === 1);
    expect(spies).toEqual({ onCashIn: 1, deposits: 1, cashOuts: 2 });
  });

  it('OC7b (C2-1) a completed or stopped withdrawal callback is recorded before the 200; a throw answers 503 so the anchor resends', async () => {
    const p = await credited();
    const b = blob();
    expect((await submit(capp, p.id, { ref: 'ap-w-1', signedXdr: b.xdr })).statusCode).toBe(200);
    const done = await capp.inject(signedCallback(withdrawalBody('ap-w-1', 'completed', { stellar_transaction_id: `env-${b.hash}` })));
    expect(done.statusCode).toBe(200);
    // No waiting: the 200 means it is written.
    expect((await store.getPayment(p.id))!.legs.find((l) => l.kind === 'cash_out')!.status).toBe('CONFIRMED');

    const cashOuts = makeCashOuts(cgw);
    cashOuts.onCallback = async () => { throw new Error('db down'); };
    const failing = track(buildApp({
      saga: createSaga({ store, gateway: cgw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: cgw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts, networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }),
    }));
    try {
      for (const status of ['completed', 'error', 'expired', 'refunded']) {
        const r = await failing.inject(signedCallback(withdrawalBody('ap-w-2', status)));
        expect(r.statusCode).toBe(503);
        expect(r.json().error).toMatchObject({ code: 'CALLBACK_NOT_RECORDED', retriable: true });
      }
      // An intermediate status is only a trigger: still a fast 200.
      expect((await failing.inject(signedCallback(withdrawalBody('ap-w-2', 'pending_anchor')))).statusCode).toBe(200);
    } finally {
      await failing.close();
    }
  });

  it('DR2 app.close() waits for a non-terminal withdrawal callback still being handled', async () => {
    const cashOuts = makeCashOuts(cgw);
    let finish!: () => void;
    let handled = false;
    cashOuts.onCallback = async () => { await new Promise<void>((r) => (finish = r)); handled = true; return null; };
    const slow = track(buildApp({
      saga: createSaga({ store, gateway: cgw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: cgw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts, networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }),
    }));
    expect((await slow.inject(signedCallback(withdrawalBody('ap-w-1', 'pending_anchor')))).statusCode).toBe(200);
    await waitFor(async () => finish !== undefined);
    let closed = false;
    const closing = slow.close().then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 100));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(handled).toBe(true);
  });

  it('DR4 a terminal withdrawal callback that outlives callbackWorkMs answers 503, and app.close() waits until its write is visible', async () => {
    const p = await credited();
    const b = blob();
    expect((await submit(capp, p.id, { ref: 'ap-w-1', signedXdr: b.xdr })).statusCode).toBe(200);
    const cashOuts = makeCashOuts(cgw);
    const real = cashOuts.onCallback;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    cashOuts.onCallback = async (ev) => { await gate; return real(ev); };
    const slow = track(buildApp({
      saga: createSaga({ store, gateway: cgw, networkPassphrase: NP, corridorIssuer: ISSUER, anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor' }),
      deposits: createDeposits({ store: new PostgresDepositStore(pool), gateway: cgw, anchorId: 'corra-anchor', anchorDistribution: ANCHOR_DIST, asset: MXN }),
      cashOuts, networkPassphrase: NP, corsOrigins: [], clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
      anchorSigningKey: async () => anchorKey.publicKey(), prepareSetup: async () => ({ xdr: 'unused' }), callbackWorkMs: 50,
    }));
    const r = await slow.inject(signedCallback(withdrawalBody('ap-w-1', 'completed', { stellar_transaction_id: `env-${b.hash}` })));
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('CALLBACK_NOT_RECORDED');
    let closed = false;
    const closing = slow.close().then(() => { closed = true; });
    await new Promise((res) => setTimeout(res, 100));
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await store.getPayment(p.id))!.legs.find((l) => l.kind === 'cash_out')!.status).toBe('CONFIRMED');
  });

  it('OC8 parseSep24Callback: withdrawal fields, refunded -> FAILED, anchorStatus kept, no account; deposits unchanged; kind withdraw -> null', () => {
    const w = parseSep24Callback(withdrawalBody('w1', 'completed', {
      stellar_transaction_id: 'abc', external_transaction_id: 'sim-cash-pickup-w1', more_info_url: 'https://a.test/more', to: ANCHOR_DIST, from: R.publicKey(),
    }), 5);
    expect(w).toEqual({
      ref: 'w1', kind: 'withdrawal', status: 'CONFIRMED', anchorStatus: 'completed', stellarTxId: 'abc', moreInfoUrl: 'https://a.test/more',
      withdrawMemo: { type: 'id', value: '881016339300600955' }, externalId: 'sim-cash-pickup-w1', at: 5, raw: expect.anything(),
    });
    const hashHex = 'ab'.repeat(32);
    expect(parseSep24Callback(withdrawalBody('w2', 'pending_anchor', { withdraw_memo: hashHex, withdraw_memo_type: 'hash' }), 5)!.withdrawMemo)
      .toEqual({ type: 'hash', value: Buffer.from(hashHex, 'hex').toString('base64') });
    expect(parseSep24Callback(withdrawalBody('w3', 'pending_anchor', { withdraw_memo: 'pickup 7', withdraw_memo_type: 'text' }), 5)!.withdrawMemo)
      .toEqual({ type: 'text', value: 'pickup 7' });
    expect(parseSep24Callback(withdrawalBody('w4', 'pending_anchor', { withdraw_memo: '12x', withdraw_memo_type: 'id' }), 5)).not.toHaveProperty('withdrawMemo');
    expect(parseSep24Callback(withdrawalBody('w5', 'refunded'), 5)).toMatchObject({ status: 'FAILED', anchorStatus: 'refunded' });
    expect(parseSep24Callback(withdrawalBody('w6', 'pending_user_transfer_start'), 5)).toMatchObject({ status: 'PENDING', anchorStatus: 'pending_user_transfer_start' });
    expect(parseSep24Callback(withdrawalBody('w7', 'completed', { external_transaction_id: 'bad id!' }), 5)).not.toHaveProperty('externalId');

    const d = parseSep24Callback({ transaction: { id: 'd1', kind: 'deposit', status: 'refunded', to: R.publicKey(),
      deposit_memo: 'ab'.repeat(32), deposit_memo_type: 'hash', withdraw_memo: '1', withdraw_memo_type: 'id', external_transaction_id: 'x' } }, 5);
    expect(d).toEqual({ ref: 'd1', kind: 'deposit', status: 'PENDING', anchorStatus: 'refunded', account: R.publicKey(),
      depositMemo: Buffer.from('ab'.repeat(32), 'hex').toString('base64'), at: 5, raw: expect.anything() });
    expect(parseSep24Callback({ transaction: { id: 'x', kind: 'withdraw', status: 'completed' } }, 5)).toBeNull();
  });

  it('OC9 migration 003: the in-flight and tx-hash indexes with their predicates, the old open index gone', async () => {
    const idx = (await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'legs'")).rows;
    const def = (name: string) => idx.find((i) => i.indexname === name)?.indexdef ?? '';
    expect(def('legs_cash_out_inflight_idx')).toMatch(/\(updated_at\) WHERE \(\(kind = 'cash_out'::text\) AND \(status = 'PENDING'::text\) AND \(tx_hash IS NOT NULL\)\)/);
    expect(def('legs_cash_out_tx_key')).toMatch(/UNIQUE INDEX .* \(tx_hash\) WHERE \(\(kind = 'cash_out'::text\) AND \(tx_hash IS NOT NULL\)\)/);
    expect(idx.map((i) => i.indexname)).not.toContain('legs_cash_out_open_idx');
  });

  it('OC10 a Phase 1 CREDITED payment (cash_out CONFIRMED mock-payout:) is 409 ALREADY_CASHED_OUT and never an open cash-out', async () => {
    const p = await credited({ status: 'CONFIRMED', externalRef: 'mock-payout:CORRA-OLD', anchorId: undefined });
    const r = await submit(capp, p.id, { ref: 'ap-w-1', signedXdr: blob().xdr });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('ALREADY_CASHED_OUT');
    expect(await store.listOpenCashOuts(0, Date.now() + 1000, 25)).toEqual([]);
  });
});

describe('J44 the database pool survives a killed connection', () => {
  const terminate = (pid: number) => pool.query('SELECT pg_terminate_backend($1)', [pid]);

  it('DB1 an idle client killed by the server calls onError within 2 s and the pool answers again', async () => {
    const errors: Error[] = [];
    const db = createDbPool(urlOf(dbName('corra_test')), (e) => errors.push(e));
    try {
      const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await terminate(pid);
      for (let i = 0; i < 40 && !errors.length; i++) await new Promise((r) => setTimeout(r, 50));
      expect(errors.length).toBeGreaterThan(0);
      expect((await db.query('SELECT 1 AS one')).rows[0].one).toBe(1);
    } finally {
      await db.end();
    }
  });

  it('DB2 a query killed mid-run rejects, and the store reads again on the same pool', async () => {
    const db = createDbPool(urlOf(dbName('corra_test')), () => {});
    const sleeping = async () => {
      for (let i = 0; i < 40; i++) {
        const r = await pool.query("SELECT pid FROM pg_stat_activity WHERE query = 'SELECT pg_sleep(5)' AND datname = current_database()");
        if (r.rows[0]) return r.rows[0].pid as number;
        await new Promise((res) => setTimeout(res, 25));
      }
      throw new Error('pg_sleep not seen');
    };
    try {
      // As the stores query: through the pool (released with the error), and inside a transaction (ROLLBACK, then release).
      // The rejection is caught at once: it lands while terminate() is still awaited.
      const running = db.query('SELECT pg_sleep(5)').then(() => null, (e: Error) => e);
      await terminate(await sleeping());
      expect(await running).toBeInstanceOf(Error);
      expect(await new PostgresSagaStore(db).getPayment('pmt_x')).toBeNull();

      const client = await db.connect();
      const inTx = client.query('SELECT pg_sleep(5)').then(() => null, (e: Error) => e);
      await terminate(await sleeping());
      expect(await inTx).toBeInstanceOf(Error);
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      expect(await new PostgresSagaStore(db).getPayment('pmt_x')).toBeNull();
    } finally {
      await db.end();
    }
  });
});

describe('shutdown with an open event stream (C3-1)', () => {
  it('app.close() ends an open SSE stream at once, so drainAndClose reaches the pool', async () => {
    const { q, signedXdr } = await quoteAndSign();
    const p = (await confirm({ quoteId: q.id, sender: sender.publicKey(), recipient, signedXdr }, 'k-sse')).json();
    expect(p.state).toBe('SIGNED'); // not terminal: the stream would stay open for 35 minutes
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/payments/${p.id}/events`);
    const reader = res.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('event: state');
    const ended = (async () => { while (!(await reader.read()).done); })();

    const events: string[] = [];
    const t0 = Date.now();
    await drainAndClose({ halt: () => events.push('halt'), stop: async () => { events.push('loop.stop'); } },
      async () => { await app.close(); events.push(`app.closed:${Date.now() - t0 < 1_500}`); },
      async () => { events.push('pool.end'); });
    expect(events).toEqual(['halt', 'app.closed:true', 'loop.stop', 'pool.end']);
    await ended; // the client saw the stream end
  }, 10_000);
});
