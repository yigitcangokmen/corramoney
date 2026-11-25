/**
 * The ONLY module that holds the fee-and-sponsor key. The sponsor still signs exactly two things:
 *   1. a CAP-15 fee-bump around one sender-signed path payment, one recipient-signed cash-out
 *      payment to the anchor's distribution account, or one user-signed pool `submit` that passes
 *      `assertPoolSubmit`
 *   2. a CAP-33 sponsorship-sandwich setup transaction, one sandwich per transaction, either
 *      - the sender's account: begin, createAccount with 0 XLM, the sender's own changeTrust ops, end
 *      - the sender's payment account: begin, createAccount with 0 XLM, setOptions on the new
 *        account (master weight 0, thresholds 1/1/1, the sender as its only signer), end
 *      whose transaction source is the sponsor, or one of Corra's channel accounts (`channels.ts`)
 *      for a setup that creates an account (assertSetupShape)
 * Both are verified structurally before signing. Neither can move user value, and the sponsor
 * never becomes a signer of any account.
 * The no-server-side-signing CI job allows Keypair usage here and nowhere else.
 */
import * as S from '@stellar/stellar-sdk';
import type { AssetId } from '@corra/shared';
import { buildFeeBump, FEE_BUMP_BASE, MAX_FEE_BUMP_BASE } from './build';
import { assertPoolSubmit, type PoolScope } from './pool';
import { assertSetupShape, SetupShapeError } from './setup-shape';

export class SponsorRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SponsorRefusal';
  }
}

export type Sponsor = {
  publicKey: string;
  /** `baseFee` per operation, in stroops; refused above MAX_FEE_BUMP_BASE. `nowSec` bounds a pool submit's time window. */
  feeBump(signedInnerXdr: string, baseFee?: number, nowSec?: number): string;
  signSetup(setupXdr: string, nowSec?: number): string;
};

/**
 * Which trustlines the sponsor will pay reserves for, which pool's `submit` it will fee-bump, and
 * where a cash-out payment it fee-bumps may go (the anchor's distribution account, in TESTPHP).
 */
export type SponsorScope = {
  trustIssuer: string;
  trustCodes: string[];
  maxTrust?: number;
  pool?: PoolScope;
  cashOut?: { destination: string; asset: AssetId };
  /** Corra's channel accounts (public keys): may be the tx source of a setup that creates an account; never part of a fee-bump. */
  channels?: readonly string[];
};

export function createSponsor(secret: string, networkPassphrase: string, scope: SponsorScope): Sponsor {
  const key = S.Keypair.fromSecret(secret);
  const me = key.publicKey();
  const channels = scope.channels ?? [];

  return {
    publicKey: me,

    feeBump(signedInnerXdr, baseFee = FEE_BUMP_BASE, nowSec = Math.floor(Date.now() / 1000)) {
      if (!Number.isInteger(baseFee) || baseFee < FEE_BUMP_BASE || baseFee > MAX_FEE_BUMP_BASE) {
        throw new SponsorRefusal(`fee-bump bid must be ${FEE_BUMP_BASE}..${MAX_FEE_BUMP_BASE} stroops per operation`);
      }
      const inner = S.TransactionBuilder.fromXDR(signedInnerXdr, networkPassphrase);
      if (inner instanceof S.FeeBumpTransaction) throw new SponsorRefusal('already fee-bumped');
      if (inner.source === me) throw new SponsorRefusal('sponsor cannot be the inner source');
      const ops = inner.operations;
      if (ops.length !== 1) throw new SponsorRefusal('a fee-bumped transaction carries exactly one operation');
      const op = ops[0];
      if (op.source === me) throw new SponsorRefusal('sponsor cannot be an operation source');
      if (channels.includes(inner.source) || (op.source && channels.includes(op.source))) {
        throw new SponsorRefusal('a channel account is never part of a fee-bumped transaction');
      }
      if (op.type === 'invokeHostFunction') {
        if (!scope.pool) throw new SponsorRefusal('no pool is configured');
        // A PoolRefusal propagates with its own reason.
        assertPoolSubmit(signedInnerXdr, scope.pool, networkPassphrase, nowSec, me);
      } else if (op.type === 'payment') {
        // The amount is the saga's check (assertCashOutPayment against the leg): the sponsor has no leg context.
        const c = scope.cashOut;
        if (!c) throw new SponsorRefusal('no cash-out destination is configured');
        const a = op.asset as S.Asset;
        if (op.destination !== c.destination || a.isNative() || a.getCode() !== c.asset.code || a.getIssuer() !== c.asset.issuer) {
          throw new SponsorRefusal('a payment is fee-bumped only to the anchor distribution account in TESTPHP');
        }
        if (!op.source || op.source === inner.source) throw new SponsorRefusal('a cash-out payment needs the recipient as operation source');
        if (inner.memo.type === S.MemoNone) throw new SponsorRefusal('a cash-out payment needs the anchor memo');
      } else if (op.type === 'pathPaymentStrictReceive') {
        if (op.destination === me) throw new SponsorRefusal('sponsor cannot receive value');
      } else {
        throw new SponsorRefusal(`operation not allowed in a fee-bump: ${op.type}`);
      }
      // For a Soroban inner the SDK adds its resource fee: outer = resourceFee + baseFee x 2.
      const bump = buildFeeBump(inner, me, networkPassphrase, baseFee);
      bump.sign(key);
      return bump.toXDR();
    },

    signSetup(setupXdr, nowSec = Math.floor(Date.now() / 1000)) {
      const tx = S.TransactionBuilder.fromXDR(setupXdr, networkPassphrase);
      if (tx instanceof S.FeeBumpTransaction) throw new SponsorRefusal('unexpected fee-bump');
      try {
        assertSetupShape(tx, {
          sponsor: me, txSources: [me, ...channels], channels, trustIssuer: scope.trustIssuer, trustCodes: scope.trustCodes,
          maxTrust: scope.maxTrust,
          // A channel-sourced setup is signed only when it creates an account, independently of channels.ts.
          requireCreateAccount: tx.source !== me, nowSec,
        });
      } catch (e) {
        if (e instanceof SetupShapeError) throw new SponsorRefusal(e.message);
        throw e;
      }
      tx.sign(key);
      return tx.toXDR();
    },
  };
}
