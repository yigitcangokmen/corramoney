/**
 * The ONLY module that holds the fee-and-sponsor key. It signs exactly two things:
 *   1. a CAP-15 fee-bump envelope around a payment the sender already signed
 *   2. a CAP-33 sponsorship-sandwich setup transaction (begin, createAccount with 0 XLM,
 *      the sender's own changeTrust ops, end)
 * Both are verified structurally before signing. Neither can move user value.
 * The no-server-side-signing CI job allows Keypair usage here and nowhere else.
 */
import * as S from '@stellar/stellar-sdk';
import { buildFeeBump, FEE_BUMP_BASE, MAX_FEE_BUMP_BASE } from './build';

export class SponsorRefusal extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'SponsorRefusal';
  }
}

export type Sponsor = {
  publicKey: string;
  /** `baseFee` per operation, in stroops; refused above MAX_FEE_BUMP_BASE. */
  feeBump(signedInnerXdr: string, baseFee?: number): string;
  signSetup(setupXdr: string, nowSec?: number): string;
};

/** Which trustlines the sponsor will pay reserves for. */
export type SponsorScope = { trustIssuer: string; trustCodes: string[]; maxTrust?: number };

const MIDDLE_OPS = new Set(['createAccount', 'changeTrust']);
const MAX_FEE_PER_OP = 1000;
const MAX_SETUP_TTL_SEC = 300;

export function createSponsor(secret: string, networkPassphrase: string, scope: SponsorScope): Sponsor {
  const key = S.Keypair.fromSecret(secret);
  const me = key.publicKey();

  return {
    publicKey: me,

    feeBump(signedInnerXdr, baseFee = FEE_BUMP_BASE) {
      if (!Number.isInteger(baseFee) || baseFee < FEE_BUMP_BASE || baseFee > MAX_FEE_BUMP_BASE) {
        throw new SponsorRefusal(`fee-bump bid must be ${FEE_BUMP_BASE}..${MAX_FEE_BUMP_BASE} stroops per operation`);
      }
      const inner = S.TransactionBuilder.fromXDR(signedInnerXdr, networkPassphrase);
      if (inner instanceof S.FeeBumpTransaction) throw new SponsorRefusal('already fee-bumped');
      if (inner.source === me) throw new SponsorRefusal('sponsor cannot be the inner source');
      for (const op of inner.operations) {
        if (op.source === me) throw new SponsorRefusal('sponsor cannot be an operation source');
        if ('destination' in op && op.destination === me) throw new SponsorRefusal('sponsor cannot receive value');
      }
      const bump = buildFeeBump(inner, me, networkPassphrase, baseFee);
      bump.sign(key);
      return bump.toXDR();
    },

    signSetup(setupXdr, nowSec = Math.floor(Date.now() / 1000)) {
      const tx = S.TransactionBuilder.fromXDR(setupXdr, networkPassphrase);
      if (tx instanceof S.FeeBumpTransaction) throw new SponsorRefusal('unexpected fee-bump');
      if (tx.source !== me) throw new SponsorRefusal('setup must be sourced by the sponsor');
      const ops = tx.operations;
      if (ops.length < 2) throw new SponsorRefusal('setup too short');
      if (Number(tx.fee) > MAX_FEE_PER_OP * ops.length) throw new SponsorRefusal('fee above the sponsor\'s cap');
      const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
      if (!maxTime || maxTime <= nowSec || maxTime > nowSec + MAX_SETUP_TTL_SEC) {
        throw new SponsorRefusal('setup needs a time bound within the next 5 minutes');
      }
      const first = ops[0];
      const last = ops[ops.length - 1];
      if (first.type !== 'beginSponsoringFutureReserves' || first.source !== me) {
        throw new SponsorRefusal('setup must open with the sponsor beginning sponsorship');
      }
      const sponsored = first.sponsoredId;
      if (sponsored === me) throw new SponsorRefusal('sponsor cannot sponsor itself');
      if (last.type !== 'endSponsoringFutureReserves' || last.source !== sponsored) {
        throw new SponsorRefusal('setup must close with the sponsored account ending sponsorship');
      }
      const trusted = new Set<string>();
      for (const op of ops.slice(1, -1)) {
        if (!MIDDLE_OPS.has(op.type)) throw new SponsorRefusal(`op not allowed in setup: ${op.type}`);
        if (op.type === 'changeTrust') {
          const line = op.line as S.Asset;
          if (!(line instanceof S.Asset) || line.isNative() || line.getIssuer() !== scope.trustIssuer ||
              !scope.trustCodes.includes(line.getCode())) {
            throw new SponsorRefusal('trustline asset not allowed');
          }
          if (Number(op.limit) === 0) throw new SponsorRefusal('removing a trustline is not a setup');
          if (trusted.has(line.getCode())) throw new SponsorRefusal('duplicate trustline');
          trusted.add(line.getCode());
          if (trusted.size > (scope.maxTrust ?? 2)) throw new SponsorRefusal('too many trustlines');
        }
        if (op.type === 'createAccount') {
          if (op.source !== me || op.destination !== sponsored || Number(op.startingBalance) !== 0) {
            throw new SponsorRefusal('createAccount must fund the sponsored account with 0 XLM');
          }
        } else if (op.source !== sponsored) {
          throw new SponsorRefusal(`${op.type} must be sourced by the sponsored account`);
        }
      }
      tx.sign(key);
      return tx.toXDR();
    },
  };
}
