import * as S from '@stellar/stellar-sdk';
import { toDecimal, type AssetId, type Money } from '@corra/shared';

export const toSdkAsset = (a: AssetId): S.Asset => (a.issuer ? new S.Asset(a.code, a.issuer) : S.Asset.native());

/**
 * The payment's sequence is the sender's current sequence + SEQ_WINDOW, with minSeqNum at the
 * current one: it stays valid while the sender's sequence is in [current, current + 99], so up to
 * 99 of the sender's own transactions may land between signing and submission.
 */
export const SEQ_WINDOW = 100n;
export const PAYMENT_TTL_SEC = 30 * 60;
/** The shortest window /confirm accepts: room for the SEP-24 cash-in before maxTime. */
export const MIN_PAYMENT_TTL_SEC = 10 * 60;

export type StrictReceiveParams = {
  networkPassphrase: string;
  sender: string;
  /** The sender account's current sequence number, read just before building. */
  senderSequence: string;
  recipient: string;
  dest: Money;
  sendMax: Money;
  /** Intermediate hops only, e.g. [USDC] for TESTMXN -> USDC -> TESTPHP. */
  path: AssetId[];
  /** Unix seconds. */
  now: number;
  ttlSec?: number;
};

/**
 * Builds the unsigned payment the sender signs once in their own wallet.
 *
 * - strict-receive: the recipient amount is fixed, the cost is capped by sendMax
 * - maxTime: the transaction is dead on the network after the TTL
 * - minSeqNum (CAP-21): valid while the sender's sequence stays within
 *   [senderSequence, senderSequence + SEQ_WINDOW), instead of one exact value
 * - fee 0: the orchestrator's fee-bump (CAP-15) pays, so the sender needs no XLM
 */
export function buildStrictReceive(p: StrictReceiveParams): S.Transaction {
  const current = BigInt(p.senderSequence);
  const txSeq = current + SEQ_WINDOW;
  // TransactionBuilder increments the account's sequence by one when it builds.
  const account = new S.Account(p.sender, (txSeq - 1n).toString());
  return new S.TransactionBuilder(account, {
    fee: '0',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + (p.ttlSec ?? PAYMENT_TTL_SEC) },
    minAccountSequence: current.toString(),
  })
    .addOperation(
      S.Operation.pathPaymentStrictReceive({
        sendAsset: toSdkAsset(p.sendMax.asset),
        sendMax: toDecimal(p.sendMax),
        destination: p.recipient,
        destAsset: toSdkAsset(p.dest.asset),
        destAmount: toDecimal(p.dest),
        path: p.path.map(toSdkAsset),
      }),
    )
    .build();
}

export type SponsoredSetupParams = {
  networkPassphrase: string;
  sponsor: string;
  sponsorSequence: string;
  account: string;
  accountExists: boolean;
  trust: AssetId[];
  now: number;
};

/**
 * CAP-33 sponsorship sandwich. The sponsor is the transaction source and pays the fee and
 * every reserve; a new account is created with a 0 XLM balance. The sponsored account must
 * sign too, because it is the source of changeTrust and of the closing EndSponsoring op.
 */
export function buildSponsoredSetup(p: SponsoredSetupParams): S.Transaction {
  const b = new S.TransactionBuilder(new S.Account(p.sponsor, p.sponsorSequence), {
    fee: '1000',
    networkPassphrase: p.networkPassphrase,
    timebounds: { minTime: 0, maxTime: p.now + 300 },
  }).addOperation(S.Operation.beginSponsoringFutureReserves({ sponsoredId: p.account, source: p.sponsor }));
  if (!p.accountExists) {
    b.addOperation(S.Operation.createAccount({ destination: p.account, startingBalance: '0', source: p.sponsor }));
  }
  for (const asset of p.trust) {
    b.addOperation(S.Operation.changeTrust({ asset: toSdkAsset(asset), source: p.account }));
  }
  return b.addOperation(S.Operation.endSponsoringFutureReserves({ source: p.account })).build();
}

/** The fee-bump bid per operation in stroops: the default, and the most the sponsor will ever bid. */
export const FEE_BUMP_BASE = 1000;
export const MAX_FEE_BUMP_BASE = 20_000;

/** CAP-15: wraps a sender-signed transaction so the fee source pays. Signing is the caller's. */
export function buildFeeBump(inner: S.Transaction, feeSource: string, networkPassphrase: string, baseFee = FEE_BUMP_BASE): S.FeeBumpTransaction {
  // baseFee is per operation; the SDK multiplies it by (inner ops + 1).
  return S.TransactionBuilder.buildFeeBumpTransaction(feeSource, String(baseFee), inner, networkPassphrase);
}
