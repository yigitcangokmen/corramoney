/**
 * Integration tests: HTTP API + saga + real Postgres. Needs `docker compose up -d postgres`.
 * The chain is faked (FakeGateway) so the tests are deterministic and offline.
 */
import * as S from '@stellar/stellar-sdk';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cashInMemo, fromDecimal, moneyFromWire, type Money } from '@corra/shared';
import { buildStrictReceive, type Deposit, type PathResult, type StellarGateway, type SubmitOutcome } from '@corra/stellar';
import { createSaga } from '@corra/settlement-saga';
import { buildApp } from './app';
import { createClientDomainSigner } from './client-domain';
import { migrate, PostgresSagaStore } from './db/store';

const NP = S.Networks.TESTNET;
const ISSUER = S.Keypair.random().publicKey();
const ANCHOR_DIST = S.Keypair.random().publicKey();
const anchorKey = S.Keypair.random();
const clientDomainKey = S.Keypair.random();
const USDC = { code: 'USDC', issuer: S.Keypair.random().publicKey() };
const MXN = { code: 'TESTMXN', issuer: ISSUER };
const HOST = 'host.docker.internal:8787';
const BASE_URL = process.env.DATABASE_URL ?? 'postgres://corra:corra@localhost:5434/corra';

class FakeGateway implements StellarGateway {
  route: PathResult | null = { path: [USDC], source: fromDecimal(MXN, '329.3190139') };
  deposits: (Deposit & { memo: string })[] = [];
  landed = new Map<string, 'SUCCESS' | 'FAILED'>();
  submits = 0;
  async findStrictReceivePath() { return this.route; }
  async findDeposit({ memo }: { memo?: string }) { return this.deposits.find((d) => memo === undefined || d.memo === memo) ?? null; }
  async accountTrusts() { return true; }
  async accountSequence() { return null; }
  async getTransaction(h: string) {
    const s = this.landed.get(h);
    return s ? { status: s, ledger: 1 } : { status: 'NOT_FOUND' as const };
  }
  async submitPayment(xdr: string): Promise<SubmitOutcome> {
    this.submits++;
    await new Promise((r) => setTimeout(r, 20));
    const inner = S.TransactionBuilder.fromXDR(xdr, NP) as S.Transaction;
    const hash = Array.from(inner.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
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

beforeAll(async () => {
  const admin = new pg.Pool({ connectionString: BASE_URL });
  await admin.query('DROP DATABASE IF EXISTS corra_test WITH (FORCE)');
  await admin.query('CREATE DATABASE corra_test');
  await admin.end();
  pool = new pg.Pool({ connectionString: BASE_URL.replace(/\/[^/]+$/, '/corra_test') });
  await migrate(pool);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

beforeEach(async () => {
  await pool.query('TRUNCATE payment_events, legs, payments, quotes CASCADE');
  gw = new FakeGateway();
  store = new PostgresSagaStore(pool);
  const saga = createSaga({
    store, gateway: gw, networkPassphrase: NP, corridorIssuer: ISSUER,
    anchorDistribution: ANCHOR_DIST, anchorId: 'corra-anchor',
  });
  app = buildApp({
    saga, networkPassphrase: NP, corsOrigins: ['http://localhost:5180'],
    clientDomain: createClientDomainSigner(clientDomainKey.secret(), NP, 'corra.test'),
    anchorSigningKey: async () => anchorKey.publicKey(),
    prepareSetup: async () => 'unused',
  });
});

const quoteBody = { corridor: { from: 'MX/MXN', to: 'PH/PHP' }, destAmount: { amount: '1000', asset: 'TESTPHP', issuer: ISSUER } };

async function quoteAndSign() {
  const q = (await app.inject({ method: 'POST', url: '/quote', payload: quoteBody })).json();
  const tx = buildStrictReceive({
    networkPassphrase: NP, sender: sender.publicKey(), senderSequence: '100', recipient,
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
    // CREDITED includes the (mock) payout handler's acknowledgement, stored as the cash_out leg.
    expect(done.legs.find((l: any) => l.kind === 'cash_out')).toMatchObject({ status: 'CONFIRMED' });
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
    await admin.query('DROP DATABASE IF EXISTS corra_upgrade WITH (FORCE)');
    await admin.query('CREATE DATABASE corra_upgrade');
    const db = new pg.Pool({ connectionString: BASE_URL.replace(/\/[^/]+$/, '/corra_upgrade') });
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
      await db.end();
      await admin.query('DROP DATABASE IF EXISTS corra_upgrade WITH (FORCE)');
      await admin.end();
    }
  });

  it('002 also upgrades the other legacy shapes it would refuse, and a second boot changes nothing', async () => {
    const admin = new pg.Pool({ connectionString: BASE_URL });
    await admin.query('DROP DATABASE IF EXISTS corra_upgrade2 WITH (FORCE)');
    await admin.query('CREATE DATABASE corra_upgrade2');
    const db = new pg.Pool({ connectionString: BASE_URL.replace(/\/[^/]+$/, '/corra_upgrade2') });
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
      await db.end();
      await admin.query('DROP DATABASE IF EXISTS corra_upgrade2 WITH (FORCE)');
      await admin.end();
    }
  });
});

