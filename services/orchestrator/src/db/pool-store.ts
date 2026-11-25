import pg from 'pg';
import type { AssetId, PoolOp } from '@corra/shared';

type Row = Record<string, any>;

/** Pool supply/withdraw transactions Corra fee-bumped. Status changes are conditional on SUBMITTED. */
export interface PoolOpStore {
  /** A duplicate key or inner hash raises Postgres 23505; the caller reads `e.constraint`. */
  create(o: PoolOp): Promise<void>;
  get(id: string): Promise<PoolOp | null>;
  findByIdemKey(key: string): Promise<PoolOp | null>;
  findByInnerHash(hash: string): Promise<PoolOp | null>;
  /** Newest first. */
  listByAccount(account: string, limit: number): Promise<PoolOp[]>;
  /** Conditional on status = 'SUBMITTED'; returns the row after. */
  finish(id: string, p: { status: 'SUCCESS' | 'FAILED'; resultCode: string | null; ledger: number | null }): Promise<PoolOp>;
  /** Bumps updated_at of a SUBMITTED row after an unproductive chain check. */
  touch(id: string): Promise<void>;
  /** SUBMITTED with updated_at <= before, oldest first, at most `limit`. */
  listOpen(before: number, limit: number): Promise<PoolOp[]>;
}

export class PostgresPoolOpStore implements PoolOpStore {
  /** `asset`: the pool reserve as a classic asset; pool_ops stores only its SAC. */
  constructor(private pool: pg.Pool, private asset: AssetId, private now: () => number = Date.now) {}

  private fromRow(r: Row): PoolOp {
    return {
      id: r.id,
      idemKey: r.idempotency_key,
      account: r.account,
      poolId: r.pool_id,
      assetSac: r.asset_sac,
      kind: r.kind,
      amount: { asset: this.asset, raw: BigInt(r.amount_raw) },
      innerHash: r.inner_hash,
      txHash: r.tx_hash,
      status: r.status,
      resultCode: r.result_code,
      resourceFee: r.resource_fee === null ? null : BigInt(r.resource_fee),
      ledger: r.ledger,
      createdAt: new Date(r.created_at).getTime(),
      updatedAt: new Date(r.updated_at).getTime(),
    };
  }

  private async one(sql: string, args: unknown[]) {
    const r = await this.pool.query(sql, args);
    return r.rows[0] ? this.fromRow(r.rows[0]) : null;
  }

  async create(o: PoolOp) {
    await this.pool.query(
      `INSERT INTO pool_ops (id, idempotency_key, account, pool_id, asset_sac, kind, amount_raw, inner_hash, tx_hash, status,
         result_code, resource_fee, ledger, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [o.id, o.idemKey, o.account, o.poolId, o.assetSac, o.kind, o.amount.raw.toString(), o.innerHash, o.txHash, o.status,
        o.resultCode, o.resourceFee?.toString() ?? null, o.ledger, new Date(o.createdAt), new Date(o.updatedAt)],
    );
  }

  get(id: string) {
    return this.one('SELECT * FROM pool_ops WHERE id = $1', [id]);
  }

  findByIdemKey(key: string) {
    return this.one('SELECT * FROM pool_ops WHERE idempotency_key = $1', [key]);
  }

  findByInnerHash(hash: string) {
    return this.one('SELECT * FROM pool_ops WHERE inner_hash = $1', [hash]);
  }

  async listByAccount(account: string, limit: number) {
    const r = await this.pool.query('SELECT * FROM pool_ops WHERE account = $1 ORDER BY created_at DESC LIMIT $2', [account, limit]);
    return r.rows.map((x) => this.fromRow(x));
  }

  async finish(id: string, p: { status: 'SUCCESS' | 'FAILED'; resultCode: string | null; ledger: number | null }) {
    await this.pool.query(
      "UPDATE pool_ops SET status = $2, result_code = $3, ledger = $4, updated_at = $5 WHERE id = $1 AND status = 'SUBMITTED'",
      [id, p.status, p.resultCode, p.ledger, new Date(this.now())],
    );
    const o = await this.get(id);
    if (!o) throw new Error(`unknown pool op ${id}`);
    return o;
  }

  async touch(id: string) {
    await this.pool.query("UPDATE pool_ops SET updated_at = $2 WHERE id = $1 AND status = 'SUBMITTED'", [id, new Date(this.now())]);
  }

  async listOpen(before: number, limit: number) {
    const r = await this.pool.query(
      "SELECT * FROM pool_ops WHERE status = 'SUBMITTED' AND updated_at <= $1 ORDER BY updated_at LIMIT $2",
      [new Date(before), limit],
    );
    return r.rows.map((x) => this.fromRow(x));
  }
}
