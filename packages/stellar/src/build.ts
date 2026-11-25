import * as S from '@stellar/stellar-sdk';
import { toDecimal, type AssetId, type Money } from '@corra/shared';

export const toSdkAsset = (a: AssetId): S.Asset => (a.issuer ? new S.Asset(a.code, a.issuer) : S.Asset.native());

/**
 * The payment's sequence is the payment account's current sequence + SEQ_WINDOW, with minSeqNum at
 * the current one: it stays valid while that sequence is in [current, current + 99], so up to 99 of
 * the sender's other Corra transactions may land between signing and submission.
 */
export const SEQ_WINDOW = 100n;
export const PAYMENT_TTL_SEC = 30 * 60;
/** The shortest window /confirm accepts: room for the SEP-24 cash-in before maxTime. */
export const MIN_PAYMENT_TTL_SEC = 10 * 60;
/** A balance payment is built and submitted within seconds: no pre-signing window. */
export const BALANCE_TTL_SEC = 300;

/** 'presigned': signed before the cash-in (Phase 1). 'balance': paid from the sender's balance right away. */
export type PaymentMode = 'presigned' | 'balance';

export type StrictReceiveParams = {
  networkPassphrase: string;
  /** The operation source: the account that pays and the only signer. */
  sender: string;
  /** The transaction source: the sender's payment account (see payment-account.ts). */
  paymentAccount: string;
  /** The payment account's current sequence number, read just before building. */
  paymentSequence: string;
  recipient: string;
  dest: Money;
  sendMax: Money;
  /** Intermediate hops only, e.g. [USDC] for TESTMXN -> USDC -> TESTPHP. */
  path: AssetId[];
  /** Unix seconds. */
  now: number;
  ttlSec?: number;
  /** Default 'presigned' (Phase 1). */
  mode?: PaymentMode;
};

/**
 * Builds the unsigned payment the sender signs once in their own wallet.
 *
 * - transaction source = the sender's payment account, operation source = the sender: the sender
 *   is never the fee source, so the wallet runs no fee check, and still signs alone
 * - strict-receive: the recipient amount is fixed, the cost is capped by sendMax
 * - maxTime: the transaction is dead on the network after the TTL
 * - minSeqNum (CAP-21): valid while the payment account's sequence stays within
 *   [paymentSequence, paymentSequence + SEQ_WINDOW), instead of one exact value
 * - fee 0: the orchestrator's fee-bump (CAP-15) pays, so the sender needs no XLM
 * - balance mode: the sender already holds the funds, so the payment is the payment account's
 *   next transaction (sequence current + 1, no minSeqNum) and dies after BALANCE_TTL_SEC
 */
export function buildStrictReceive(p: StrictReceiveParams): S.Transaction {
  const balance = p.mode === 'balance';
  const current = BigInt(p.paymentSequence);
  const txSeq = balance ? current + 1n : current + SEQ_WINDOW;
  // TransactionBuilder increments the account's sequence by one when it builds.
  const account = new S.Account(p.paymentAccount, (txSeq - 1n).toString());
  return new S.TransactionBuilder(account, {
    fee: '0',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + (p.ttlSec ?? (balance ? BALANCE_TTL_SEC : PAYMENT_TTL_SEC)) },
    ...(balance ? {} : { minAccountSequence: current.toString() }),
  })
    .addOperation(
      S.Operation.pathPaymentStrictReceive({
        sendAsset: toSdkAsset(p.sendMax.asset),
        sendMax: toDecimal(p.sendMax),
        destination: p.recipient,
        destAsset: toSdkAsset(p.dest.asset),
        destAmount: toDecimal(p.dest),
        path: p.path.map(toSdkAsset),
        source: p.sender,
      }),
    )
    .build();
}

/** A sponsored setup is built, co-signed and submitted within this. */
export const SETUP_TTL_SEC = 300;

export type SetupTxSource = { account: string; sequence: string };

export type SponsoredSetupParams = {
  networkPassphrase: string;
  sponsor: string;
  sponsorSequence: string;
  /** A transaction source other than the sponsor: a leased channel account and its current sequence. */
  txSource?: SetupTxSource;
  account: string;
  accountExists: boolean;
  trust: AssetId[];
  now: number;
};

/**
 * CAP-33 sponsorship sandwich. The transaction source (the sponsor, or a leased channel) pays the
 * fee and provides the sequence; the sponsor pays every reserve (CAP-33: the sponsor is the `begin`
 * op source). A new account is created with a 0 XLM balance. The sponsored account must sign too,
 * because it is the source of changeTrust and of the closing EndSponsoring op.
 */
export function buildSponsoredSetup(p: SponsoredSetupParams): S.Transaction {
  const b = new S.TransactionBuilder(new S.Account(p.txSource?.account ?? p.sponsor, p.txSource?.sequence ?? p.sponsorSequence), {
    fee: '1000',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + SETUP_TTL_SEC },
  }).addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: p.account, source: p.sponsor }));
  if (!p.accountExists) {
    b.addOperation(S.Operation.createAccount({ destination: p.account, startingBalance: '0', source: p.sponsor }));
  }
  for (const asset of p.trust) {
    b.addOperation(S.Operation.changeTrust({ asset: toSdkAsset(asset), source: p.account }));
  }
  return b.addOperation(S.Operation.endSponsoringFutureReserves({ source: p.account })).build();
}

export type PaymentAccountSetupParams = {
  networkPassphrase: string;
  sponsor: string;
  sponsorSequence: string;
  /** A transaction source other than the sponsor: a leased channel account and its current sequence. */
  txSource?: SetupTxSource;
  /** The only signer of the new account; it need not exist yet. */
  sender: string;
  /** A fresh key from the browser, used once to sign this transaction. */
  paymentAccount: string;
  now: number;
};

/**
 * The sender's payment account, in its own sponsorship sandwich: created with 0 XLM, its master
 * key set to weight 0 and the sender added as its only signer, in the same transaction. Signed by
 * the sponsor and by the browser's throwaway key for the new account (and by a leased channel when
 * it is the transaction source); the sender signs nothing. The transaction source (the sponsor, or
 * a leased channel) pays the fee and provides the sequence; the sponsor pays every reserve (CAP-33:
 * the sponsor is the `begin` op source).
 */
export function buildPaymentAccountSetup(p: PaymentAccountSetupParams): S.Transaction {
  return new S.TransactionBuilder(new S.Account(p.txSource?.account ?? p.sponsor, p.txSource?.sequence ?? p.sponsorSequence), {
    fee: '1000',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + SETUP_TTL_SEC },
  })
    .addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: p.paymentAccount, source: p.sponsor }))
    .addOperation(S.Operation.createAccount({ destination: p.paymentAccount, startingBalance: '0', source: p.sponsor }))
    .addOperation(S.Operation.setOptions({
      source: p.paymentAccount, masterWeight: 0, lowThreshold: 1, medThreshold: 1, highThreshold: 1,
      signer: { ed25519PublicKey: p.sender, weight: 1 },
    }))
    .addOperation(S.Operation.endSponsoringFutureReserves({ source: p.paymentAccount }))
    .build();
}

/** A withdrawal payment is built and signed right after the anchor asks for it, then submitted at once. */
export const CASH_OUT_TTL_SEC = 300;

/** The memo the anchor asked for in its SEP-24 withdrawal. A hash value is 64 hex characters or base64. */
export type CashOutMemo = { type: 'id' | 'text' | 'hash'; value: string };

export type CashOutParams = {
  networkPassphrase: string;
  /** The operation source: the recipient, who holds the TESTPHP and is the only signer. */
  recipient: string;
  /** The transaction source: the recipient's payment account. */
  paymentAccount: string;
  /** The payment account's current sequence number, read just before building. */
  paymentSequence: string;
  /** The anchor's withdraw_anchor_account, already checked against the disclosed distribution account by the caller. */
  destination: string;
  /** The cash-out leg amount (TESTPHP). */
  amount: Money;
  memo: CashOutMemo;
  /** Unix seconds. */
  now: number;
};

const U64_MAX = 2n ** 64n - 1n;

/** The 32 bytes of a hash memo given as 64 hex characters or base64; null for anything else. */
export function hashMemoBytes(v: string): Buffer | null {
  const b = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : /^[A-Za-z0-9+/]{43}=$/.test(v) ? Buffer.from(v, 'base64') : null;
  return b && b.length === 32 ? b : null;
}

/** id must be a u64 decimal, text at most 28 bytes, hash exactly 32 bytes (hex or base64); anything else throws. */
export function toSdkMemo(m: CashOutMemo): S.Memo {
  if (m.type === 'id') {
    if (!/^\d{1,20}$/.test(m.value) || BigInt(m.value) > U64_MAX) throw new Error('an id memo must be a u64 decimal');
    return S.Memo.id(m.value);
  }
  if (m.type === 'text') {
    if (Buffer.byteLength(m.value, 'utf8') > 28) throw new Error('a text memo holds at most 28 bytes');
    return S.Memo.text(m.value);
  }
  if (m.type === 'hash') {
    const b = hashMemoBytes(m.value);
    if (!b) throw new Error('a hash memo must be 32 bytes, as 64 hex characters or base64');
    return S.Memo.hash(b);
  }
  throw new Error('unknown memo type');
}

/**
 * The recipient's SEP-24 withdrawal payment (D3): the TESTPHP the payment delivered, paid to the
 * anchor's distribution account with the anchor's memo.
 *
 * - transaction source = the recipient's payment account, operation source = the recipient: the
 *   recipient is never the fee source, so the wallet runs no fee check, and still signs alone
 * - the payment account's next transaction (sequence current + 1, no minSeqNum), dead after CASH_OUT_TTL_SEC
 * - fee 0: Corra fee-bumps it
 */
export function buildCashOutPayment(p: CashOutParams): S.Transaction {
  const account = new S.Account(p.paymentAccount, p.paymentSequence);
  return new S.TransactionBuilder(account, {
    fee: '0',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + CASH_OUT_TTL_SEC },
    memo: toSdkMemo(p.memo),
  })
    .addOperation(S.Operation.payment({
      source: p.recipient,
      destination: p.destination,
      asset: toSdkAsset(p.amount.asset),
      amount: toDecimal(p.amount),
    }))
    .build();
}

/** The fee-bump bid per operation in stroops: the default, and the most the sponsor will ever bid. */
export const FEE_BUMP_BASE = 1000;
export const MAX_FEE_BUMP_BASE = 20_000;

/** CAP-15: wraps a sender-signed transaction so the fee source pays. Signing is the caller's. */
export function buildFeeBump(inner: S.Transaction, feeSource: string, networkPassphrase: string, baseFee = FEE_BUMP_BASE): S.FeeBumpTransaction {
  // baseFee is per operation; the SDK multiplies it by (inner ops + 1).
  return S.TransactionBuilder.buildFeeBumpTransaction(feeSource, String(baseFee), inner, networkPassphrase);
}
