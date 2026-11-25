/**
 * The sender's payment account: a second 0-XLM account the sponsor creates under CAP-33, whose
 * master key has weight 0 and whose only signer is the sender. It is the transaction source of
 * every payment and pool step the sender signs, so the sender's wallet is never the fee source
 * (Varial skips its fee check then). It holds no value and only provides the sequence number;
 * only the sender's key can move it.
 */
import * as S from '@stellar/stellar-sdk';

/** The fields of a Horizon account record this module reads. */
export type AccountRecordLike = {
  id: string;
  sponsor?: string;
  thresholds: { low_threshold: number; med_threshold: number; high_threshold: number };
  signers: { key: string; weight: number; type: string; sponsor?: string }[];
  balances: { asset_type: string }[];
  flags: { auth_required?: boolean; auth_revocable?: boolean; auth_immutable?: boolean; auth_clawback_enabled?: boolean };
};

/** True iff `rec` is a payment account of `sender` that `sponsor` set up, and nothing more. */
export function isPaymentAccount(rec: AccountRecordLike, sender: string, sponsor: string): boolean {
  if (rec.id === sender || rec.sponsor !== sponsor) return false;
  const t = rec.thresholds;
  if (t.low_threshold !== 1 || t.med_threshold !== 1 || t.high_threshold !== 1) return false;
  if (rec.signers.length !== 2) return false;
  const master = rec.signers.find((s) => s.key === rec.id);
  const signer = rec.signers.find((s) => s.key === sender);
  if (!master || master.weight !== 0) return false;
  if (!signer || signer.weight !== 1 || signer.type !== 'ed25519_public_key') return false;
  // The sponsor also sponsors the sender's signer entry on a real one; a reshaped account it only created does not pass.
  if (signer.sponsor !== sponsor) return false;
  if (rec.balances.length !== 1 || rec.balances[0].asset_type !== 'native') return false;
  const f = rec.flags;
  return !f.auth_required && !f.auth_revocable && !f.auth_immutable && !f.auth_clawback_enabled;
}

/** setOptions fields a payment-account setup sets; every other field must be absent. */
const SET_OPTIONS_FIELDS = new Set(['type', 'source', 'masterWeight', 'lowThreshold', 'medThreshold', 'highThreshold', 'signer']);

/**
 * Checks the operations of a payment-account setup and returns who is who. Exactly:
 *   begin(Z) src sponsor, createAccount(Z, 0 XLM) src sponsor,
 *   setOptions src Z { masterWeight 0, thresholds 1/1/1, signer: an ed25519 key with weight 1 },
 *   end src Z.
 * Throws an Error naming the first difference.
 */
export function paymentAccountSetupOf(ops: S.Operation[], sponsor: string): { paymentAccount: string; signer: string } {
  if (ops.length !== 4) throw new Error('a payment-account setup has exactly four operations');
  const [begin, create, options, end] = ops as any[];
  if (begin.type !== 'beginSponsoringFutureReserves' || begin.source !== sponsor) {
    throw new Error('setup must open with the sponsor beginning sponsorship');
  }
  const z: string = begin.sponsoredId;
  if (z === sponsor) throw new Error('sponsor cannot sponsor itself');
  if (create.type !== 'createAccount' || create.source !== sponsor || create.destination !== z || Number(create.startingBalance) !== 0) {
    throw new Error('createAccount must fund the payment account with 0 XLM');
  }
  if (options.type !== 'setOptions' || options.source !== z) throw new Error('setOptions must be sourced by the payment account');
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined && !SET_OPTIONS_FIELDS.has(k)) throw new Error(`setOptions may not set ${k}`);
  }
  if (options.masterWeight !== 0) throw new Error('the payment account\'s master key must have weight 0');
  if (options.lowThreshold !== 1 || options.medThreshold !== 1 || options.highThreshold !== 1) {
    throw new Error('the payment account\'s thresholds must be 1/1/1');
  }
  const signer = options.signer;
  if (!signer || Object.keys(signer).length !== 2 || typeof signer.ed25519PublicKey !== 'string' || signer.weight !== 1) {
    throw new Error('the payment account needs exactly one ed25519 signer with weight 1');
  }
  if (signer.ed25519PublicKey === z || signer.ed25519PublicKey === sponsor) {
    throw new Error('the payment account\'s signer must be the sender');
  }
  if (end.type !== 'endSponsoringFutureReserves' || end.source !== z) {
    throw new Error('setup must close with the payment account ending sponsorship');
  }
  return { paymentAccount: z, signer: signer.ed25519PublicKey };
}

/**
 * The browser's check before it adds the throwaway key's signature: `xdr` creates exactly the
 * payment account `paymentAccount` with `sender` as its only signer, sponsored by `sponsor`, and
 * nothing else. The transaction source is the sponsor or one of Corra's channel accounts; the
 * browser signs only with z.
 */
export function assertPaymentAccountSetup(xdr: string, sender: string, paymentAccount: string, networkPassphrase: string, sponsor: string): void {
  const tx = S.TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if (tx instanceof S.FeeBumpTransaction) throw new Error('unexpected fee-bump');
  if (tx.source === sender || tx.source === paymentAccount) throw new Error('setup must be sourced by the sponsor or a channel account');
  const got = paymentAccountSetupOf(tx.operations, sponsor);
  if (got.paymentAccount !== paymentAccount) throw new Error('setup creates another payment account');
  if (got.signer !== sender) throw new Error('the payment account\'s signer must be the sender');
}
