import * as S from '@stellar/stellar-sdk';
import { FEE_BUMP_BASE } from './build';
import { failureCode } from './gateway';
import type { Sponsor } from './sponsor';

export type PoolSendOutcome =
  | { status: 'SUCCESS'; ledger: number; feeCharged: bigint }
  | { status: 'FAILED'; ledger: number | null; code: string }
  | { status: 'PENDING' };

/** The node's ledger range on a NOT_FOUND answer (unix seconds): it can only vouch for transactions inside it. */
export type PoolNotFound = { status: 'NOT_FOUND'; latestLedgerCloseTime: number; oldestLedgerCloseTime: number };

/** What getTransaction can say about one hash: it landed (SUCCESS or FAILED) or the node does not know it. */
export type PoolLanded = Exclude<PoolSendOutcome, { status: 'PENDING' }>;

/** Pool transactions go through Stellar RPC, not Horizon. The saga never submits Soroban, so this stays outside StellarGateway. */
export interface PoolChain {
  /** Fee-bumps through the sponsor (which validates again); nothing is sent. Pool bumps always bid FEE_BUMP_BASE. */
  bump(signedInnerXdr: string, nowSec: number): { xdr: string; hash: string };
  /**
   * sendTransaction, then getTransaction every pollMs, all bounded by waitMs: PENDING when the
   * network has not answered by then (the reconciler settles it). Throws only when sendTransaction itself throws.
   */
  send(bumpedXdr: string): Promise<PoolSendOutcome>;
  /** One getTransaction by the envelope hash. NOT_FOUND carries the node's oldest and latest ledger close times (unix seconds). */
  status(hash: string): Promise<PoolLanded | PoolNotFound>;
}

const TRY_AGAIN_DELAYS_MS = [1000, 2000];
/** Per RPC request: stellar-sdk 17.4 sets no abort signal without it. */
const RPC_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a landed transaction's result says: SUCCESS with the fee charged, or FAILED with its first failing code. */
function landed(raw: { status: string; ledger?: number; resultXdr?: string }): PoolLanded | null {
  if (raw.status === 'SUCCESS') {
    let feeCharged = 0n;
    try {
      // stellar-sdk 17.4 XDR object model: struct fields are properties.
      feeCharged = BigInt((S.xdr.TransactionResult.fromXDR(raw.resultXdr!, 'base64') as any).feeCharged);
    } catch {
      // the fee is evidence only
    }
    return { status: 'SUCCESS', ledger: raw.ledger ?? 0, feeCharged };
  }
  if (raw.status === 'FAILED') return { status: 'FAILED', ledger: raw.ledger ?? null, code: raw.resultXdr ? failureCode(raw.resultXdr) : 'tx_failed' };
  return null;
}

export function createPoolChain(opts: {
  rpcUrl: string;
  networkPassphrase: string;
  sponsor: Sponsor;
  pollMs?: number;
  waitMs?: number;
  allowHttp?: boolean;
}): PoolChain {
  const rpc = new S.rpc.Server(opts.rpcUrl, { allowHttp: opts.allowHttp ?? opts.rpcUrl.startsWith('http://'), timeout: RPC_TIMEOUT_MS });
  const pollMs = opts.pollMs ?? 1000;
  const waitMs = opts.waitMs ?? 30_000;

  async function status(hash: string): Promise<PoolLanded | PoolNotFound> {
    const raw = await rpc._getTransaction(hash);
    return landed(raw) ?? {
      status: 'NOT_FOUND', latestLedgerCloseTime: Number(raw.latestLedgerCloseTime), oldestLedgerCloseTime: Number(raw.oldestLedgerCloseTime),
    };
  }

  return {
    status,

    bump(signedInnerXdr, nowSec) {
      const xdr = opts.sponsor.feeBump(signedInnerXdr, FEE_BUMP_BASE, nowSec);
      const tx = S.TransactionBuilder.fromXDR(xdr, opts.networkPassphrase);
      return { xdr, hash: Array.from(tx.hash(), (b) => b.toString(16).padStart(2, '0')).join('') };
    },

    async send(bumpedXdr) {
      // One stalled request must not hold the caller past waitMs.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<PoolSendOutcome>((r) => { timer = setTimeout(() => r({ status: 'PENDING' }), waitMs); });
      try {
        return await Promise.race([sendAndPoll(bumpedXdr, Date.now() + waitMs), late]);
      } finally {
        clearTimeout(timer);
      }
    },
  };

  async function sendAndPoll(bumpedXdr: string, until: number): Promise<PoolSendOutcome> {
    const tx = S.TransactionBuilder.fromXDR(bumpedXdr, opts.networkPassphrase);
    let sent = await rpc._sendTransaction(tx);
    for (const delay of TRY_AGAIN_DELAYS_MS) {
      if (sent.status !== 'TRY_AGAIN_LATER') break;
      await sleep(delay);
      sent = await rpc._sendTransaction(tx);
    }
    if (sent.status === 'TRY_AGAIN_LATER') return { status: 'FAILED', ledger: null, code: 'try_again_later' };
    if (sent.status === 'ERROR') return { status: 'FAILED', ledger: null, code: sent.errorResultXdr ? failureCode(sent.errorResultXdr) : 'error' };
    // PENDING or DUPLICATE: the network has it; poll until it lands or we stop waiting.
    while (Date.now() < until) {
      await sleep(pollMs);
      try {
        const out = await status(sent.hash);
        if (out.status !== 'NOT_FOUND') return out;
      } catch {
        // a polling error is not an outcome; the reconciler looks again
      }
    }
    return { status: 'PENDING' };
  }
}
