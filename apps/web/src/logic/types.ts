import type { PaymentEvent, PaymentWire, QuoteWire } from '@corra/shared';

export interface Position { amt: number; at: number; earned: number }

export interface Entry {
  kind: string; state: string; tone: number;
  inAmt: string; outAmt: string; earned?: string;
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
  pos: Record<string, Position>;
  vaultDigits: string; vaultPick: string;
  sign: Sign | null; signState: string;
  wallet: number;
  history: Entry[];
  walletMode: 'none' | 'freighter';
  pubkey: string | null;
  connecting: boolean;
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
