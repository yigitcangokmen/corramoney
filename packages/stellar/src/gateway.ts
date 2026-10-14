import * as S from '@stellar/stellar-sdk';
import { add, fromDecimal, sameAsset, toDecimal, type AssetId, type Money } from '@corra/shared';
import { classifySubmitError, type SubmitOutcome } from './submit';
import type { Sponsor } from './sponsor';
import { FEE_BUMP_BASE, MAX_FEE_BUMP_BASE, toSdkAsset } from './build';

export type PathResult = { path: AssetId[]; source: Money };

export type Deposit = { hash: string; amount: Money; at: number };

/** Everything the saga needs from the chain. A fake implements this in tests. */
export interface StellarGateway {
  findStrictReceivePath(p: { sourceAsset: AssetId; dest: Money }): Promise<PathResult | null>;
  /** Fee-bumps a sender-signed payment and submits it. */
  submitPayment(signedInnerXdr: string): Promise<SubmitOutcome>;
  /** `codes` names the first failing result for a FAILED transaction, e.g. `op_over_source_max`. */
  /** Looks up a transaction by its inner hash. `hash` is the fee-bump envelope's hash when there is one. */
  getTransaction(hash: string): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; codes?: string; hash?: string }>;
  /** Credit of `asset` from `from` to `account` at or after `since` (ms). With `memo` (base64 hash), the sum of every credit carrying it, stamped with the latest one's hash. */
  findDeposit(p: { account: string; from: string; asset: AssetId; since: number; memo?: string }): Promise<Deposit | null>;
  /** False when the account does not exist or holds no trustline for the asset. */
  accountTrusts(account: string, asset: AssetId): Promise<boolean>;
  /** The account's current sequence number, or null when the account does not exist. */
  accountSequence(account: string): Promise<bigint | null>;
}

const MAX_DEPOSIT_PAGES = 20;

const assetOf = (code?: string, issuer?: string): AssetId => (code && issuer ? { code, issuer } : { code: 'XLM' });

/**
 * Names the first failing result of a landed, failed transaction in Horizon's vocabulary
 * (`op_over_source_max`, `op_underfunded`, ...), unwrapping a fee-bump's inner result.
 */
export function failureCode(resultXdr: string): string {
  try {
    // The SDK's JSON form is the stable, documented shape (snake_case arms, enum strings).
    const decoded = S.xdr.TransactionResult.fromXDR(resultXdr, 'base64');
    let r: any = JSON.parse(JSON.stringify(decoded, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).result;
    const bump = r.tx_fee_bump_inner_failed ?? r.tx_fee_bump_inner_success;
    if (bump) r = bump.result.result;
    if (typeof r === 'string') return r;
    if (!r.tx_failed) return Object.keys(r)[0] ?? 'tx_failed';
    for (const op of r.tx_failed) {
      if (!op.op_inner) return typeof op === 'string' ? op : (Object.keys(op)[0] ?? 'op_failed');
      const code = Object.values(op.op_inner)[0];
      if (typeof code !== 'string' || code === 'success') continue;
      // Horizon reports the protocol's OVER_SENDMAX as op_over_source_max.
      return code === 'over_sendmax' ? 'op_over_source_max' : 'op_' + code;
    }
    return 'tx_failed';
  } catch {
    return 'unknown';
  }
}

export function createHorizonGateway(opts: {
  horizonUrl: string;
  networkPassphrase: string;
  sponsor: Sponsor;
}): StellarGateway {
  const horizon = new S.Horizon.Server(opts.horizonUrl, { allowHttp: opts.horizonUrl.startsWith('http://') });

  /**
   * Follows the network's inclusion fee, so a surge does not leave every retry underbidding until
   * the payment expires. Reads `last_ledger_base_fee`, not `fee_charged` (Soroban resource fees
   * inflate that), and doubles it when ledgers are nearly full. Never below the default, never
   * above the sponsor's cap; on any error, the default.
   */
  async function feeBid(): Promise<number> {
    try {
      const s: any = await horizon.feeStats();
      const base = Number(s.last_ledger_base_fee) * (Number(s.ledger_capacity_usage) > 0.9 ? 2 : 1);
      return Number.isFinite(base) ? Math.min(MAX_FEE_BUMP_BASE, Math.max(FEE_BUMP_BASE, Math.ceil(base))) : FEE_BUMP_BASE;
    } catch {
      return FEE_BUMP_BASE;
    }
  }

  async function getTransaction(hash: string): Promise<Awaited<ReturnType<StellarGateway['getTransaction']>>> {
    try {
      const t = await horizon.transactions().transaction(hash).call();
      // Queried by the inner hash, Horizon echoes it in `hash`; the envelope that landed is the fee-bump.
      const landed = (t as any).fee_bump_transaction?.hash ?? t.hash;
      if (t.successful) return { status: 'SUCCESS', ledger: t.ledger_attr, hash: landed };
      return { status: 'FAILED', ledger: t.ledger_attr, codes: failureCode(t.result_xdr), hash: landed };
    } catch (e: any) {
      if (e?.response?.status === 404) return { status: 'NOT_FOUND' };
      throw e;
    }
  }

  return {
    getTransaction,

    async findStrictReceivePath({ sourceAsset, dest }) {
      const res = await horizon
        .strictReceivePaths([toSdkAsset(sourceAsset)], toSdkAsset(dest.asset), toDecimal(dest))
        .call();
      const candidates = res.records.filter((r) =>
        sameAsset(assetOf(r.source_asset_code, r.source_asset_issuer), sourceAsset),
      );
      if (!candidates.length) return null;
      const best = candidates.reduce((a, b) => (Number(a.source_amount) <= Number(b.source_amount) ? a : b));
      return {
        path: best.path.map((p) => assetOf(p.asset_code, p.asset_issuer)),
        source: fromDecimal(sourceAsset, best.source_amount),
      };
    },

    async submitPayment(signedInnerXdr) {
      const bumped = opts.sponsor.feeBump(signedInnerXdr, await feeBid());
      const tx = S.TransactionBuilder.fromXDR(bumped, opts.networkPassphrase);
      const hash = Array.from(tx.hash(), (b) => b.toString(16).padStart(2, '0')).join('');
      try {
        const r = await horizon.submitTransaction(tx);
        return { kind: 'success', hash: r.hash, ledger: r.ledger };
      } catch (e: any) {
        if (!e?.response?.data) throw e;
        const out = classifySubmitError(e.response.data);
        // A failed-in-ledger tx is on chain, but Horizon's error body does not always carry its hash.
        if ((out.kind === 'cap_exceeded' || out.kind === 'failed') && !out.hash) {
          const landed = await getTransaction(hash);
          if (landed.status !== 'NOT_FOUND') return { ...out, hash };
        }
        return out;
      }
    },

    async findDeposit({ account, from, asset, since, memo }) {
      const credits: Deposit[] = [];
      // Walk back page by page until we pass `since`, so unrelated payments (or deliberate dust
      // spam) after the deposit cannot push it out of view. Bounded so a flooded account cannot
      // make one reconcile pass unbounded.
      let page = await horizon.payments().forAccount(account).join('transactions').order('desc').limit(200).call();
      for (let pages = 0; pages < MAX_DEPOSIT_PAGES && page.records.length; pages++) {
        let reachedSince = false;
        for (const r of page.records as any[]) {
          const at = Date.parse(r.created_at);
          if (at < since) { reachedSince = true; break; }
          if (!r.transaction_successful) continue;
          if (memo !== undefined) {
            const t = r.transaction_attr;
            if (!t || t.memo_type !== 'hash' || t.memo !== memo) continue;
          }
          if (r.type === 'payment' && r.from === from && r.to === account &&
              sameAsset(assetOf(r.asset_code, r.asset_issuer), asset)) {
            credits.push({ hash: r.transaction_hash, amount: fromDecimal(asset, r.amount), at });
          }
          // Anchor Platform can pay through the asset's SAC, which Horizon reports as balance changes.
          if (r.type === 'invoke_host_function') {
            for (const c of r.asset_balance_changes ?? []) {
              if (c.type === 'transfer' && c.from === from && c.to === account &&
                  sameAsset(assetOf(c.asset_code, c.asset_issuer), asset)) {
                credits.push({ hash: r.transaction_hash, amount: fromDecimal(asset, c.amount), at });
              }
            }
          }
        }
        if (reachedSince || page.records.length < 200) break;
        page = await page.next();
      }
      credits.sort((a, b) => a.at - b.at);
      if (!credits.length) return null;
      // A memo pins every credit to one payment, so a short deposit plus a top-up add up.
      if (memo === undefined) return credits[0];
      const last = credits[credits.length - 1];
      return { ...last, amount: credits.slice(0, -1).reduce((sum, c) => add(sum, c.amount), last.amount) };
    },

    async accountSequence(account) {
      try {
        return BigInt((await horizon.loadAccount(account)).sequence);
      } catch (e: any) {
        if (e?.response?.status === 404) return null;
        throw e;
      }
    },

    async accountTrusts(account, asset) {
      try {
        const a = await horizon.loadAccount(account);
        return a.balances.some(
          (b: any) => b.asset_type !== 'native' && sameAsset(assetOf(b.asset_code, b.asset_issuer), asset),
        );
      } catch (e: any) {
        if (e?.response?.status === 404) return false;
        throw e;
      }
    },
  };
}
