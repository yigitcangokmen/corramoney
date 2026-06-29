# Corra: Test Strategy (Saga)

> If the saga is correct, the product is correct. The golden path is one test, and **every failure is its own test**. We said no silent failures, and the same holds in the tests. Types/flows: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), risks.

## 1. Levels (Pyramid)

| Level | What it tests | Speed | Doubles |
|---|---|---|---|
| **Unit** | pure functions: maxSend calculation, `Money` arithmetic, `isAllowedTransition` | ms | none |
| **Integration** | saga + ledger + adapter + gateway together (state flow) | s | `MockAdapter`, `FakeStellarGateway`, Postgres (testcontainers) |
| **E2E** | real testnet path payment (single happy path) | min | real Horizon + seeded MM |

Most tests are at the **integration** level, because the value of the saga lies in how the components behave together. Unit tests provide fast assurance, and E2E provides proof that it works "for real on chain" (nightly/manual).

## 2. Test Doubles (Determinism)

- **`FakeStellarGateway`**: returns a programmable result for `payStrictReceive` (SUCCESS / `op_over_sendmax` / `op_no_trust`). Keeps balances in memory, so conservation of value can be asserted.
- **`MockAdapter`**: deposit/withdraw events are **triggered by the test** (not automatic), so webhook timing can be controlled.
- **Injected clock**: `now()` is injected, so TTL/expiry can be tested deterministically.
- **Seeded MM**: a fixed offer set, so path finding is predictable.

> Rule: no test should depend on the real network, real time, or real ordering (except E2E).

## 3. Scenario Matrix

| # | Scenario | Level | flows | risks |
|---|---|---|---|---|
| T1 | **Golden path** | int + e2e | §1 | - |
| T2 | over-sendmax -> refund -> QUOTED | int | §2 | R2 |
| T3 | no route -> /quote 422 | int | §3 | R1 |
| T4 | webhook loss -> tick reconcile | int | §4 | R3 |
| T5 | duplicate webhook -> no-op | int | §4 | R3 |
| T6 | quote expired -> confirm 409 | unit+int | - | R6 |
| T7 | idempotent confirm -> single payment | int | - | R3 |
| T8 | double withdraw -> 409/no-op | int | - | R6 |
| T9 | illegal transition rejected | unit | - | - |
| T10 | recipient trustline preflight | int | §1 | R4 |

## 4. Scenarios (Given / When / Then)

**T1 - Golden path**
- *given* a quote was obtained, sender and recipient funded and with trustlines
- *when* confirm -> cash-in CONFIRMED -> path payment SUCCESS
- *then* state `CREDITED`; onchain leg `CONFIRMED` + txHash; recipient balance `+= dest`; events seq 1..n with no gaps; **conservation of value** (sender -source, recipient +dest).

**T2 - over-sendmax -> refund**
- *given* CASH_IN_CONFIRMED
- *when* gateway returns `op_over_sendmax`
- *then* `ONCHAIN_PENDING -> REFUNDING -> QUOTED`; sender balance **restored**; **no** balance at the hub; `reason` in the event.

**T3 - no route**
- *when* `findPathStrictReceive` returns empty
- *then* `/quote` -> **422**, payment **not created**, no balance changed.

**T4 - webhook loss -> tick**
- *given* stuck in CASH_IN_PENDING for >Xs, the webhook never arrived
- *when* `tick(paymentId)` -> `adapter.status = CONFIRMED`
- *then* state advanced (`CASH_IN_CONFIRMED`) without a webhook; the flow continued.

**T5 - duplicate webhook**
- *when* a webhook with the same `external_ref` arrives twice
- *then* a single `cash_in` leg; **no double credit**; `payment_events.seq` did not increment twice (`UNIQUE` conflict -> no-op).

**T6 - quote expired**
- *when* confirm after the TTL has passed
- *then* **409 QUOTE_EXPIRED**, no payment. (Server-side clock, do not trust the client.)

**T7 - idempotent confirm**
- *when* two confirms with the same `Idempotency-Key`
- *then* a **single** payment row; the second call returns the same payment.

**T8 - double withdraw**
- *when* withdraw twice on a CREDITED payment
- *then* a single `cash_out` leg (`UNIQUE(payment_id,'cash_out')`); the second is **409/no-op**.

**T9 - illegal transition**
- *when* e.g. `CREDITED -> ONCHAIN_PENDING` is attempted
- *then* rejected, state unchanged (guard).

**T10 - trustline preflight**
- *given* the recipient has no trustline for the dest asset
- *when* confirm
- *then* `ensureTrustline` is called **before** the path payment; if it fails, the payment fails cleanly without entering onchain (`op_no_trust` does not occur).

## 5. Invariant / Property Tests

Across random sequences of scenarios (fuzz), these must stay correct after every commit:
- **Conservation of value**: the total value in the system is constant (except mint/burn, which are also recorded).
- **Event monotonicity**: `seq` increases with no gaps; the timeline is complete.
- **Terminal immutability**: after `COMPLETED`/`FAILED`, the state never changes.
- **Single active leg**: at most one `PENDING` leg at any time.

## 6. CI
- **Every push:** unit + integration (testcontainers Postgres), within minutes.
- **Nightly / manual:** E2E testnet happy path (seed MM -> real path payment -> Horizon SUCCESS assert). Slow and network-dependent, does not block the main CI.
- Flaky E2E is not equal to a red building: E2E is a separate job with retries; integration must stay green.

Context: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), risks.
