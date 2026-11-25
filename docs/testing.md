# Corra: Test Strategy (Saga)

> If the saga is correct, the product is correct. The golden path is one test, and **every failure is its own test**. We said no silent failures, and the same holds in the tests. Types/flows: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), [risks](risks.md).

## 1. Levels

All unit and integration tests run with vitest through `pnpm -r test`; the scripts' pure helpers run with `node:test` through `pnpm test:scripts`. `pnpm test` runs both. On 2026-11-25 (Unit 6, delivery readiness) that was 770 tests (733 vitest, 37 script tests), all passing.

| Suite | Files | Tests | What it tests | Doubles |
|---|---|---|---|---|
| Saga | `packages/settlement-saga/src/saga.test.ts`, `deposits.test.ts`, `cash-out.test.ts` | 163 | the scenario matrix below, expiry, re-sign, supersede, CREDITED with a PENDING cash_out leg, balance payments, unbound deposits and their check cadence by age (at most 5 per pass, the one due longest first); the cash-out: record before submit, every refusal before any write, replay, one ref and one chain payment per leg, submit outcomes, the callback and chain join in either order, mismatches, anchor failures, the reconciler, the store's compare-and-set | `FakeGateway`, `InMemorySagaStore`, injected clock |
| Stellar | `packages/stellar/src/stellar.test.ts`, `pool.test.ts`, `wallet-fee-check.test.ts`, `channels.test.ts`, `setup-shape.test.ts` | 141 | `buildStrictReceive`, `assertBoundPayment`, sponsor key refusals, submit error classification, `findDeposit`, `paymentAccountOf` (stops at the first page with a match); the pool validator's 22 rules (each refusal by its message), the sponsor's fee-bump allowlist, the RPC submit over a fake RPC, and PS-live (the two blobs `pool-check` recorded on testnet); the cash-out payment builder, `assertCashOutPayment` (one test per rule), `cashOutFactsOf`, `sameMemo`, the sponsor's cash-out arm; the Varial fee-source rule over every shape the user signs; the channel leases (least recently used first, the 315 s TTL, early release once the channel's sequence moves, parking an unreadable channel, the synchronous reservation under concurrent acquires) and `createChannels` key refusals; a channel signs only a sponsored setup that creates an account (one test per refusal); the shared setup shape rules with a channel as transaction source | blobs built offline with blend-sdk (`packages/stellar/test/pool-fixtures.ts`); a fake RPC over `node:http` |
| Shared | `packages/shared/src/money.test.ts` | 10 | `Money` arithmetic, rounding, slippage, Stellar amount bounds | none |
| Orchestrator | `services/orchestrator/src/orchestrator.test.ts`, `config.test.ts`, `reconcile-loop.test.ts` | 113 | the HTTP API end to end, Postgres row locking and DB guards, callback signatures, client_domain co-signing, migrations, deposits, sends from the balance, `/pool/submit` (replay, resend after a failed send, duplicates without tokens, refusals, limits, reconcile, a five-way same-key race), `/payments/:id/cash-out/submit` (ref and tx-hash uniqueness, the CAS across two processes, limits, the withdrawal callback dispatch and parsing), `/setup` with a payment account and with channel accounts (concurrent setups on distinct channels, the sponsor-sourced fallback when all five are leased, no lease on a 429 or 409, a refusal frees the channel), the local-only setup limits (`CORRA_LOCAL_SETUP_LIMITS`, refused unless the anchor is on localhost), `app.close()` draining background work from `/send`, `/payments/:id/resign` and the withdrawal callback (also one that outlived its 503), a second `/resign` of one payment refused, the deposit cadence query on Postgres against the in-memory one, the database pool surviving a killed connection (idle and mid-query), the startup check of the sponsor key, the shutdown order (the reconcile loop halts before the server closes, its passes in flight finish before the pool ends) | a fake gateway and a scripted pool chain with the real sponsor; **a real Postgres** (`DATABASE_URL`, default `localhost:5434`). Runs may overlap on one Postgres: each uses its own `corra_test_<pid>` database, every app is closed (its background work drained) before the next test truncates, and a crashed run's database is dropped by the next run's sweep. Runs no longer need exclusive use of the database |
| Anchor business server | `services/anchor-business/src/server.test.ts` | 23 | the test anchor's JWT check, SEP-38 rate callback, simulated SPEI; the withdraw page, `/sep24/withdraw-confirm`, the payout matcher and poller, the more_info page | a fake Platform API and a fake chain |
| Web app | `apps/web/src/logic/*.test.ts` (11 files) | 283 | the send flow (`remit`), Add money (`deposit`), the pool flow (`pool`) and its chain reads and builder (`blend`), Cash out (`cashout`), signing, wallet state (the known payment account read directly, failed balance reads counted), view state (the Balance card's "Horizon is not answering" after 3 failed reads or 90 s), History, helpers, analytics (the participant tag or an explicit empty referrer, the five `track()` call sites by a source scan, nothing else leaves) | mocked Freighter, API and RPC |
| Scripts | `scripts/lib/*.test.ts` (7 files, `node:test`) | 37 | the evidence writer (phase, origin, token and seed redaction; an unset phase after the reset instant refused, a pre-reset source written after it reported; a seed in a URL path, after `+`, before `/` or `=` still caught; no script prints an anchor more_info_url with its token), the item model (source selection, the D1 one-sender group, the EVIDENCE.md block, the offline claim checks: the supplier signs the pool operation and it invokes the pool, the withdrawal pays from the recipient; also on the pre-reset source a post-reset primary keeps), the seed plan after a reset, the reset exit codes, `--wait-blend` without minutes refused (exit 1) and the Blend step (factory, backstop and oracle WASM), the release rules (one mutation per rule fails exactly that rule, including the `/backups` rsync exclude; no secret in the output), every app.ts route documented in api.md, the release checklist's count.js probe is a GET, the secret scan over shipped files, the ops-check stats-site verdict | temporary folders, synthetic keys |

The testnet scripts are not vitest suites. They run against the real Stellar testnet, with keypairs standing in for Freighter, and print every transaction hash:

| Script | What it proves |
|---|---|
| `pnpm onchain-check` | Deliverable 1 mechanics: sponsored 0-XLM setup, signing before cash-in, fee-bump, cap exceeded, expiry |
| `pnpm anchor-check` | the real cash-in: sponsored setup through the orchestrator, SEP-10 with Corra's client_domain, SEP-24 deposit at the Anchor Platform, signed callback |
| `pnpm drive-payment` | one payment through the orchestrator's HTTP API to `CREDITED` with its cash_out leg `PENDING`; `CASH_IN=lost` proves recovery without a callback; `--cash-out` then has the recipient cash out at the anchor (SEP-24 withdraw, one recipient-signed payment fee-bumped by Corra, the leg `CONFIRMED`), proves a refused blob and a replay, and writes `evidence/2026-12/pre-reset/d3/` |
| `pnpm anchor-trustline` | the anchor distribution account's TESTPHP trustline (prints `already trusted` when present) |
| `pnpm local:check` | on the local stack (`pnpm local:up`): health, CORS, the pool routes, the app's own Add money, pay-from-balance and pool code with a keypair for Freighter (setup, deposit 600, PHP 500 from the balance, 20 TESTMXN into the pool and back, History), a headless DOM smoke (not a layout or width check) |
| `pnpm deploy-pool` | D2 Plan A: Blend's mock oracle from its WASM hash, Corra's TESTMXN pool through Blend's factory (take rate 0, 2 positions, `c_factor = l_factor = 0`), status On-Ice; verifies it, extends TTLs and writes `packages/shared/src/testnet-blend.ts` and an evidence JSON. Refuses to replace a live recorded pool without `--redeploy`, and with it while that pool still holds deposits unless `--strand-deposits` |
| `pnpm pool-check` | the D2 go/no-go: a fresh 0-XLM account (sponsored setup, 50 TESTMXN) supplies 20 and withdraws all through `/pool/submit`, one user signature each, fee-bumped by Corra; checks the envelopes on Horizon, the position, replay, duplicate and three refusals; records the blobs for PS-live. `--verify-only` checks only the pool and its TTLs |
| `pnpm pool-ttl` | restores archived and extends short-lived pool, oracle and TESTMXN SAC entries and the position of every supplier in the `DATABASE_URL` database's `pool_ops` (default the local stack; production suppliers need a run against `corra-db`, [testnet-reset](testnet-reset.md#keeping-the-pool-alive)) (admin-paid) |
| `pnpm redeploy-after-reset` | the testnet rebuild after a reset: a read-only plan, or `--run` for the steps not done; proves afterwards which team accounts submitted anything and which generated files changed ([testnet-reset](testnet-reset.md)) |
| `pnpm ops-check` | a deployment ready for users, from outside: health, sponsor and channel XLM, the distribution account, offers and paths, the anchor's assets, the pool and its TTL, the demo recipient, the key files, stats |
| `pnpm release-check` | after `deploy/deploy.sh --render-only`: the release rules over the rendered files, PASS/FAIL only ([release-checklist](release-checklist.md)) |
| `pnpm archive-tx`, `pnpm evidence-index`, `pnpm evidence-app-run` | the evidence archive and index ([evidence/2026-12/README.md](../evidence/2026-12/README.md)) |

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

- **Every push to main and every PR** ([`ci.yml`](../.github/workflows/ci.yml)): `typecheck`; `test` (`pnpm -r test` with a Postgres 16 service container, then `pnpm test:scripts`); `no-server-side-signing` (the scanner, five fixture runs that must fail (1: a key load and signature; 2: Soroban auth signing, also as a bare or aliased named import, as an element-access call, and as a signer or Keypair taken as a value or destructured; 3: the channel secrets, `new Keypair`, a raw seed decode and raw signing imports; 4: key loaders taken as values (aliased, `.call`, destructured, element access, passed to `.map`), an environment read by a computed name, namespace and default `crypto` imports; 5: the channel and sponsor secrets handed off from the orchestrator config (destructured, by string, `Object.values(cfg)`), the `Channels` signer and its `signSetup`/`acquire` used outside `services/orchestrator/src/setup.ts`, and re-exports of `Keypair`, `sign` and `createChannels`, and a call through a computed property `ch[k]()`), the `@corra/stellar` tests, then the pool scope and channel key refusals by file); `build` (web and landing). `typecheck` also fails unless the lockfile holds one `@stellar/stellar-sdk` version (17.4.0).
- **Push to main, nightly and on demand** ([`quickstart.yml`](../.github/workflows/quickstart.yml)): from a clean clone, Postgres, `seed-testnet`, `onchain-check`, the Anchor Platform stack, `create-channels`, a throwaway pool (`deploy-pool --redeploy --strand-deposits`), the orchestrator, `anchor-check`, `drive-payment` to `CREDITED`, `drive-payment --cash-out`, `balance-check`, `pool-check` and `concurrent-setups`. It hits the real testnet, so it does not run on PRs.

Context: [contracts](contracts.md), [flows](flows.md), [ledger](ledger.md), risks.
