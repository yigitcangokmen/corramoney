/**
 * The shape of a CAP-33 setup transaction, checked before any key signs it: the sponsor's rules
 * (sponsor.ts) and the channel accounts' (channels.ts) are this one function with a different
 * scope. Pure, no keys. One sandwich per transaction, either
 *   - an account: begin, optionally createAccount with 0 XLM, the account's own changeTrust ops, end
 *   - a payment account: begin, createAccount with 0 XLM, the exact setOptions of paymentAccountSetupOf, end
 * with no memo and no precondition but a short time bound.
 */
import * as S from '@stellar/stellar-sdk';
import { SETUP_TTL_SEC } from './build';
import { paymentAccountSetupOf } from './payment-account';

export class SetupShapeError extends Error {
  name = 'SetupShapeError';
}

export type SetupShapeScope = {
  sponsor: string;
  /** Who may be the transaction source. */
  txSources: readonly string[];
  /** Channel accounts: never sponsored, never a payment account's signer. */
  channels: readonly string[];
  trustIssuer: string;
  trustCodes: readonly string[];
  /** Default 2. */
  maxTrust?: number;
  requireCreateAccount: boolean;
  nowSec: number;
};

export type SetupShape = { kind: 'account' | 'paymentAccount'; sponsored: string; createsAccount: boolean };

/** setOptions only ever passes inside a payment-account sandwich (checked first). */
const MIDDLE_OPS = new Set(['createAccount', 'changeTrust', 'setOptions']);
const MAX_FEE_PER_OP = 1000;

/** Throws a SetupShapeError naming the first rule `tx` breaks. The caller refuses a fee-bump first. */
export function assertSetupShape(tx: S.Transaction, s: SetupShapeScope): SetupShape {
  const refuse = (reason: string): never => {
    throw new SetupShapeError(reason);
  };
  const me = s.sponsor;
  if (!s.txSources.includes(tx.source)) refuse('setup must be sourced by the sponsor or a channel account');
  const ops = tx.operations;
  if (ops.length < 2) refuse('setup too short');
  if (Number(tx.fee) > MAX_FEE_PER_OP * ops.length) refuse('fee above the sponsor\'s cap');
  const maxTime = Number(tx.timeBounds?.maxTime ?? 0);
  if (!maxTime || maxTime <= s.nowSec || maxTime > s.nowSec + SETUP_TTL_SEC) refuse('setup needs a time bound within the next 5 minutes');
  if (Number(tx.timeBounds?.minTime ?? 0) !== 0 || tx.ledgerBounds || tx.minAccountSequence !== undefined ||
      Number(tx.minAccountSequenceAge ?? 0) !== 0 || Number(tx.minAccountSequenceLedgerGap ?? 0) !== 0 || (tx.extraSigners ?? []).length) {
    refuse('setup may carry no other precondition');
  }
  if (tx.memo.type !== S.MemoNone) refuse('setup carries no memo');

  // setOptions appears only in the payment-account sandwich, and only in its exact shape.
  let kind: SetupShape['kind'] = 'account';
  if (ops.some((op) => op.type === 'setOptions')) {
    let pa: { paymentAccount: string; signer: string };
    try {
      pa = paymentAccountSetupOf(ops, me);
    } catch (e) {
      throw new SetupShapeError((e as Error).message);
    }
    for (const k of [pa.paymentAccount, pa.signer]) {
      if (s.channels.includes(k) || k === tx.source) refuse('a channel account cannot be set up or be a signer');
    }
    kind = 'paymentAccount';
  }

  const first = ops[0];
  const last = ops[ops.length - 1];
  if (first.type !== 'beginSponsoringFutureReserves' || first.source !== me) {
    refuse('setup must open with the sponsor beginning sponsorship');
  }
  const sponsored = (first as S.Operation.BeginSponsoringFutureReserves).sponsoredId;
  if (sponsored === me) refuse('sponsor cannot sponsor itself');
  if (last.type !== 'endSponsoringFutureReserves' || last.source !== sponsored) {
    refuse('setup must close with the sponsored account ending sponsorship');
  }
  const trusted = new Set<string>();
  for (const op of ops.slice(1, -1)) {
    if (!MIDDLE_OPS.has(op.type)) refuse(`op not allowed in setup: ${op.type}`);
    if (op.type === 'changeTrust') {
      const line = op.line as S.Asset;
      if (!(line instanceof S.Asset) || line.isNative() || line.getIssuer() !== s.trustIssuer ||
          !s.trustCodes.includes(line.getCode())) {
        refuse('trustline asset not allowed');
      }
      if (Number(op.limit) === 0) refuse('removing a trustline is not a setup');
      if (trusted.has(line.getCode())) refuse('duplicate trustline');
      trusted.add(line.getCode());
      if (trusted.size > (s.maxTrust ?? 2)) refuse('too many trustlines');
    }
    if (op.type === 'createAccount') {
      if (op.source !== me || op.destination !== sponsored || Number(op.startingBalance) !== 0) {
        refuse('createAccount must fund the sponsored account with 0 XLM');
      }
    } else if (op.source !== sponsored) {
      refuse(`${op.type} must be sourced by the sponsored account`);
    }
  }
  if (s.channels.includes(sponsored) || sponsored === tx.source) refuse('a channel account cannot be set up');
  const createsAccount = ops.some((op) => op.type === 'createAccount');
  if (s.requireCreateAccount && !createsAccount) refuse('a channel account signs only a setup that creates a new account');
  return { kind, sponsored, createsAccount };
}
