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

## 3. Anchor leg state (`packages/anchors`)

SEP-1/10/12/24/38 come from [`@stellar/typescript-wallet-sdk`](https://github.com/stellar/typescript-wallet-sdk) and we write no SEP client code; swapping a SEP-24 anchor is changing `homeDomain`.

**There is deliberately no anchor interface here.** v1 talks to one anchor, through the wallet SDK, using the SDK's own types. An `AnchorAdapter`-shaped abstraction with `capabilities()`, `getQuote()`, `initiateDeposit()` and `status()` is exactly the anchor abstraction this project commits not to write, and writing one before a second anchor exists would be inventing a seam to fit a future we have not met. If a ramp that implements no SEP ever has to be integrated, that is the moment to design the seam, with the real second case in hand.

The two types below are the saga's own internal state, not an anchor abstraction: a leg status the ledger stores, and the shape of a verified SEP-24 callback.

```ts
export type LegStatus = "PENDING" | "CONFIRMED" | "FAILED";

export type Sep24Callback = {
  ref: string;                // SEP-24 transaction id on the anchor side
  kind: "deposit" | "withdraw";
  status: LegStatus;
  at: number;
  raw: unknown;               // original payload (audit)
};
```

> SEP-31 is absent on purpose: its sending side requires a licensed entity with bilateral agreements, so a consumer app cannot implement it. SEP-24 is the wallet-side standard and is what the SDK drives.

## 4. Stellar Gateway (`packages/stellar`)

There is no `KeyStore` interface here, and that is the point: the orchestrator never signs with a user's key. The one server-side key it does hold, the fee-and-sponsor account, signs only fee-bump envelopes and `BeginSponsoringFutureReserves` and can move no user value. It builds an unsigned transaction and later submits one that was signed elsewhere.

```ts
export interface StellarGateway {
  /** Build only. Never signs. */
  buildStrictReceive(p: {
    from: string; to: string; dest: Money; sendMax: Money; path: AssetId[]; timeoutSec: number;
  }): Promise<{ xdr: string; sequence: string; expiresAt: number }>;

  /** Relay a transaction signed by the client. Rejects an unsigned or unexpected one. */
  submitSigned(p: { xdr: string; idemKey: string }): Promise<{ txHash: string }>;

  ensureAccount(accountId: string): Promise<void>;       // friendbot fund (testnet)
  ensureTrustline(accountId: string, asset: AssetId): Promise<void>; // sponsored reserve
  findPathStrictReceive(p: { source: string; dest: Money; sourceAssets: AssetId[] }): Promise<{ path: AssetId[]; estSource: Money }>;
  watchTx(txHash: string): Promise<{ status: "SUCCESS" | "FAILED" }>;
}
```

## 5. Saga (`services/orchestrator`)

```ts
export type PaymentState =
  | "QUOTED" | "SIGNED" | "CASH_IN"
  | "ONCHAIN" | "CREDITED"
  | "EXPIRED" | "CAP_EXCEEDED";   // CREDITED / EXPIRED / CAP_EXCEEDED are terminal

export type Leg = {
  kind: "cash_in" | "onchain" | "cash_out";
  anchorId?: string;
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
  confirm(quoteId: string, p: { sender: string; recipient: string; signedXdr: string }): Promise<Payment>; // -> SIGNED
  onCashIn(ev: Sep24Callback): Promise<void>;         // SEP-24 callback, after chain confirmation
  reconcile(paymentId: string): Promise<void>;        // advances from chain state; creates no new state
  resign(supersedesId: string, signedXdr: string): Promise<Payment>;  // new saga; never revives a terminal one
}
```

Allowed transitions and invariants are in [ledger](ledger.md). See also [architecture](architecture.md).
