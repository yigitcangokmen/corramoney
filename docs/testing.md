# Corra: Test Strategy (Saga)

> If the saga is correct, the product is correct. The golden path is one test, and **every failure is its own test**. We said no silent failures, and the same holds in the tests. Types/flows: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), [risks](risks.md).

## 1. Levels

All unit and integration tests run with vitest through `pnpm -r test`. On 2026-10-14 that ran 208 tests, all passing.

| Suite | Files | Tests | What it tests | Doubles |
|---|---|---|---|---|
| Saga | `packages/settlement-saga/src/saga.test.ts` | 39 | the scenario matrix below, expiry, re-sign, supersede, payout acknowledgement | `FakeGateway`, `InMemorySagaStore`, injected clock |
| Stellar | `packages/stellar/src/stellar.test.ts` | 22 | `buildStrictReceive`, `assertBoundPayment`, sponsor key refusals, submit error classification, `findDeposit` | none for the build and validate checks |
| Shared | `packages/shared/src/money.test.ts` | 10 | `Money` arithmetic, rounding, slippage, Stellar amount bounds | none |
| Orchestrator | `services/orchestrator/src/orchestrator.test.ts` | 18 | the HTTP API end to end, Postgres row locking and DB guards, callback signatures, client_domain co-signing, migrations | a fake gateway; **a real Postgres** (`DATABASE_URL`, default `localhost:5434`) |
| Anchor business server | `services/anchor-business/src/server.test.ts` | 6 | the test anchor's JWT check, SEP-38 rate callback, simulated SPEI | none |
| Web app | `apps/web/src/logic/*.test.ts` (6 files) | 113 | the send flow (`remit`), signing, wallet state, view state, helpers | mocked Freighter and API |

The testnet scripts are not vitest suites. They run against the real Stellar testnet, with keypairs standing in for Freighter, and print every transaction hash:

| Script | What it proves |
|---|---|
| `pnpm onchain-check` | Deliverable 1 mechanics: sponsored 0-XLM setup, signing before cash-in, fee-bump, cap exceeded, expiry |
| `pnpm anchor-check` | the real cash-in: sponsored setup through the orchestrator, SEP-10 with Corra's client_domain, SEP-24 deposit at the Anchor Platform, signed callback |
| `pnpm drive-payment` | one payment through the orchestrator's HTTP API to `CREDITED`; `CASH_IN=lost` proves recovery without a callback |

## 2. Test Doubles (Determinism)

- **`FakeGateway`** (in `saga.test.ts`, and a smaller one in `orchestrator.test.ts`): implements `StellarGateway` in memory. The test programs path results, deposits, submit outcomes (success, `op_over_source_max`, other failures, `bad_seq`, expired) and what Horizon reports for a transaction hash.
- **Real signed XDRs**: the saga tests build and sign real strict-receive transactions with `buildStrictReceive`, so `assertBoundPayment` runs on the real thing.
- **Injected clock**: `now()` is injected, so TTL and expiry are tested deterministically.
- **No fake anchor**: the saga is driven by calling `onCashIn` and `reconcile` directly, with deposits placed in the fake gateway. The real anchor is exercised only by the testnet scripts.

> Rule: no vitest test depends on the real network or real time. Only the testnet scripts do.

## 3. Scenario Matrix

| # | Scenario | Level | flows | risks |
|---|---|---|---|---|
| T1 | **Golden path** | saga + API + testnet | §1 | - |
| T2 | over-sendmax -> CAP_EXCEEDED (terminal) | int | §2 | R2 |
| T3 | no route -> /quote 422 | int | §3 | R1 |
| T4 | callback loss -> tick reconcile | int | §4 | R3 |
| T5 | duplicate callback -> no-op | int | §4 | R3 |
| T6 | quote expired -> confirm 409 | unit+int | - | R6 |
| T7 | idempotent confirm -> single payment | int | - | R3 |
| T8 | unbound XDR on confirm -> 422 | int | - | R2 |
| T9 | illegal transition rejected | unit | - | - |
| T10 | recipient trustline preflight | int | §1 | R4 |

## 4. Scenarios (Given / When / Then)

**T1 - Golden path**
- *given* a quote was obtained, sender and recipient funded and with trustlines
- *when* confirm -> cash-in CONFIRMED -> path payment SUCCESS
- *then* state `CREDITED`; onchain leg `CONFIRMED` + txHash; the signed blob is deleted; events seq 1..5 with no gaps. The recipient's balance is checked on chain by `onchain-check` and `drive-payment`, not by the unit test.

**T2 - over-sendmax -> CAP_EXCEEDED**
- *given* CASH_IN
- *when* gateway returns `op_over_source_max`
- *then* `ONCHAIN -> CAP_EXCEEDED` (terminal); onchain leg `FAILED` with the failed tx hash; the signed blob is deleted; a retry creates a new saga with `supersedesId` set and the old one stays `CAP_EXCEEDED`. That the failed tx lands in a ledger and nothing moves is shown on testnet by `onchain-check`.

**T3 - no route**
- *when* `findPathStrictReceive` returns empty
- *then* `/quote` -> **422**, payment **not created**, no balance changed.

**T4 - callback loss -> reconcile**
- *given* stuck in SIGNED for >Xs, the anchor callback never arrived
- *when* `reconcile(paymentId)` finds the deposit on chain (by the payment's memo, from the anchor's distribution account)
- *then* the reconciler confirmed the deposit from chain state and advanced to `CASH_IN` without a callback; the flow continued.

**T5 - duplicate callback**
- *when* a callback with the same `external_ref` arrives twice
- *then* a single `cash_in` leg; **no double credit**; `payment_events.seq` did not increment twice (`UNIQUE` conflict -> no-op).

**T6 - quote expired**
- *when* confirm after the TTL has passed
- *then* **409 QUOTE_EXPIRED**, no payment. (Server-side clock, do not trust the client.)

**T7 - idempotent confirm**
- *when* two confirms with the same `Idempotency-Key`
- *then* a **single** payment row; the second call returns the same payment.

**T8 - unbound transaction on confirm**
- *given* a valid quote
- *when* `/confirm` receives a signed XDR whose destination, destination asset, destination amount or `sendMax` does not match that quote
- *then* **422 `UNBOUND_TRANSACTION`**, no payment row created. The orchestrator refuses a blob it cannot fully account for, which is what makes "it can only submit or not submit" true.

**T9 - illegal transition**
- *when* e.g. `CREDITED -> ONCHAIN` is attempted
- *then* rejected, state unchanged (guard).

**T10 - trustline preflight**
- *given* the recipient has no trustline for the dest asset
- *when* confirm
- *then* **422 `RECIPIENT_NO_TRUSTLINE`**, no payment row created, nothing submitted (`op_no_trust` does not occur). Trustlines are opened beforehand by the sponsored setup (`/setup`).

## 5. Invariants

There are no property or fuzz tests. These invariants are asserted by specific tests:
- **Event monotonicity**: `seq` increases with no gaps (T1 in the saga and orchestrator suites).
- **Terminal immutability**: after `CREDITED`, `EXPIRED`, `CAP_EXCEEDED` or `FAILED`, the state never changes. Checked by the transition guard (T9) and by the database trigger test (`the database refuses to reopen a terminal payment or rewrite the timeline`).
- **One row per signed transaction**: one signed transaction can never back two payments (saga and Postgres tests).
- **Concurrency**: concurrent transitions from the same state, exactly one wins, no duplicate events (Postgres test).

## 6. CI

- **Every push to main and every PR** ([`ci.yml`](../.github/workflows/ci.yml)): `typecheck`; `test` (`pnpm -r test` with a Postgres 16 service container); `no-server-side-signing` (the scanner, a fixture run that must fail, then the `@corra/stellar` tests); `build` (web and landing).
- **Push to main, nightly and on demand** ([`quickstart.yml`](../.github/workflows/quickstart.yml)): from a clean clone, Postgres, `seed-testnet`, `onchain-check`, the Anchor Platform stack, the orchestrator, `anchor-check`, then `drive-payment` to `CREDITED`. It hits the real testnet, so it does not run on PRs.

Context: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), risks.
