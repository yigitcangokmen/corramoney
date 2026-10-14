import * as S from '@stellar/stellar-sdk';
import { parseUnits, sameAsset, type AssetId, type Money } from '@corra/shared';
import { MIN_PAYMENT_TTL_SEC, PAYMENT_TTL_SEC, SEQ_WINDOW } from './build';

export class UnboundTransactionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnboundTransactionError';
  }
}

export type ExpectedPayment = {
  sender: string;
  recipient: string;
  dest: Money;
  sendMax: Money;
  path: AssetId[];
};

export type BoundPayment = {
  hash: string;
  maxTime: number;
  sequence: string;
  minSequence: string;
};

const fromSdk = (a: S.Asset): AssetId => (a.isNative() ? { code: 'XLM' } : { code: a.getCode(), issuer: a.getIssuer() });

const amountEq = (sdkAmount: string, m: Money) => parseUnits(sdkAmount) === m.raw;

/**
 * Accepts a signed XDR only if it is exactly the payment the quote describes, signed by the
 * sender, with a live timebound and a minSeqNum. Anything the orchestrator cannot fully account
 * for is refused, which is what makes "it can only submit it or not" true.
 */
export function assertBoundPayment(
  xdr: string,
  expected: ExpectedPayment,
  networkPassphrase: string,
  nowSec: number,
): BoundPayment {
  let tx: S.Transaction | S.FeeBumpTransaction;
  try {
    tx = S.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new UnboundTransactionError('not a transaction envelope for this network');
  }
  if (tx instanceof S.FeeBumpTransaction) throw new UnboundTransactionError('fee-bump envelopes are not accepted');

  if (tx.source !== expected.sender) throw new UnboundTransactionError('source is not the sender');

  const hash = tx.hash();
  const sender = S.Keypair.fromPublicKey(expected.sender);
  const signedBySender = tx.signatures.some((s) => sender.verify(hash, s.signature));
  if (!signedBySender) throw new UnboundTransactionError('not signed by the sender');

  if (tx.operations.length !== 1) throw new UnboundTransactionError('expected exactly one operation');
  const op = tx.operations[0];
  if (op.type !== 'pathPaymentStrictReceive') throw new UnboundTransactionError('not a strict-receive path payment');
  if (op.source && op.source !== expected.sender) throw new UnboundTransactionError('operation source is not the sender');
  if (op.destination !== expected.recipient) throw new UnboundTransactionError('destination mismatch');
  if (!sameAsset(fromSdk(op.destAsset), expected.dest.asset)) throw new UnboundTransactionError('destination asset mismatch');
  if (!amountEq(op.destAmount, expected.dest)) throw new UnboundTransactionError('destination amount mismatch');
  if (!sameAsset(fromSdk(op.sendAsset), expected.sendMax.asset)) throw new UnboundTransactionError('send asset mismatch');
  if (!amountEq(op.sendMax, expected.sendMax)) throw new UnboundTransactionError('sendMax mismatch');
  const path = op.path.map(fromSdk);
  if (path.length !== expected.path.length || path.some((a, i) => !sameAsset(a, expected.path[i]))) {
    throw new UnboundTransactionError('path mismatch');
  }

  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) throw new UnboundTransactionError('no maxTime');
  if (maxTime <= nowSec) throw new UnboundTransactionError('already expired');
  if (maxTime > nowSec + PAYMENT_TTL_SEC + 60) throw new UnboundTransactionError('maxTime beyond the allowed window');
  if (maxTime < nowSec + MIN_PAYMENT_TTL_SEC) throw new UnboundTransactionError('maxTime too close to leave time for the cash-in');

  if (tx.minAccountSequence === undefined) throw new UnboundTransactionError('no minSeqNum');
  if (BigInt(tx.sequence) - BigInt(tx.minAccountSequence) !== SEQ_WINDOW) {
    throw new UnboundTransactionError('sequence window is not the one Corra builds');
  }
  // Nothing beyond what buildStrictReceive sets: no extra preconditions that could make the
  // payment unlandable or conditional on a third party, no memo, no fee of the sender's own.
  if (tx.extraSigners?.length || tx.ledgerBounds || BigInt(tx.minAccountSequenceAge ?? 0) !== 0n ||
      (tx.minAccountSequenceLedgerGap ?? 0) !== 0) {
    throw new UnboundTransactionError('unexpected preconditions');
  }
  if (tx.memo.type !== 'none') throw new UnboundTransactionError('memo not allowed');
  if (tx.fee !== '0') throw new UnboundTransactionError('inner fee must be 0; Corra pays through a fee-bump');
  if (tx.signatures.length !== 1) throw new UnboundTransactionError('expected exactly one signature, the sender\'s');

  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  return { hash: hex, maxTime, sequence: tx.sequence, minSequence: tx.minAccountSequence };
}

/** The sequence number a signed payment consumes when it lands. */
export function signedSequence(signedXdr: string, networkPassphrase: string): bigint {
  const tx = S.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  if (tx instanceof S.FeeBumpTransaction) return BigInt(tx.innerTransaction.sequence);
  return BigInt(tx.sequence);
}

