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
  kind: 'deposit' | 'withdrawal';
  /** completed -> CONFIRMED; error | expired -> FAILED (and refunded, withdrawals only); else PENDING. */
  status: LegStatus;
  /** The anchor's raw SEP-24 status, e.g. 'pending_anchor'. */
  anchorStatus?: string;
  /** The anchor's Stellar payment hash (`stellar_transaction_id`), when it reports one. */
  stellarTxId?: string;
  /** The anchor's status page for this transaction (`more_info_url`), from the signed body. */
  moreInfoUrl?: string;
  /** The hash memo the anchor pays with (`deposit_memo`, base64), when it reports one. */
  depositMemo?: string;
  /** Deposit only: the account the anchor pays (`to`). */
  account?: string;
  /** Withdrawal only: the memo the anchor asked for; hash memos as base64. */
  withdrawMemo?: { type: 'id' | 'text' | 'hash'; value: string };
  /** Withdrawal only: the anchor's payout reference (`external_transaction_id`). */
  externalId?: string;
  at: number;
  raw: unknown;
};

export type PaymentKind = 'cash_in' | 'balance';

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
  /** 'cash_in': sign first, the anchor deposit pays for it (Phase 1). 'balance': paid from TESTMXN already in the sender's account. */
  kind: PaymentKind;
};

export type PaymentEvent = {
  seq: number;
  type: string;
  from: PaymentState | null;
  to: PaymentState | null;
  data?: Record<string, unknown>;
  at: number;
};

export type DepositStatus = 'PENDING' | 'CONFIRMED' | 'EXPIRED';
export type DepositMatchedBy = 'ref' | 'callback_tx' | 'chain';

/** A SEP-24 deposit into the user's own account, not bound to any payment. The balance itself lives on chain. */
export type Deposit = {
  /** dep_<32 hex> */
  id: string;
  account: string;
  anchorId: string;
  /** The anchor's SEP-24 transaction id. */
  anchorRef: string | null;
  /** Only from the anchor-signed callback, never from a client. */
  moreInfoUrl: string | null;
  /** cashInMemo(id): base64 sha256. */
  memo: string;
  /** TESTMXN with the corridor issuer. */
  requested: Money;
  /** Sum of every chain credit carrying the memo. */
  credited: Money | null;
  /** The latest credit's hash. */
  txHash: string | null;
  status: DepositStatus;
  matchedBy: DepositMatchedBy | null;
  /** 'no credit within 24h' | 'credited after expiry' | null */
  reason: string | null;
  createdAt: number;
  /** Last change or last chain check. */
  updatedAt: number;
};

/** Blend ids the app and the orchestrator use. Written by scripts/deploy-pool.ts. */
export type BlendIds = {
  plan: 'A' | 'B';
  factory: string;
  backstop: string;
  oracle: string;
  pool: string;
  /** Reserve SAC (C...). */
  asset: string;
  /** The reserve as a classic asset: Plan A TESTMXN + TESTNET.corridorIssuer. */
  assetCode: string;
  assetIssuer: string;
  /** Plan A: the team's script key. Plan B: null (Blend's). */
  admin: string | null;
  /** ISO time of the deploy. */
  deployedAt: string;
};

export type PoolOpKind = 'supply' | 'withdraw';
export type PoolOpStatus = 'SUBMITTED' | 'SUCCESS' | 'FAILED';

/** One Blend `submit` Corra fee-bumped. History and evidence only; the position lives in the pool contract. */
export type PoolOp = {
  /** pop_<32 hex> */
  id: string;
  idemKey: string;
  /** The inner source, which is also from, spender and to. */
  account: string;
  poolId: string;
  assetSac: string;
  kind: PoolOpKind;
  /** Requested; a withdraw may be clamped by the pool. */
  amount: Money;
  /** Hash of the user-signed inner transaction. */
  innerHash: string;
  /** The fee-bump envelope's hash (known before sending). */
  txHash: string | null;
  status: PoolOpStatus;
  /** tx_bad_seq, op_invoke_host_function_trapped, not_found, unknown (the RPC no longer holds the submit's ledgers), try_again_later ... */
  resultCode: string | null;
  /** The declared sorobanData.resourceFee, what the cap was checked against. */
  resourceFee: bigint | null;
  ledger: number | null;
  createdAt: number;
  updatedAt: number;
};
