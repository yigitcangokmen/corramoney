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
  depStep: string; depDigits: string; depProg: number; depRef: number;
  sendStep: number; sndDigits: string; pick: string; addr: string;
  elapsed: number; trackProg: number; sndRef: number; saga: string;
  txHash: string; ledger: number;
  pos: Record<string, Position>;
  vaultDigits: string; vaultPick: string;
  sign: Sign | null; signState: string;
  wallet: number;
  history: Entry[];
  walletMode: 'none' | 'demo' | 'freighter';
  pubkey: string | null;
  secretKey: string | null;
  connecting: boolean;
}

export interface Props { mxnPerUsd?: number; spread?: number }

export interface Ctl {
  state: AppState;
  props: Props;
  set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState> | null)) => void;
  rate: number; spread: number; minAmt: number; maxAmt: number;
  run: ReturnType<typeof setInterval>;
  trk: ReturnType<typeof setInterval>;
  refreshBalances: () => Promise<void>;
  connectDemo: () => Promise<void>;
  connectFreighter: () => Promise<void>;
  disconnect: () => void;
  [key: string]: any;
}
