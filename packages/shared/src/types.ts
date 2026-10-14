import type { AssetId } from './assets';
import type { Corridor } from './corridors';
import type { Money } from './money';

export type QuoteRequest = {
  corridor: Corridor;
  /** Strict-receive: the amount the recipient receives is fixed. */
  destAmount: Money;
};

export type Quote = {
  id: string;
  mode: 'strict_receive';
  corridor: Corridor;
  source: Money;
  dest: Money;
  path: AssetId[];
  maxSend: Money;
  slippageBps: number;
  expiresAt: number;
  anchorQuoteId?: string;
  anchorQuoteExpiresAt?: number;
};

export type PaymentState =
  | 'QUOTED'
  | 'SIGNED'
  | 'CASH_IN'
  | 'ONCHAIN'
  | 'CREDITED'
  | 'EXPIRED'
  | 'CAP_EXCEEDED'
  /** Landed as a failed transaction for a reason other than the cap (e.g. op_underfunded). */
  | 'FAILED';

export type LegStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

export type LegKind = 'cash_in' | 'onchain' | 'cash_out';

export type Leg = {
  kind: LegKind;
  anchorId?: string;
  externalRef?: string;
  txHash?: string;
  status: LegStatus;
  amount: Money;
};

export type Sep24Callback = {
  ref: string;
  kind: 'deposit' | 'withdraw';
  status: LegStatus;
  at: number;
  raw: unknown;
};

export type Payment = {
  id: string;
  publicId: string;
  senderAccount: string;
  recipientAccount: string;
  corridor: Corridor;
  quote: Quote;
  state: PaymentState;
  legs: Leg[];
  idemKey: string;
  signedXdr: string | null;
  /** Hash of the sender-signed inner transaction; Horizon resolves a fee-bump by it. */
  innerTxHash: string;
  /** Unix seconds, the timebound the sender signed. */
  maxTime: number;
  supersedesId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type PaymentEvent = {
  seq: number;
  type: string;
  from: PaymentState | null;
  to: PaymentState | null;
  data?: Record<string, unknown>;
  at: number;
};
