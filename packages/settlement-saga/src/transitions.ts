import type { PaymentState } from '@corra/shared';

/**
 * CASH_IN -> EXPIRED is not in the original design table. It covers a real race: cash-in is
 * confirmed just before maxTime and the submission lands just after it (tx_too_late). The
 * transaction never enters a ledger, exactly like a SIGNED expiry, so it exits the same way.
 */
const ALLOWED: Record<PaymentState, readonly PaymentState[]> = {
  QUOTED: ['SIGNED'],
  SIGNED: ['CASH_IN', 'EXPIRED'],
  CASH_IN: ['ONCHAIN', 'EXPIRED'],
  ONCHAIN: ['CREDITED', 'CAP_EXCEEDED', 'FAILED'],
  CREDITED: [],
  EXPIRED: [],
  CAP_EXCEEDED: [],
  FAILED: [],
};

export const isAllowedTransition = (from: PaymentState, to: PaymentState) => ALLOWED[from].includes(to);

export const isTerminal = (s: PaymentState) => ALLOWED[s].length === 0;

export const PENDING_STATES: PaymentState[] = ['SIGNED', 'CASH_IN', 'ONCHAIN'];
