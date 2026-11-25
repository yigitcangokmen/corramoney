import pg from 'pg';
import { formatUnits, fromDecimal, type Deposit, type DepositMatchedBy, type Money } from '@corra/shared';
import { SagaError, type DepositStore, type OpenDepositsQuery } from '@corra/settlement-saga';

type Row = Record<string, any>;

const notFound = () => new SagaError('DEPOSIT_NOT_FOUND', 404, 'unknown deposit');
const alreadyLinked = (why = 'this deposit is already linked to another anchor reference') =>
  new SagaError('DEPOSIT_ALREADY_LINKED', 409, why);

function depositFromRow(r: Row): Deposit {
  const asset = { code: r.asset_code, issuer: r.asset_issuer };
  return {
    id: r.id,
    account: r.account,
    anchorId: r.anchor_id,
    anchorRef: r.external_ref,
    moreInfoUrl: r.more_info_url,
    memo: r.memo,
    requested: fromDecimal(asset, formatUnits(BigInt(r.amount_raw))),
    credited: r.amount_credited_raw === null ? null : fromDecimal(asset, formatUnits(BigInt(r.amount_credited_raw))),
    txHash: r.tx_hash,
    status: r.status,
    matchedBy: r.matched_by,
    reason: r.reason,
    createdAt: new Date(r.created_at).getTime(),
    updatedAt: new Date(r.updated_at).getTime(),
  };
}

/** Deposits on Postgres. Status changes are conditional updates; the deposits_confirmed_guard trigger backstops them. */
export class PostgresDepositStore implements DepositStore {
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

  private async one(sql: string, args: unknown[]) {
    const r = await this.pool.query(sql, args);
    return r.rows[0] ? depositFromRow(r.rows[0]) : null;
  }

  private async must(id: string) {
    const d = await this.getDeposit(id);
    if (!d) throw notFound();
    return d;
  }

  async createDeposit(d: Deposit) {
    await this.pool.query(
      `INSERT INTO deposits (id, account, anchor_id, external_ref, more_info_url, memo, asset_code, asset_issuer, amount_raw,
         amount_credited_raw, tx_hash, status, matched_by, reason, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
      [d.id, d.account, d.anchorId, d.anchorRef, d.moreInfoUrl, d.memo, d.requested.asset.code, d.requested.asset.issuer ?? null,
        d.requested.raw.toString(), d.credited?.raw.toString() ?? null, d.txHash, d.status, d.matchedBy, d.reason, new Date(d.createdAt)],
    );
  }

  getDeposit(id: string) {
    return this.one('SELECT * FROM deposits WHERE id = $1', [id]);
  }

  findDepositByRef(anchorId: string, ref: string) {
    return this.one('SELECT * FROM deposits WHERE anchor_id = $1 AND external_ref = $2', [anchorId, ref]);
  }

  findDepositByMemo(memo: string) {
    return this.one('SELECT * FROM deposits WHERE memo = $1', [memo]);
  }

  async listDepositsByAccount(account: string, limit: number) {
    const r = await this.pool.query('SELECT * FROM deposits WHERE account = $1 ORDER BY created_at DESC LIMIT $2', [account, limit]);
    return r.rows.map(depositFromRow);
  }

  async linkDepositRef(id: string, ref: string) {
    try {
      const d = await this.one(
        'UPDATE deposits SET external_ref = $2, updated_at = $3 WHERE id = $1 AND (external_ref IS NULL OR external_ref = $2) RETURNING *',
        [id, ref, this.ts()],
      );
      if (d) return d;
    } catch (e: any) {
      if (e?.code === '23505') throw alreadyLinked('this anchor reference belongs to another deposit');
      throw e;
    }
    if (!(await this.getDeposit(id))) throw notFound();
    throw alreadyLinked();
  }

  async bindDepositRef(id: string, ref: string) {
    return this.tx(async (c) => {
      await c.query(
        `UPDATE deposits SET external_ref = NULL, updated_at = $3
         WHERE anchor_id = (SELECT anchor_id FROM deposits WHERE id = $1) AND external_ref = $2 AND id <> $1`,
        [id, ref, this.ts()],
      );
      const r = await c.query('UPDATE deposits SET external_ref = $2, updated_at = $3 WHERE id = $1 RETURNING *', [id, ref, this.ts()]);
      if (!r.rows[0]) throw notFound();
      return depositFromRow(r.rows[0]);
    });
  }

  async confirmDeposit(id: string, p: { credited: Money; txHash: string; matchedBy: DepositMatchedBy; reason: string | null }) {
    // The row lock re-evaluates the WHERE: of two concurrent confirmations, one writes.
    await this.pool.query(
      `UPDATE deposits SET status = 'CONFIRMED', amount_credited_raw = $2, tx_hash = $3, matched_by = $4, reason = $5, updated_at = $6
       WHERE id = $1 AND status <> 'CONFIRMED'`,
      [id, p.credited.raw.toString(), p.txHash, p.matchedBy, p.reason, this.ts()],
    );
    return this.must(id);
  }

  async recordShortCredit(id: string, p: { credited: Money; txHash: string }) {
    await this.pool.query(
      "UPDATE deposits SET amount_credited_raw = $2, tx_hash = $3, updated_at = $4 WHERE id = $1 AND status = 'PENDING'",
      [id, p.credited.raw.toString(), p.txHash, this.ts()],
    );
    return this.must(id);
  }

  async expireDeposit(id: string, reason: string) {
    await this.pool.query(
      "UPDATE deposits SET status = 'EXPIRED', reason = $2, updated_at = $3 WHERE id = $1 AND status = 'PENDING'",
      [id, reason, this.ts()],
    );
    return this.must(id);
  }

  async setMoreInfoUrl(id: string, url: string) {
    await this.pool.query('UPDATE deposits SET more_info_url = $2, updated_at = $3 WHERE id = $1', [id, url, this.ts()]);
  }

  async touchDeposit(id: string) {
    await this.pool.query("UPDATE deposits SET updated_at = $2 WHERE id = $1 AND status <> 'CONFIRMED'", [id, this.ts()]);
  }

  async listOpenDeposits(now: number, p: OpenDepositsQuery) {
    // Thresholds computed here, in milliseconds like the in-memory store; ordered by due time
    // (updated_at + its idle), so no class of deposit can starve another.
    const at = (ms: number) => new Date(now - ms);
    const r = await this.pool.query(
      `SELECT * FROM deposits
       WHERE (status = 'PENDING' AND (
                (created_at > $1 AND updated_at <= $2)
             OR (created_at <= $1 AND created_at > $3 AND updated_at <= $4)
             OR (created_at <= $3 AND updated_at <= $5)))
          OR (status = 'EXPIRED' AND updated_at <= $6 AND created_at >= $7)
       ORDER BY updated_at + (CASE WHEN status = 'EXPIRED' THEN $9::float8 WHEN created_at > $1 THEN $10::float8 WHEN created_at > $3 THEN $11::float8 ELSE $12::float8 END)
                  * interval '1 millisecond', id
       LIMIT $8`,
      [at(p.youngMs), at(p.youngIdleMs), at(p.midMs), at(p.midIdleMs), at(p.oldIdleMs), at(p.expiredIdleMs), at(p.expiredMaxAgeMs), p.limit,
        p.expiredIdleMs, p.youngIdleMs, p.midIdleMs, p.oldIdleMs],
    );
    return r.rows.map(depositFromRow);
  }
}
