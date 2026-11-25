import * as S from '@stellar/stellar-sdk';
import { toDecimal, type AssetId, type PoolOp } from '@corra/shared';
import { SagaError, sendFailed as sendFailedError, withTimeout } from '@corra/settlement-saga';
import { assertPoolSubmit, POOL_MAX_TTL_SEC, PoolRefusal, type PoolChain, type PoolScope } from '@corra/stellar';
import type { PoolOpStore } from './db/pool-store';

export type PoolOpsDeps = {
  store: PoolOpStore;
  chain: PoolChain;
  scope: PoolScope;
  /** The pool reserve as a classic asset, for the amount on the wire. */
  asset: AssetId;
  sponsorPublicKey: string;
  /** gateway.isPaymentAccountOf: only a payment account of the signer is a transaction source Corra fee-bumps for it. */
  isPaymentAccountOf(account: string, sender: string): Promise<boolean>;
  networkPassphrase: string;
  now?: () => number;
  /** How long a replay waits before it reads the envelope hash again after a resend the node refused. Default 2 s. */
  recheckMs?: number;
  /** Structured events (pool.submitted, pool.landed, ...). Default: none. */
  log?: (l: { evt: string } & Record<string, unknown>) => void;
};

/** A SUBMITTED op the chain still does not know after this long never landed: its signed window is 6 minutes. */
export const POOL_OP_LOST_MS = 10 * 60_000;
const RECONCILE_IDLE_MS = 10_000;
/** Bounds the RPC calls one reconcile pass makes. */
const MAX_CHECKS_PER_PASS = 25;

const idempotencyReused = () =>
  new SagaError('IDEMPOTENCY_KEY_REUSED', 409, 'this Idempotency-Key was already used for a different request');
const duplicateTransaction = () => new SagaError('DUPLICATE_TRANSACTION', 409, 'this signed transaction was already submitted');
const rateLimited = () => new SagaError('RATE_LIMITED', 429, 'too many requests, try again later', true);
/** Retriable, and not 503 (the web reads that as no pool): the client keeps the blob and replays it under the same key. */
const sendFailed = () => sendFailedError('the transaction could not be sent to the network; retry with the same Idempotency-Key');

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** The inner hash of a blob, or null when it does not parse as a plain transaction. */
function innerHashOf(xdr: string, networkPassphrase: string): string | null {
  try {
    const tx = S.TransactionBuilder.fromXDR(xdr, networkPassphrase);
    return tx instanceof S.FeeBumpTransaction ? null : hex(tx.hash());
  } catch {
    return null;
  }
}

/**
 * User-signed Blend `submit`s Corra validates, fee-bumps and sends. The row is history and
 * evidence only: the position itself lives in the pool contract.
 */
export function createPoolOps(deps: PoolOpsDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});
  const recheckMs = deps.recheckMs ?? 2000;
  const { store, chain } = deps;

  /** Ops whose send is in flight in this process: a parallel replay returns the row instead of sending again. */
  const sending = new Set<string>();

  /**
   * A retry with the same key must carry the same blob. A SUBMITTED op the network does not know
   * (an earlier send threw before the node took it) is sent again while its signed window lasts;
   * the fee bump is deterministic, so the envelope hash is the same and a DUPLICATE is harmless.
   */
  async function replay(prior: PoolOp, signedXdr: string): Promise<{ op: PoolOp; replay: boolean }> {
    if (innerHashOf(signedXdr, deps.networkPassphrase) !== prior.innerHash) throw idempotencyReused();
    if (prior.status !== 'SUBMITTED' || sending.has(prior.id)) return { op: prior, replay: true };
    const nowSec = Math.floor(now() / 1000);
    try {
      assertPoolSubmit(signedXdr, deps.scope, deps.networkPassphrase, nowSec, deps.sponsorPublicKey);
    } catch {
      // Past its window: the chain would refuse it too; the reconciler settles the row.
      return { op: prior, replay: true };
    }
    sending.add(prior.id);
    try {
      let s;
      try {
        s = await withTimeout(chain.status(prior.txHash!), 10_000);
      } catch (e) {
        log({ evt: 'pool.check_failed', id: prior.id, error: String(e) });
        throw sendFailed();
      }
      if (s.status === 'SUCCESS' || s.status === 'FAILED') await finish(prior, s);
      else {
        const bumped = chain.bump(signedXdr, nowSec);
        // Same inner hash, other signature bytes (a mutated hint): not the blob this key was used for.
        if (bumped.hash !== prior.txHash) throw idempotencyReused();
        log({ evt: 'pool.resend', id: prior.id, txHash: prior.txHash });
        await resend(prior, bumped.xdr);
      }
    } finally {
      sending.delete(prior.id);
    }
    return { op: (await store.get(prior.id))!, replay: true };
  }

  /**
   * A resend of an op whose first send may have landed: a refusal without a ledger (tx_bad_seq,
   * try_again_later) can be the node answering for the original. Only the envelope hash settles it;
   * still NOT_FOUND leaves the row SUBMITTED for the reconciler.
   */
  async function resend(o: PoolOp, bumpedXdr: string) {
    let out;
    try {
      out = await chain.send(bumpedXdr);
    } catch (e) {
      log({ evt: 'pool.send_error', id: o.id, error: String(e) });
      throw sendFailed();
    }
    if (out.status === 'PENDING') return;
    if (out.status === 'SUCCESS' || out.ledger !== null) return finish(o, out);
    log({ evt: 'pool.resend_refused', id: o.id, code: out.code });
    await new Promise((r) => setTimeout(r, recheckMs));
    try {
      const s = await withTimeout(chain.status(o.txHash!), 10_000);
      if (s.status === 'SUCCESS' || (s.status === 'FAILED' && s.ledger !== null)) return finish(o, s);
    } catch (e) {
      log({ evt: 'pool.check_failed', id: o.id, error: String(e) });
    }
    await store.touch(o.id);
  }

  /** Sends and records a landed answer; a throw before the node took it is a retriable 502 and leaves the row SUBMITTED. */
  async function sendAndFinish(o: PoolOp, bumpedXdr: string) {
    let out;
    try {
      out = await chain.send(bumpedXdr);
    } catch (e) {
      log({ evt: 'pool.send_error', id: o.id, error: String(e) });
      throw sendFailed();
    }
    if (out.status !== 'PENDING') await finish(o, out);
  }

  async function finish(o: PoolOp, out: { status: 'SUCCESS'; ledger: number; feeCharged?: bigint } | { status: 'FAILED'; ledger: number | null; code: string }) {
    if (out.status === 'SUCCESS') {
      await store.finish(o.id, { status: 'SUCCESS', resultCode: null, ledger: out.ledger });
      log({ evt: 'pool.landed', id: o.id, ledger: out.ledger, ...(out.feeCharged !== undefined ? { feeCharged: out.feeCharged.toString() } : {}) });
    } else {
      // An RPC ERROR (tx_bad_seq, ...) never reached a ledger: FAILED with ledger null.
      await store.finish(o.id, { status: 'FAILED', resultCode: out.code, ledger: out.ledger });
      log({ evt: 'pool.failed', id: o.id, code: out.code, ledger: out.ledger });
    }
  }

  async function submit(i: { signedXdr: string; idemKey: string; admit: (account: string) => boolean }): Promise<{ op: PoolOp; replay: boolean }> {
    // The key first: a retry after the signed window still gets its row instead of a refusal.
    const prior = await store.findByIdemKey(i.idemKey);
    if (prior) return replay(prior, i.signedXdr);
    const nowSec = Math.floor(now() / 1000);
    const facts = assertPoolSubmit(i.signedXdr, deps.scope, deps.networkPassphrase, nowSec, deps.sponsorPublicKey);
    // Before the token (spec 5.3 steps 3 and 4 swapped): a blob Corra already has takes none, so
    // re-posting someone's blob from the chain cannot spend their budget.
    // A parallel retry with this key may have recorded it a moment ago: that is a replay, not a duplicate.
    const same = await store.findByInnerHash(facts.hash);
    if (same) {
      if (same.idemKey === i.idemKey) return { op: same, replay: true };
      throw duplicateTransaction();
    }
    if (!(await deps.isPaymentAccountOf(facts.paymentAccount, facts.account))) {
      throw new PoolRefusal('transaction source is not the signer\'s payment account');
    }
    // Only a blob proven to be the account's own takes its token.
    if (!i.admit(facts.account)) throw rateLimited();
    const bumped = chain.bump(i.signedXdr, nowSec);
    const t = now();
    const op: PoolOp = {
      id: `pop_${crypto.randomUUID().replace(/-/g, '')}`, idemKey: i.idemKey, account: facts.account, poolId: deps.scope.poolId,
      assetSac: deps.scope.asset, kind: facts.kind, amount: { asset: deps.asset, raw: facts.amountRaw }, innerHash: facts.hash,
      txHash: bumped.hash, status: 'SUBMITTED', resultCode: null, resourceFee: facts.resourceFee, ledger: null, createdAt: t, updatedAt: t,
    };
    sending.add(op.id);
    try {
      await store.create(op);
    } catch (e: any) {
      sending.delete(op.id);
      if (e?.code === '23505') {
        // Lost a race: under this key it is a replay; the blob under another key is a duplicate.
        const raced = await store.findByIdemKey(i.idemKey);
        if (raced) return replay(raced, i.signedXdr);
        if (e.constraint === 'pool_ops_inner_hash_key') throw duplicateTransaction();
      }
      throw e;
    }
    log({ evt: 'pool.submitted', id: op.id, account: op.account, kind: op.kind, amount: toDecimal(op.amount), txHash: op.txHash });

    try {
      await sendAndFinish(op, bumped.xdr);
    } finally {
      sending.delete(op.id);
    }
    return { op: (await store.get(op.id))!, replay: false };
  }

  let reconciling = false;

  /**
   * Settles SUBMITTED ops whose answer was lost: by the envelope hash, FAILED not_found after 10 minutes,
   * and only once the node has closed a ledger past the signed window (a lagging node may not know it yet).
   * A node that no longer holds the ledger of the submit cannot tell: FAILED unknown (the position card reads the chain).
   */
  async function reconcile(): Promise<void> {
    if (reconciling) return;
    reconciling = true;
    try {
      const t = now();
      for (const o of await store.listOpen(t - RECONCILE_IDLE_MS, MAX_CHECKS_PER_PASS)) {
        try {
          const s = await withTimeout(chain.status(o.txHash!), 10_000);
          if (s.status === 'SUCCESS' || s.status === 'FAILED') await finish(o, s);
          else if (o.createdAt > t - POOL_OP_LOST_MS) await store.touch(o.id);
          else if (s.latestLedgerCloseTime > o.createdAt / 1000 + POOL_MAX_TTL_SEC) {
            // Only a node that still holds every ledger since the submit can say it never landed.
            if (o.createdAt / 1000 >= s.oldestLedgerCloseTime) await finish(o, { status: 'FAILED', ledger: null, code: 'not_found' });
            else {
              log({ evt: 'pool.unknowable', id: o.id, oldestLedgerCloseTime: s.oldestLedgerCloseTime });
              await finish(o, { status: 'FAILED', ledger: null, code: 'unknown' });
            }
          } else {
            log({ evt: 'pool.rpc_behind', id: o.id, latestLedgerCloseTime: s.latestLedgerCloseTime });
            await store.touch(o.id);
          }
        } catch (e) {
          log({ evt: 'pool.check_failed', id: o.id, error: String(e) });
          await store.touch(o.id).catch(() => {});
        }
      }
    } finally {
      reconciling = false;
    }
  }

  return {
    findByIdemKey: (key: string) => store.findByIdemKey(key),
    submit,
    list: (account: string, limit: number) => store.listByAccount(account, limit),
    reconcile,
  };
}

export type PoolOps = ReturnType<typeof createPoolOps>;
