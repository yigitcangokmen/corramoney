import type { DepositWire, PaymentEvent, PaymentWire, QuoteWire } from '@corra/shared';

export type DepositStep = 'form' | 'starting' | 'waiting' | 'credited' | 'expired';

/** The memo the anchor asked for in its SEP-24 withdrawal; hash values as the anchor sent them. */
export type CashOutMemo = { type: 'id' | 'text' | 'hash'; value: string };
/** The recipient's cash-out in progress: the anchor's withdrawal id and page, and how far it got. */
export type CashOutActive = {
  paymentId: string; ref: string; url: string | null; urlAt: number;
  step: 'anchor' | 'sign' | 'submitting' | 'onchain';
  memo?: CashOutMemo; txHash?: string | null; ledger?: number | null;
};

/** The user's pool position as last read from the pool contract. */
export type PoolView = { status: number; bTokens: bigint; underlying: string; underlyingRaw: bigint; supplyApr: number };
export type PoolDone = { kind: 'supply' | 'withdraw'; amount: string; txHash: string | null; ledger: number | null };

export interface Entry {
  kind: string; state: string; tone: number;
  inAmt: string; outAmt: string;
  when: string; tx: string | null;
}

export interface Sign {
  title: string; op: string; dest: string; amt: string;
  run: () => void; cancel?: () => void;
}

export interface AppState {
  tab: string;
  pick: string; addr: string;
  remitStep: 'form' | 'review' | 'cashin' | 'track';
  destDigits: string;
  quote: QuoteWire | null;
  /** The anchor's SEP-38 firm quote for the cash-in leg, passed to Corra unchanged. */
  anchorQuote: { id: string; expiresAt: number; price: string; sellAmount: string; sellAsset: string } | null;
  setupDone: boolean;
  /** The sender's own account exists and trusts TESTMXN: setup then needs no Freighter prompt. */
  mxnTrusted: boolean;
  /** The sender's payment account, the source of every payment and pool move it signs; null = none known yet. */
  paymentAccount: string | null;
  anchorToken: string | null; anchorTokenExp: number;
  payment: (PaymentWire & { events: PaymentEvent[] }) | null;
  cashInUrl: string | null;
  remitBusy: string | null; remitError: string | null;
  /** Why live tracking of the payment on screen stopped (404, orchestrator unreachable). */
  trackError: string | null;
  /** The browser blocked the deposit popup; show the link instead. */
  popupBlocked: boolean;
  /** The new payment needs no new deposit: the earlier cash-in already covers it. */
  depositSkipped: boolean;
  /** Freighter is not installed in this browser. */
  freighterMissing: boolean;
  sign: Sign | null; signState: string;
  wallet: number;
  history: Entry[];
  walletMode: 'none' | 'freighter';
  pubkey: string | null;
  connecting: boolean;
  /** Review choice: pay from the TESTMXN already in the account, or sign first and pay at the anchor. */
  payFrom: 'balance' | 'anchor';
  /** TESTMXN balance minus selling liabilities, a decimal string; '0' when unknown. */
  walletSpendable: string;
  /** Other TEST* balances from Corra's issuer, non-zero (e.g. a recipient's TESTPHP). */
  otherBalances: Record<string, string>;
  /** When Horizon last answered for this account (ms); 0 = never. */
  balanceAt: number;
  /** When connect first tried to read the account (ms); 0 = not yet. */
  balanceTriedAt: number;
  /** Balance reads in a row that Horizon did not answer; 0 after an answer, a connect or a disconnect. */
  balanceFails: number;
  /** A Phase 1 payment of this sender is SIGNED and waiting for its cash-in. */
  signedWaiting: boolean;
  depositStep: DepositStep;
  /** The Add money amount, as typed. */
  depositAmount: string;
  deposit: DepositWire | null;
  /** The anchor's deposit page; null when unknown or too old to open. */
  depositUrl: string | null;
  /** When the anchor's deposit page was opened (ms), to age `depositUrl`. */
  depositUrlAt: number;
  depositBusy: string | null;
  depositError: string | null;
  depositPopupBlocked: boolean;
  poolRead: 'idle' | 'reading' | 'ready' | 'unavailable' | 'error';
  pool: PoolView | null;
  /** When the pool last answered (ms); 0 = never. */
  poolReadAt: number;
  poolReadError: string | null;
  /** The pool amount as typed, or 'all' (take back everything). */
  poolAmount: string;
  poolStep: 'form' | 'working' | 'done';
  poolBusy: string | null;
  poolError: string | null;
  poolDone: PoolDone | null;
  /** The account trusts TESTPHP from Corra's issuer (raised only by a refresh, like setupDone). */
  phpTrusted: boolean;
  /** TESTPHP balance minus selling liabilities, a decimal string; '0' when unknown. */
  phpSpendable: string;
  cashOutRead: 'idle' | 'reading' | 'ready' | 'error';
  /** CREDITED payments received by this account (with events for those with a cash-out underway). */
  cashOutRows: (PaymentWire & { events?: PaymentEvent[] })[];
  cashOutActive: CashOutActive | null;
  cashOutBusy: string | null;
  cashOutError: string | null;
  cashOutPopupBlocked: boolean;
}

export interface Props { mxnPerUsd?: number; spread?: number }

export interface Ctl {
  state: AppState;
  props: Props;
  set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState> | null)) => void;
  rate: number; spread: number; minAmt: number; maxAmt: number;
  trk: ReturnType<typeof setInterval>;
  refreshBalances: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => void;
  [key: string]: any;
}
