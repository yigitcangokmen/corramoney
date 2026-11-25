import * as S from '@stellar/stellar-sdk';
import { parseUnits, sameAsset, toDecimal, type AssetId, type Money } from '@corra/shared';
import {
  BALANCE_TTL_SEC, CASH_OUT_TTL_SEC, hashMemoBytes, MIN_PAYMENT_TTL_SEC, PAYMENT_TTL_SEC, SEQ_WINDOW, type CashOutMemo, type PaymentMode,
} from './build';

export class UnboundTransactionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnboundTransactionError';
  }
}

export type ExpectedPayment = {
  sender: string;
  /** The sender's payment account, the transaction source. */
  paymentAccount: string;
  recipient: string;
  dest: Money;
  sendMax: Money;
  path: AssetId[];
};

export type BoundPayment = {
  hash: string;
  maxTime: number;
  sequence: string;
  /** Present only in presigned mode. */
  minSequence?: string;
  /** The account whose sequence the payment consumes: the payment account. */
  sequenceAccount: string;
};

const fromSdk = (a: S.Asset): AssetId => (a.isNative() ? { code: 'XLM' } : { code: a.getCode(), issuer: a.getIssuer() });

const amountEq = (sdkAmount: string, m: Money) => parseUnits(sdkAmount) === m.raw;

/**
 * Accepts a signed XDR only if it is exactly the payment the quote describes, sourced by the
 * sender's payment account, paid from the sender (operation source), signed by the sender alone,
 * with a live timebound and a minSeqNum. Anything the orchestrator cannot fully account for is
 * refused, which is what makes "it can only submit it or not" true.
 * Balance mode: the payment account's next transaction with a short timebound and no minSeqNum.
 */
export function assertBoundPayment(
  xdr: string,
  expected: ExpectedPayment,
  networkPassphrase: string,
  nowSec: number,
  mode: PaymentMode = 'presigned',
): BoundPayment {
  const balance = mode === 'balance';
  let tx: S.Transaction | S.FeeBumpTransaction;
  try {
    tx = S.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new UnboundTransactionError('not a transaction envelope for this network');
  }
  if (tx instanceof S.FeeBumpTransaction) throw new UnboundTransactionError('fee-bump envelopes are not accepted');

  if (!S.StrKey.isValidEd25519PublicKey(tx.source)) throw new UnboundTransactionError('source is not the sender\'s payment account');
  if (tx.source !== expected.paymentAccount) throw new UnboundTransactionError('source is not the sender\'s payment account');

  const hash = tx.hash();
  const sender = S.Keypair.fromPublicKey(expected.sender);
  const signedBySender = tx.signatures.some((s) => sender.verify(hash, s.signature));
  if (!signedBySender) throw new UnboundTransactionError('not signed by the sender');

  if (tx.operations.length !== 1) throw new UnboundTransactionError('expected exactly one operation');
  const op = tx.operations[0];
  if (op.type !== 'pathPaymentStrictReceive') throw new UnboundTransactionError('not a strict-receive path payment');
  if (op.source !== expected.sender) throw new UnboundTransactionError('operation source is not the sender');
  if (op.destination !== expected.recipient) throw new UnboundTransactionError('destination mismatch');
  if (!sameAsset(fromSdk(op.destAsset), expected.dest.asset)) throw new UnboundTransactionError('destination asset mismatch');
  if (!amountEq(op.destAmount, expected.dest)) throw new UnboundTransactionError('destination amount mismatch');
  if (!sameAsset(fromSdk(op.sendAsset), expected.sendMax.asset)) throw new UnboundTransactionError('send asset mismatch');
  if (!amountEq(op.sendMax, expected.sendMax)) throw new UnboundTransactionError('sendMax mismatch');
  const path = op.path.map(fromSdk);
  if (path.length !== expected.path.length || path.some((a, i) => !sameAsset(a, expected.path[i]))) {
    throw new UnboundTransactionError('path mismatch');
  }

  if (Number(tx.timeBounds?.minTime ?? 0) !== 0) throw new UnboundTransactionError('minTime must be 0');
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) throw new UnboundTransactionError('no maxTime');
  if (maxTime <= nowSec) throw new UnboundTransactionError('already expired');
  if (maxTime > nowSec + (balance ? BALANCE_TTL_SEC : PAYMENT_TTL_SEC) + 60) {
    throw new UnboundTransactionError('maxTime beyond the allowed window');
  }
  if (!balance && maxTime < nowSec + MIN_PAYMENT_TTL_SEC) throw new UnboundTransactionError('maxTime too close to leave time for the cash-in');

  if (balance) {
    // The caller checks that the sequence is the payment account's next one.
    if (tx.minAccountSequence !== undefined) throw new UnboundTransactionError('minSeqNum is not allowed for a balance payment');
  } else {
    if (tx.minAccountSequence === undefined) throw new UnboundTransactionError('no minSeqNum');
    if (BigInt(tx.sequence) - BigInt(tx.minAccountSequence) !== SEQ_WINDOW) {
      throw new UnboundTransactionError('sequence window is not the one Corra builds');
    }
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
  return { hash: hex, maxTime, sequence: tx.sequence, sequenceAccount: tx.source, ...(balance ? {} : { minSequence: tx.minAccountSequence }) };
}

/** The sequence number a signed payment consumes when it lands. */
export function signedSequence(signedXdr: string, networkPassphrase: string): bigint {
  const tx = S.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  if (tx instanceof S.FeeBumpTransaction) return BigInt(tx.innerTransaction.sequence);
  return BigInt(tx.sequence);
}

/**
 * The account whose sequence a signed payment consumes: its transaction source. The payment
 * account for blobs built since the payment-account fix, the sender for older ones.
 */
export function signedSourceAccount(signedXdr: string, networkPassphrase: string): string {
  const tx = S.TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  return tx instanceof S.FeeBumpTransaction ? tx.innerTransaction.source : tx.source;
}


export type ExpectedCashOut = { recipient: string; destination: string; amount: Money };

export type BoundCashOut = {
  /** The inner transaction's hash, hex; Horizon resolves the fee-bump by it. */
  hash: string;
  maxTime: number;
  sequence: bigint;
  /** The transaction source, whose sequence the payment consumes: the caller checks it is the recipient's payment account. */
  sequenceAccount: string;
  /** Hash memos as base64. */
  memo: CashOutMemo;
};

/** The SDK's memo as a CashOutMemo (hash as base64), or null for none or a return memo. */
function memoOf(m: S.Memo): CashOutMemo | null {
  if (m.type === S.MemoID) return { type: 'id', value: String(m.value) };
  if (m.type === S.MemoText) return { type: 'text', value: typeof m.value === 'string' ? m.value : Buffer.from(m.value as Uint8Array).toString('utf8') };
  if (m.type === S.MemoHash) return { type: 'hash', value: Buffer.from(m.value as Uint8Array).toString('base64') };
  return null;
}

/**
 * Accepts the recipient's withdrawal payment (D3) only if it is exactly what Corra builds: the
 * payment account's transaction, one payment from the recipient to the anchor's distribution
 * account of exactly the leg amount in TESTPHP, with the anchor's memo, fee 0, a short timebound
 * and the recipient's signature alone. Pure and offline; that the source is the recipient's
 * payment account and the sequence its next one need the chain and are the caller's.
 * `recordedHash`: the leg's recorded blob. When this blob is that one (a client retry), its time
 * window was checked when it was recorded and is not checked again; every other rule still is.
 */
export function assertCashOutPayment(xdr: string, e: ExpectedCashOut, networkPassphrase: string, nowSec: number, recordedHash?: string): BoundCashOut {
  let tx: S.Transaction | S.FeeBumpTransaction;
  try {
    tx = S.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    throw new UnboundTransactionError('not a transaction envelope for this network');
  }
  if (tx instanceof S.FeeBumpTransaction) throw new UnboundTransactionError('fee-bump envelopes are not accepted');
  if (!S.StrKey.isValidEd25519PublicKey(tx.source) || tx.source === e.recipient) {
    throw new UnboundTransactionError("source must be the recipient's payment account");
  }
  if (tx.operations.length !== 1 || tx.operations[0].type !== 'payment') throw new UnboundTransactionError('expected exactly one payment');
  const op = tx.operations[0];
  if (op.source !== e.recipient) throw new UnboundTransactionError('operation source is not the recipient');
  if (op.destination !== e.destination) throw new UnboundTransactionError("destination is not the anchor's distribution account");
  if (op.asset.isNative() || !sameAsset(fromSdk(op.asset), e.amount.asset)) {
    throw new UnboundTransactionError("asset is not TESTPHP from Corra's issuer");
  }
  if (parseUnits(op.amount) !== e.amount.raw) {
    throw new UnboundTransactionError(`amount must equal the payment's destination amount, ${toDecimal(e.amount)}`);
  }
  const memo = memoOf(tx.memo);
  if (!memo) throw new UnboundTransactionError("the anchor's memo is required");
  if (tx.fee !== '0') throw new UnboundTransactionError('inner fee must be 0; Corra pays through a fee-bump');
  if (Number(tx.timeBounds?.minTime ?? 0) !== 0) throw new UnboundTransactionError('minTime must be 0');
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime) throw new UnboundTransactionError('no maxTime');
  const hash = tx.hash();
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
  const recorded = recordedHash !== undefined && hex === recordedHash;
  if (!recorded && maxTime <= nowSec) throw new UnboundTransactionError('already expired');
  if (!recorded && maxTime > nowSec + CASH_OUT_TTL_SEC + 60) throw new UnboundTransactionError('maxTime beyond the allowed window');
  if (tx.minAccountSequence !== undefined || BigInt(tx.minAccountSequenceAge ?? 0) !== 0n ||
      (tx.minAccountSequenceLedgerGap ?? 0) !== 0 || tx.ledgerBounds || tx.extraSigners?.length) {
    throw new UnboundTransactionError('unexpected preconditions');
  }
  if (tx.signatures.length !== 1) throw new UnboundTransactionError("expected exactly one signature, the recipient's");
  if (!S.Keypair.fromPublicKey(e.recipient).verify(hash, tx.signatures[0].signature)) {
    throw new UnboundTransactionError('not signed by the recipient');
  }
  return { hash: hex, maxTime, sequence: BigInt(tx.sequence), sequenceAccount: tx.source, memo };
}

export type CashOutFacts = {
  txSource: string;
  /** The operation source, else the transaction source: whose TESTPHP moved. */
  from: string;
  destination: string;
  asset: AssetId;
  amountRaw: bigint;
  /** Hash memos as base64; null without a memo. */
  memo: CashOutMemo | null;
};

/** Decodes a landed envelope (plain or fee-bump) into its one `payment`; null unless it holds exactly one `payment` operation. */
export function cashOutFactsOf(envelopeXdr: string, networkPassphrase: string): CashOutFacts | null {
  let tx: S.Transaction;
  try {
    const t = S.TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
    tx = t instanceof S.FeeBumpTransaction ? t.innerTransaction : t;
  } catch {
    return null;
  }
  if (tx.operations.length !== 1 || tx.operations[0].type !== 'payment') return null;
  const op = tx.operations[0];
  return {
    txSource: tx.source,
    from: op.source ?? tx.source,
    destination: op.destination,
    asset: fromSdk(op.asset),
    amountRaw: parseUnits(op.amount),
    memo: memoOf(tx.memo),
  };
}

/** Memos of the same type with the same value: id as a number, text exactly, hash by its bytes (hex or base64 on either side). */
export function sameMemo(a: CashOutMemo, b: CashOutMemo): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'id') return /^\d{1,20}$/.test(a.value) && /^\d{1,20}$/.test(b.value) && BigInt(a.value) === BigInt(b.value);
  if (a.type === 'text') return a.value === b.value;
  const x = hashMemoBytes(a.value);
  const y = hashMemoBytes(b.value);
  return !!x && !!y && x.equals(y);
}
