# Corra Contracts (TS interface/type draft)

> Not code, a contract. When the code repo is opened, it is ported one-to-one to `packages/shared` + `packages/anchor-adapters` + `packages/stellar`. Goal: clarify the type boundaries that isolate the core (saga + ledger) from the anchors and the chain.

## 1. Money and assets (`packages/shared`)

No floats. Money is always an integer minor-unit (Stellar 7 decimals = "stroop-like") + asset.

```ts
/** Stellar asset. If there is no issuer, native XLM. */
export type AssetId = {
  code: string;            // "USDC", "TEST_MXN", "TEST_PHP", "XLM"
  issuer?: string;         // G... (undefined for native)
};

/** Branded integer money. raw = in the asset's smallest unit (7 decimals). */
export type Money = {
  readonly asset: AssetId;
  readonly raw: bigint;    // 1.0 USDC = 10_000_000n
};

export const DECIMALS = 7;
export const fromDecimal = (asset: AssetId, d: string): Money => ({
  asset, raw: parseUnits(d, DECIMALS),         // "3500.00" -> 35000000000n
});
export const toDecimal = (m: Money): string => formatUnits(m.raw, DECIMALS);

/** Same asset required. Adding different assets is a runtime error, not compile-time. */
export const add = (a: Money, b: Money): Money => {
  assertSameAsset(a.asset, b.asset);
  return { asset: a.asset, raw: a.raw + b.raw };
};
```

```ts
export type CountryFiat = { country: string; currency: string }; // { "MX","MXN" }
export type Corridor = { from: CountryFiat; to: CountryFiat };

/** PoC testnet asset registry. Single source of truth. */
export const ASSETS = {
  USDC:     { code: "USDC",     issuer: "G_USDC_TESTNET" },
  TEST_MXN: { code: "TEST_MXN", issuer: "G_CORRA_ISSUER" },
  TEST_PHP: { code: "TEST_PHP", issuer: "G_CORRA_ISSUER" },
} satisfies Record<string, AssetId>;
```

## 2. Quote (`packages/shared`)

```ts
export type QuoteRequest = {
  corridor: Corridor;
  /** strict-receive: the amount the recipient WILL RECEIVE is fixed. */
  destAmount: Money;          // e.g. ₱11,210
};

export type Quote = {
  id: string;                 // qt_...
  mode: "strict_receive";
  corridor: Corridor;
  source: Money;              // what the sender will pay (estimated)
  dest: Money;                // what the recipient will receive (guaranteed)
  path: AssetId[];            // [TEST_MXN, USDC, TEST_PHP]
  maxSend: Money;             // source * (1 + slippageBps), on-chain max-send ceiling
  slippageBps: number;        // 150 = 1.5%
  expiresAt: number;          // epoch ms, TTL 30s
};
```

## 3. Anchor Adapter (`packages/anchor-adapters`) ★ moat

```ts
export type LegStatus = "PENDING" | "CONFIRMED" | "FAILED";

export type AdapterCapabilities = {
  onramp: boolean;
  offramp: boolean;
  assets: AssetId[];
  corridors: Corridor[];
  kyc: "none" | "anchor" | "corra";
};

export type DepositRequest  = { account: string; asset: AssetId; amount: Money; idemKey: string };
export type WithdrawRequest = { account: string; asset: AssetId; amount: Money; payout: unknown; idemKey: string };

export type NormalizedEvent = {
  ref: string;                // leg reference on the adapter side
  kind: "deposit" | "withdraw";
  status: LegStatus;
  at: number;
  raw: unknown;               // original payload (audit)
};

export interface AnchorAdapter {
  readonly id: string;                                   // "mock" | "moneygram" | "etherfuse"
  capabilities(): AdapterCapabilities;
  getQuote(req: QuoteRequest): Promise<Quote>;
  initiateDeposit(req: DepositRequest): Promise<{ ref: string; interactiveUrl?: string; instructions?: unknown }>;
  initiateWithdraw(req: WithdrawRequest): Promise<{ ref: string; payoutDetails: unknown }>;
  status(ref: string): Promise<LegStatus>;
  parseEvent(payload: unknown): NormalizedEvent;         // webhook/poll -> single normalized type
}
```

> The core only knows about `AnchorAdapter`; the SEP-24/SEP-31/Etherfuse-REST differences stay in the implementation. New anchor = new file.

## 4. Stellar Gateway + KeyStore (`packages/stellar`)

```ts
/** Custody abstraction. Now custodial-testnet, later non-custodial/KMS with the same interface. */
export interface KeyStore {
  create(): Promise<{ accountId: string }>;              // generate keypair + store
  sign(accountId: string, xdr: string): Promise<string>; // returns signed XDR
}

export interface StellarGateway {
  ensureAccount(accountId: string): Promise<void>;       // friendbot fund (testnet)
  ensureTrustline(accountId: string, asset: AssetId): Promise<void>; // sponsored reserve
  findPathStrictReceive(p: { source: string; dest: Money; sourceAssets: AssetId[] }): Promise<{ path: AssetId[]; estSource: Money }>;
  payStrictReceive(p: {
    from: string; to: string; dest: Money; sendMax: Money; path: AssetId[]; idemKey: string;
  }): Promise<{ txHash: string }>;
  watchTx(txHash: string): Promise<{ status: "SUCCESS" | "FAILED" }>;
}
```

## 5. Saga (`services/orchestrator`)

```ts
export type PaymentState =
  | "QUOTED" | "CASH_IN_PENDING" | "CASH_IN_CONFIRMED"
  | "ONCHAIN_PENDING" | "CREDITED"
  | "WITHDRAW_PENDING" | "COMPLETED"
  | "REFUNDING" | "FAILED";

export type Leg = {
  kind: "cash_in" | "onchain" | "cash_out";
  adapterId?: string;
  externalRef?: string;
  txHash?: string;
  status: LegStatus;
  amount: Money;
};

export type Payment = {
  id: string;                 // pmt_...
  publicId: string;           // short id shown to the user
  senderAccount: string;
  recipientAccount: string;
  corridor: Corridor;
  quote: Quote;
  state: PaymentState;
  legs: Leg[];
  idemKey: string;            // idempotency for the whole payment
  createdAt: number;
  updatedAt: number;
};

/** Orchestrator external surface. API + event + reconcile go through these three gates. */
export interface PaymentSaga {
  quote(req: QuoteRequest): Promise<Quote>;
  confirm(quoteId: string, p: { sender: string; recipient: string }): Promise<Payment>; // starts QUOTED
  onEvent(ev: NormalizedEvent): Promise<void>;        // anchor webhook -> advance state
  tick(paymentId: string): Promise<void>;             // reconcile/poll fallback (against webhook loss)
  withdraw(paymentId: string): Promise<void>;         // CREDITED -> WITHDRAW_PENDING (optional)
}
```

Allowed transitions and invariants are in [ledger](ledger.md). See also [architecture](architecture.md).
