# Corra Contracts (TS interface/type draft)

> The type boundaries as they are in the code: `packages/shared` (types), `packages/stellar` (gateway, sponsor), `packages/settlement-saga` (saga, store). Sections 4 and 5 are copied from the source; sections 1 to 3 are a simplified view of `packages/shared`. Goal: clarify the type boundaries that isolate the core (saga + ledger) from the anchors and the chain.

## 1. Money and assets (`packages/shared`)

No floats. Money is always an integer minor-unit (Stellar 7 decimals = "stroop-like") + asset.

```ts
/** Stellar asset. If there is no issuer, native XLM. */
export type AssetId = {
  code: string;            // "USDC", "TESTMXN", "TESTPHP", "XLM"
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
  TESTMXN: { code: "TESTMXN", issuer: "G_CORRA_ISSUER" },
  TESTPHP: { code: "TESTPHP", issuer: "G_CORRA_ISSUER" },
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
  path: AssetId[];            // [TESTMXN, USDC, TESTPHP]
  maxSend: Money;             // source * (1 + slippageBps), on-chain max-send ceiling
  slippageBps: number;        // 150 = 1.5%
  expiresAt: number;          // epoch ms, TTL 2 min
};
```

## 3. Anchor leg state (`packages/shared`)

SEP-1/10/24/38 come from [`@stellar/typescript-wallet-sdk`](https://github.com/stellar/typescript-wallet-sdk) and we write no SEP client code; swapping a SEP-24 anchor is changing `homeDomain`.

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

There is no `KeyStore` interface here, and that is the point: the orchestrator never signs with a user's key and never builds the payment. The browser builds and signs it (`buildStrictReceive`, exported from `packages/stellar`); the saga checks the signed XDR against the quote (`assertBoundPayment`) and later submits it. The server's own two keys, the fee-and-sponsor account (`createSponsor`, fee-bumps and sponsorship setups only) and the SEP-10 client_domain key (`services/orchestrator/src/client-domain.ts`), can move no user value.

```ts
export type PathResult = { path: AssetId[]; source: Money };
export type Deposit = { hash: string; amount: Money; at: number };

/** Everything the saga needs from the chain. A fake implements this in tests. */
export interface StellarGateway {
  findStrictReceivePath(p: { sourceAsset: AssetId; dest: Money }): Promise<PathResult | null>;
  /** Fee-bumps a sender-signed payment and submits it. */
  submitPayment(signedInnerXdr: string): Promise<SubmitOutcome>;
  /** Looks up a transaction by its inner hash. `hash` is the fee-bump envelope's hash when there is one. */
  getTransaction(hash: string): Promise<{ status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND'; ledger?: number; codes?: string; hash?: string }>;
  /** Credit of `asset` from `from` to `account` at or after `since` (ms), matched by memo. */
  findDeposit(p: { account: string; from: string; asset: AssetId; since: number; memo?: string }): Promise<Deposit | null>;
  accountTrusts(account: string, asset: AssetId): Promise<boolean>;
  accountSequence(account: string): Promise<bigint | null>;
}

export type SubmitOutcome =
  | { kind: 'success'; hash: string; ledger: number }
  | { kind: 'cap_exceeded'; hash?: string; codes: unknown }   // landed failed, nothing moved
  | { kind: 'expired'; codes: unknown }                       // never entered a ledger
  | { kind: 'bad_seq'; codes: unknown }
  | { kind: 'failed'; hash?: string; codes: unknown };
```

## 5. Saga (`packages/settlement-saga`)

```ts
export type PaymentState =
  | 'QUOTED' | 'SIGNED' | 'CASH_IN'
  | 'ONCHAIN' | 'CREDITED'
  | 'EXPIRED' | 'CAP_EXCEEDED' | 'FAILED';   // CREDITED / EXPIRED / CAP_EXCEEDED / FAILED are terminal

export type Leg = {
  kind: 'cash_in' | 'onchain' | 'cash_out';
  anchorId?: string;
  externalRef?: string;
  txHash?: string;
  status: LegStatus;
  amount: Money;
};

export type Payment = {
  id: string;                 // pmt_...
  publicId: string;           // CORRA-XXXXXX, shown to the user
  senderAccount: string;
  recipientAccount: string;
  corridor: Corridor;
  quote: Quote;               // carries anchorQuoteId / anchorQuoteExpiresAt when recorded
  state: PaymentState;
  legs: Leg[];
  idemKey: string;
  signedXdr: string | null;   // deleted once the payment is terminal
  innerTxHash: string;
  maxTime: number;            // unix seconds, the timebound the sender signed
  supersedesId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AnchorQuote = { id: string; expiresAt: number };

/** The cash-out leg. In Phase 1 it is createMockPayout(), which acknowledges without moving anything. */
export type PayoutHandler = { acknowledge(p: Payment): Promise<{ ref: string }> };

export type SagaDeps = {
  store: SagaStore;
  gateway: StellarGateway;
  networkPassphrase: string;
  corridorIssuer: string;      // issuer of the corridor test assets
  anchorDistribution: string;  // account the anchor pays cash-in deposits from
  anchorId: string;
  /** Optional server-side SEP-38 hook. The orchestrator does not set it: the browser requests the firm quote. */
  anchorQuote?: (q: { source: Quote['source']; dest: Quote['dest'] }) => Promise<AnchorQuote | null>;
  payout?: PayoutHandler;      // defaults to createMockPayout()
  now?: () => number;
  newId?: (prefix: string) => string;
  slippageBps?: number;        // default 150
  quoteTtlMs?: number;         // default 120_000
};

export type ConfirmInput = {
  sender: string;
  recipient: string;
  signedXdr: string;
  idemKey: string;
  anchorQuote?: AnchorQuote;   // the anchor's SEP-38 firm quote, recorded unchanged
};

/** createSaga(deps) returns: */
type Saga = {
  quote(req: QuoteRequest): Promise<Quote>;
  confirm(quoteId: string, input: ConfirmInput): Promise<Payment>;                  // -> SIGNED
  resign(supersedesId: string, quoteId: string, signedXdr: string, idemKey: string,
         anchorQuote?: AnchorQuote): Promise<Payment>;                             // new saga; never revives a terminal one
  linkCashIn(paymentId: string, ref: string): Promise<void>;                        // SEP-24 transaction id, write-once
  onCashIn(ev: Sep24Callback): Promise<Payment | null>;                             // a trigger; advances from chain state
  reconcile(paymentId: string): Promise<Payment>;                                   // advances from chain state; creates no new state
  reconcileAll(idleMs?: number): Promise<number>;                                   // every pending payment idle for idleMs
  getPayment(id: string): Promise<Payment>;                                         // internal id or public id
  findByIdemKey(idemKey: string): Promise<Payment | null>;
  events(id: string): Promise<PaymentEvent[]>;
  isTerminal(state: PaymentState): boolean;
};
```

`SagaStore` (in `store.ts`) is the persistence the saga needs. Its `transition()` must be atomic: apply only if the payment is still in `from`, upsert legs, append the next event. `InMemorySagaStore` ships with the package; the orchestrator's `PostgresSagaStore` is the production one.

Allowed transitions and invariants are in [ledger](ledger.md). See also [architecture](architecture.md).
