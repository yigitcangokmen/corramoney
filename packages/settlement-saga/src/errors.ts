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
