export interface Position { amt: number; at: number; earned: number }

export interface Entry {
  kind: string; state: string; tone: number;
  inAmt: string; outAmt: string; earned?: string;
  when: string; tx: string;
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
}

export interface Props { tryPerUsd?: number; spread?: number }

export interface Ctl {
  state: AppState;
  props: Props;
  set: (patch: Partial<AppState> | ((s: AppState) => Partial<AppState> | null)) => void;
  rate: number; spread: number; minAmt: number; maxAmt: number;
  [key: string]: any;
}
