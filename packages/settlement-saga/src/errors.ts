import { toDecimal, type Money } from '@corra/shared';

export class SagaError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retriable = false,
  ) {
    super(message);
    this.name = 'SagaError';
  }
}

export const noPath = () => new SagaError('NO_PATH', 422, 'no route for this corridor and amount', true);
export const quoteNotFound = () => new SagaError('QUOTE_NOT_FOUND', 404, 'unknown quote');
export const quoteExpired = () => new SagaError('QUOTE_EXPIRED', 409, 'quote expired, request a new one', true);
export const quoteUsed = () => new SagaError('QUOTE_USED', 409, 'quote already confirmed by another payment');
export const unbound = (reason: string) => new SagaError('UNBOUND_TRANSACTION', 422, reason);
export const recipientNotReady = () =>
  new SagaError('RECIPIENT_NO_TRUSTLINE', 422, 'recipient has no trustline for the destination asset', true);
export const paymentNotFound = () => new SagaError('PAYMENT_NOT_FOUND', 404, 'unknown payment');
export const notResignable = () =>
  new SagaError('NOT_RESIGNABLE', 409, 'only an EXPIRED, CAP_EXCEEDED or FAILED payment can be re-signed');
export const paymentInProgress = () =>
  new SagaError('PAYMENT_IN_PROGRESS', 409, 'a payment from this sender is already being settled; wait for it to finish', true);
export const signedPaymentWaiting = () => new SagaError('SIGNED_PAYMENT_WAITING', 409,
  'a signed payment of this sender is waiting for its cash-in; finish its deposit, or pay at the anchor instead, then wait until the signed payment is credited or expires', true);
export const idempotencyReused = () =>
  new SagaError('IDEMPOTENCY_KEY_REUSED', 409, 'this Idempotency-Key was already used for a different request');
export const cashInAlreadyLinked = () =>
  new SagaError('CASH_IN_ALREADY_LINKED', 409, 'this payment is already linked to another cash-in reference');
export const publicIdTaken = () => new SagaError('PUBLIC_ID_TAKEN', 409, 'public id collision', true);
export const illegalTransition = (from: string, to: string) =>
  new SagaError('ILLEGAL_TRANSITION', 409, `illegal transition ${from} -> ${to}`);
export const alreadySuperseded = () => new SagaError('ALREADY_SUPERSEDED', 409, 'this payment was already re-signed');
export const duplicateTransaction = () =>
  new SagaError('DUPLICATE_TRANSACTION', 409, 'this signed transaction already backs another payment');
export const insufficientBalance = (have: Money | null, needs: Money) => new SagaError('INSUFFICIENT_BALANCE', 422,
  `insufficient ${needs.asset.code} balance: have ${have ? toDecimal(have) : '0'}, the payment needs up to ${toDecimal(needs)}`, true);
export const depositNotFound = () => new SagaError('DEPOSIT_NOT_FOUND', 404, 'unknown deposit');
export const depositAlreadyLinked = (why = 'this deposit is already linked to another anchor reference') =>
  new SagaError('DEPOSIT_ALREADY_LINKED', 409, why);
export const accountNotReady = () =>
  new SagaError('ACCOUNT_NOT_READY', 422, 'the account does not exist or has no TESTMXN trustline; set it up first', true);
export const rateLimited = () => new SagaError('RATE_LIMITED', 429, 'too many requests, try again later', true);
export const cashOutNotReady = () =>
  new SagaError('CASH_OUT_NOT_READY', 409, "the payment has not reached the recipient's account yet", true);
export const cashOutNotAvailable = (code: string) => new SagaError('CASH_OUT_NOT_AVAILABLE', 422,
  `withdrawal is enabled for TESTPHP only on testnet; this payment is in ${code}`);
export const alreadyCashedOut = () => new SagaError('ALREADY_CASHED_OUT', 409, 'this payment was already cashed out');
export const cashOutInProgress = () =>
  new SagaError('CASH_OUT_IN_PROGRESS', 409, 'an earlier withdrawal payment may still land; try again in a few minutes', true);
export const cashOutAlreadyPaid = () =>
  new SagaError('CASH_OUT_ALREADY_PAID', 409, 'the anchor was already paid for this payment; waiting for its confirmation');
export const cashOutRefTaken = () =>
  new SagaError('CASH_OUT_REF_TAKEN', 409, 'this anchor reference already belongs to another payment');
export const cashOutRefMismatch = () =>
  new SagaError('CASH_OUT_REF_MISMATCH', 409, 'this signed payment was sent for another anchor withdrawal');
export const cashOutAttempts = () =>
  new SagaError('CASH_OUT_ATTEMPTS', 409, 'three withdrawal payments for this payment failed on chain; contact the team');
export const cashOutAnchorStopped = () =>
  new SagaError('CASH_OUT_ANCHOR_STOPPED', 409, 'the anchor stopped this withdrawal; start a new withdrawal');
export const cashOutFailed = (codes: string) =>
  new SagaError('CASH_OUT_FAILED', 422, `the withdrawal payment did not land (${codes}); nothing moved, sign again`, true);
/** Retriable, and not 503: the client keeps the signed blob and sends it again. */
export const sendFailed = (message = 'the network did not answer; Corra keeps checking this payment') =>
  new SagaError('SEND_FAILED', 502, message, true);
