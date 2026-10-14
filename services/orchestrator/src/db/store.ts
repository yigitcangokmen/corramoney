import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  corridorFromWire,
  corridorToWire,
  fromDecimal,
  formatUnits,
  quoteFromWire,
  quoteToWire,
  type Leg,
  type Payment,
  type PaymentEvent,
  type PaymentState,
  type Quote,
} from '@corra/shared';
import { SagaError, type LegUpdate, type NewEvent, type SagaStore } from '@corra/settlement-saga';

const conflict = (code: string, message: string) => new SagaError(code, 409, message);

const MIGRATIONS = fileURLToPath(new URL('./migrations', import.meta.url));

/** Runs every migration in order. Each file is idempotent, so this is safe on every start. */
/** Any fixed number: the advisory lock that serialises migrations across instances. */
const MIGRATION_LOCK = 81_726_001;

export async function migrate(pool: pg.Pool) {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
      await c.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    c.release();
  }
}

const PENDING: PaymentState[] = ['SIGNED', 'CASH_IN', 'ONCHAIN'];

type Row = Record<string, any>;

function legFromRow(r: Row): Leg {
  return {
    kind: r.kind,
    status: r.status,
    amount: fromDecimal({ code: r.asset_code, ...(r.asset_issuer ? { issuer: r.asset_issuer } : {}) }, formatUnits(BigInt(r.amount_raw))),
    ...(r.anchor_id ? { anchorId: r.anchor_id } : {}),
    ...(r.external_ref ? { externalRef: r.external_ref } : {}),
    ...(r.tx_hash ? { txHash: r.tx_hash } : {}),
  };
}

function paymentFromRow(r: Row, legs: Leg[]): Payment {
  return {
    id: r.id,
    publicId: r.public_id,
    senderAccount: r.sender_account,
    recipientAccount: r.recipient_account,
    corridor: corridorFromWire({ from: r.corridor_from, to: r.corridor_to }),
    quote: quoteFromWire(r.quote),
    state: r.state,
    legs,
    idemKey: r.idempotency_key,
    signedXdr: r.signed_xdr,
    innerTxHash: r.inner_tx_hash,
    maxTime: Math.floor(new Date(r.max_time).getTime() / 1000),
    supersedesId: r.supersedes_id,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

export class PostgresSagaStore implements SagaStore {
  constructor(private pool: pg.Pool, private now: () => number = Date.now) {}

  private ts() {
    return new Date(this.now());
  }

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  private async load(c: pg.Pool | pg.PoolClient, where: string, arg: string, lock = false): Promise<Payment | null> {
    const r = await c.query(`SELECT * FROM payments WHERE ${where} = $1${lock ? ' FOR UPDATE' : ''}`, [arg]);
    if (!r.rows[0]) return null;
    const legs = await c.query('SELECT * FROM legs WHERE payment_id = $1 ORDER BY created_at, kind', [r.rows[0].id]);
    return paymentFromRow(r.rows[0], legs.rows.map(legFromRow));
  }

  private async upsertLegs(c: pg.PoolClient, paymentId: string, updates: LegUpdate[] = []) {
    for (const u of updates) {
      const existing = await c.query('SELECT id FROM legs WHERE payment_id = $1 AND kind = $2', [paymentId, u.kind]);
      if (existing.rows[0]) {
        await c.query(
          `UPDATE legs SET
             status = COALESCE($3, status), tx_hash = COALESCE($4, tx_hash),
             anchor_id = COALESCE($5, anchor_id), external_ref = COALESCE($6, external_ref), updated_at = $7
           WHERE payment_id = $1 AND kind = $2`,
          [paymentId, u.kind, u.status ?? null, u.txHash ?? null, u.anchorId ?? null, u.externalRef ?? null, this.ts()],
        );
      } else {
        if (!u.amount || !u.status) throw new Error(`new ${u.kind} leg needs amount and status`);
        await c.query(
          `INSERT INTO legs (id, payment_id, kind, anchor_id, external_ref, tx_hash, amount_raw, asset_code, asset_issuer, status, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
          [`leg_${crypto.randomUUID().replace(/-/g, '')}`, paymentId, u.kind, u.anchorId ?? null, u.externalRef ?? null,
            u.txHash ?? null, u.amount.raw.toString(), u.amount.asset.code, u.amount.asset.issuer ?? null, u.status, this.ts()],
        );
      }
    }
  }

  private async appendEvent(c: pg.PoolClient, paymentId: string, e: NewEvent) {
    const next = await c.query('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM payment_events WHERE payment_id = $1', [paymentId]);
    await c.query(
      'INSERT INTO payment_events (payment_id, seq, type, from_state, to_state, data, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [paymentId, next.rows[0].seq, e.type, e.from, e.to, e.data ?? null, this.ts()],
    );
  }

  async saveQuote(q: Quote) {
    await this.pool.query('INSERT INTO quotes (id, data, expires_at, created_at) VALUES ($1,$2,$3,$4)', [
      q.id, quoteToWire(q), new Date(q.expiresAt), this.ts(),
    ]);
  }

  async getQuote(id: string) {
    const r = await this.pool.query('SELECT data FROM quotes WHERE id = $1', [id]);
    return r.rows[0] ? quoteFromWire(r.rows[0].data) : null;
  }

  async createPayment(p: Payment, events: NewEvent[]) {
    const existing = await this.getPaymentByIdemKey(p.idemKey);
    if (existing) return { payment: existing, created: false };
    try {
      return await this.tx(async (c) => {
        const claimed = await c.query('UPDATE quotes SET payment_id = $2 WHERE id = $1 AND payment_id IS NULL', [p.quote.id, p.id]);
        if (claimed.rowCount !== 1) throw new SagaError('QUOTE_USED', 409, 'quote already confirmed by another payment');
        const corridor = corridorToWire(p.corridor);
        await c.query(
          `INSERT INTO payments (id, public_id, idempotency_key, sender_account, recipient_account, corridor_from, corridor_to,
             quote, source_raw, dest_raw, send_max_raw, signed_xdr, inner_tx_hash, max_time, supersedes_id, state, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)`,
          [p.id, p.publicId, p.idemKey, p.senderAccount, p.recipientAccount, corridor.from, corridor.to,
            quoteToWire(p.quote), p.quote.source.raw.toString(), p.quote.dest.raw.toString(), p.quote.maxSend.raw.toString(),
            p.signedXdr, p.innerTxHash, new Date(p.maxTime * 1000), p.supersedesId, p.state, new Date(p.createdAt)],
        );
        await this.upsertLegs(c, p.id, p.legs);
        for (const e of events) await this.appendEvent(c, p.id, e);
        return { payment: (await this.load(c, 'id', p.id))!, created: true };
      });
    } catch (e: any) {
      // A concurrent request with the same idempotency key won the race. It may surface as the
      // quote already being claimed (we waited on its row lock), or as the key's unique index.
      const raced = (e instanceof SagaError && e.code === 'QUOTE_USED') ||
        (e?.code === '23505' && String(e?.constraint).includes('idempotency_key'));
      if (raced) {
        const winner = await this.getPaymentByIdemKey(p.idemKey);
        if (winner) return { payment: winner, created: false };
      }
      if (e?.code === '23505' && String(e?.constraint).includes('inner_tx_hash')) {
        throw conflict('DUPLICATE_TRANSACTION', 'this signed transaction already backs another payment');
      }
      if (e?.code === '23505' && String(e?.constraint).includes('public_id')) {
        throw new SagaError('PUBLIC_ID_TAKEN', 409, 'public id collision', true);
      }
      if (e?.code === '23505' && String(e?.constraint).includes('supersedes_id')) {
        throw conflict('ALREADY_SUPERSEDED', 'this payment was already re-signed');
      }
      throw e;
    }
  }

  /** By internal id, or by the public id people see (CORRA-XXXXXX). */
  getPayment(id: string) {
    return this.load(this.pool, id.startsWith('CORRA-') ? 'public_id' : 'id', id);
  }

  getPaymentByIdemKey(idemKey: string) {
    return this.load(this.pool, 'idempotency_key', idemKey);
  }

  async findPaymentByCashInRef(anchorId: string, ref: string) {
    const r = await this.pool.query("SELECT payment_id FROM legs WHERE kind = 'cash_in' AND anchor_id = $1 AND external_ref = $2", [anchorId, ref]);
    return r.rows[0] ? this.getPayment(r.rows[0].payment_id) : null;
  }

  async linkCashIn(paymentId: string, anchorId: string, ref: string) {
    try {
      await this.tx(async (c) => {
        await c.query('SELECT id FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
        const cur = await c.query("SELECT external_ref FROM legs WHERE payment_id = $1 AND kind = 'cash_in'", [paymentId]);
        const existing = cur.rows[0]?.external_ref;
        if (existing === ref) return;
        if (existing) throw conflict('CASH_IN_ALREADY_LINKED', 'this payment is already linked to another cash-in reference');
        await this.upsertLegs(c, paymentId, [{ kind: 'cash_in', anchorId, externalRef: ref }]);
        await c.query('UPDATE payments SET updated_at = $2 WHERE id = $1', [paymentId, this.ts()]);
      });
    } catch (e: any) {
      if (e?.code === '23505') throw conflict('CASH_IN_ALREADY_LINKED', 'this cash-in reference already belongs to another payment');
      throw e;
    }
  }

  async listBySender(sender: string, states: PaymentState[]) {
    const r = await this.pool.query(
      'SELECT id FROM payments WHERE sender_account = $1 AND state = ANY($2) ORDER BY created_at',
      [sender, states],
    );
    const out: Payment[] = [];
    for (const row of r.rows) {
      const p = await this.getPayment(row.id);
      if (p) out.push(p);
    }
    return out;
  }

  async transition(id: string, from: PaymentState, to: PaymentState, patch: { signedXdr?: string | null; legs?: LegUpdate[] }, event: NewEvent) {
    return this.tx(async (c) => {
      const cur = await this.load(c, 'id', id, true);
      if (!cur || cur.state !== from) return null;
      await c.query(
        `UPDATE payments SET state = $2, updated_at = $3${patch.signedXdr !== undefined ? ', signed_xdr = $4' : ''} WHERE id = $1`,
        patch.signedXdr !== undefined ? [id, to, this.ts(), patch.signedXdr] : [id, to, this.ts()],
      );
      await this.upsertLegs(c, id, patch.legs);
      await this.appendEvent(c, id, event);
      return this.load(c, 'id', id);
    });
  }

  async listPending(idleMs: number, now: number) {
    const r = await this.pool.query('SELECT id FROM payments WHERE state = ANY($1) AND updated_at <= $2', [
      PENDING, new Date(now - idleMs),
    ]);
    const out: Payment[] = [];
    for (const row of r.rows) {
      const p = await this.getPayment(row.id);
      if (p) out.push(p);
    }
    return out;
  }

  async events(id: string): Promise<PaymentEvent[]> {
    const r = await this.pool.query('SELECT * FROM payment_events WHERE payment_id = $1 ORDER BY seq', [id]);
    return r.rows.map((e) => ({
      seq: e.seq, type: e.type, from: e.from_state, to: e.to_state,
      ...(e.data ? { data: e.data } : {}), at: new Date(e.created_at).getTime(),
    }));
  }
}
