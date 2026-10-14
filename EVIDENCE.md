# Evidence

One page that maps every deliverable of the Instawards SOW to something you can open. Every
transaction below is on Stellar **testnet** and was produced by the scripts in this repo between
2026-10-03 and 2026-10-14; re-running them produces a fresh set. Items still pending are marked as such.

Explorer links: `https://stellar.expert/explorer/testnet/tx/<hash>`.

## Infrastructure, disclosed

Team-controlled testnet accounts (created by `pnpm seed-testnet`, addresses in
[`packages/shared/src/testnet.ts`](packages/shared/src/testnet.ts)):

| Role | Account |
|---|---|
| Corridor issuer (TESTMXN, TESTPHP, TESTBRL, TESTARS, TESTIDR, TESTTHB) | `GDTNYFOB2EKTKIV3N4MG36R3ULZWT46C7HKCVJR7352BPCQJTG7EWIB6` |
| USDC issuer (test USDC, team-issued) | `GCI5EWQYTXAMLLOPSZKZM5HZFAE2QTLD4PSOOHA235YTR74AHJAWWGF4` |
| Market-maker (seeds every TEST*/USDC orderbook, 0.25% spread) | `GC3VT5OVLWMGAVVYTY6QGWT7OGFVOEY3X35RJCR6VFCBPAGLD7IAW2QU` |
| Anchor distribution (the test anchor's own account) | `GCBZMGCVXOMZPWHXCY3C7MNKTC6NQUZS5SPFQFCDTPAIEMI2KJ5CUKI4` |
| Fee-and-sponsor (one of the two Corra server keys, scope below) | `GCMOKBKDJFIHCFFC2DAHGH77IZTBJZVNCPO4UWQZLSTGEIIBWDGJLBF6` |
| Corra client_domain SIGNING_KEY (SEP-10 attribution) | `GAK5RUQY4LV24XPBKUKWJPBGACOW452APLUB7LKFGVOIAN7DMBT64QPN` |

Orderbooks seeded in `58fdde87fd03c017aa23617b654265fa132f7af9bc6919541ee7acb70ccdb10d`. The demo
proves routing and execution under a signed cap, not market depth or price discovery.

## Deliverable 1: asynchronous, non-custodial settlement

Script: `pnpm onchain-check` ([source](scripts/onchain-check.ts)), run 2026-10-14. Keypairs stand in for Freighter.

| Claim | Evidence |
|---|---|
| Sender and recipient created with **0 XLM**, reserves sponsored (CAP-33) | `8920ed4fafbf2605a924fba2ddf63aa624159275a783cb66a06bb879a47f7943`, `8c567a8702da6b9681fd56dac461429c08f973d766348f30974077762d858077` |
| Payment signed while the sender held **0 TESTMXN**: strict-receive, sendMax 334.2587992, 30-min maxTime, minSeqNum window of 100 (CAP-21), inner fee 0 | script output, step 2 |
| Cash-in credited, then confirmed from chain state | `2427c53ef59d91d95c16574e5f179477de1b3595a9755da3b7920d35a43df0d9` |
| The pre-signed blob submitted, fee paid by the sponsor's fee-bump (CAP-15): TESTMXN -> USDC -> TESTPHP, recipient receives exactly 1000 | `a2289a07e5056acb3c95f83a23a59a7b1a07f277c88bae9b331c0e4edf49b022` |
| Sender still holds 0 XLM after paying | script output, step 4 |
| The same flow in the app with a **real Freighter wallet** (2026-10-12, `CORRA-JA5X`): SEP-10 sign-in on connect, payment signed in Freighter, SEP-24 cash-in at the anchor, CREDITED 55 s after signing | anchor deposit `b7796f7ecfc5e6bcdead50815931aac46963f782636e79c0e998175c4d0bec01`, payment `471f44efecb541287c64ce86cbe89124ab43bd2c853f614eb1d3ce1494ddc02d`. Screen recording: **pending** |
| `no-server-side-signing` CI job | [`ci.yml`](.github/workflows/ci.yml), [`scripts/no-server-side-signing.ts`](scripts/no-server-side-signing.ts). Green run on `137c65e`: [CI run](https://github.com/yigitcangokmen/corramoney/actions/runs/38546949733), [the `no-server-side-signing` job](https://github.com/yigitcangokmen/corramoney/actions/runs/38546949733/job/115795238387) |

### Server signing scope

The orchestrator never loads, derives or signs with a user key. It holds two keys of its own: the
fee-and-sponsor account, confined to [`packages/stellar/src/sponsor.ts`](packages/stellar/src/sponsor.ts), and Corra's
client_domain `SIGNING_KEY` in [`client-domain.ts`](services/orchestrator/src/client-domain.ts). The CI job fails the build on any other
signing call site, on a seed-shaped string in server code, or if the fee-sponsor secret flows
anywhere but `createSponsor()`, and proves it fails on a violating fixture. Allowed signatures:

1. a CAP-15 fee-bump around a payment the sender already signed (refuses anything touching the sponsor account)
2. a CAP-33 sponsorship sandwich (begin, createAccount with 0 XLM, the sender's own changeTrust, end)
3. a SEP-10 client_domain co-signature on a sequence-0 challenge from the anchor

None can move user value. Each refusal is unit-tested.

## Deliverable 2: orchestrator and ledger

| Claim | Evidence |
|---|---|
| Automated `/confirm` -> CREDITED through the **hosted** HTTP API (`api.corra.money`), cash-in through **SDF Anchor Platform** at `anchor.corra.money` (SEP-10 with client_domain, SEP-24), triggered by the anchor's **signed callback** | `CASH_IN=anchor pnpm drive-payment` against production (2026-10-14, `CORRA-Z6E8W9`): anchor deposit `96efdee108c63163765c4a892d69923e6a40ecb9536555ad6c7e8243582d08b4`, payment `20cc119035acd05a8c362950b9bea6f46326780dc61ffe7cecf44120e659f555` |
| SEP-38: the anchor's firm quote, requested with the sender's own session, recorded by Corra unchanged, and the SEP-24 deposit opened against it (`quote_id` on the anchor's transaction) | same run: quote `9667eb21-3a9d-4e0c-af72-d5ab7f8408c1`; the deposit's hash memo ties it to exactly one payment |
| SEP-10 attribution: the anchor's JWT carries `client_domain=api.corra.money` | `pnpm anchor-check` against production (2026-10-14): deposit `27442f00f37e7e4e6d171d7a396ce36bce695771036f9ce31fcb490e8ac2bb16` |
| Cap exceeded: lands as a **failed** transaction carrying `op_over_source_max`, nothing moves, saga `CAP_EXCEEDED` | `9ee909db9404315895afad7e1fdec84bc1be081391e0735219fe143e90e922e6` |
| Timebound expiry: rejected with `tx_too_late`, never enters a ledger (so no hash, by design), saga `EXPIRED` | `onchain-check` step 5b; saga tests |
| Lost-callback recovery reconciled from chain state alone: nothing told the orchestrator about the deposit | `CASH_IN=lost pnpm drive-payment` against production (2026-10-14, `CORRA-V92XPK`): deposit `990503308304d0ad80118984f3573a755b881a344f1159a0cef2d374d2700adb` (carries the payment's hash memo), payment `608a40067168e676d1dc8306bdbcb66694e82622a9baa0494602dfd24f42ac18`. `GET https://api.corra.money/payments/CORRA-V92XPK` shows the `cash_out` leg acknowledged by the mock payout handler |
| PaymentSaga QUOTED -> SIGNED -> CASH_IN -> ONCHAIN -> CREDITED, terminal EXPIRED / CAP_EXCEEDED / FAILED, gapless append-only timeline, enforced by the database too (terminal guard, append-only trigger, one row per signed transaction) | [`transitions.ts`](packages/settlement-saga/src/transitions.ts), [`001_init.sql`](services/orchestrator/src/db/migrations/001_init.sql), [`002_hardening.sql`](services/orchestrator/src/db/migrations/002_hardening.sql) |
| Ledger stores no names, phones, bank details or KYC | [`001_init.sql`](services/orchestrator/src/db/migrations/001_init.sql) |
| Test report: happy path, cap exceeded, expiry, recovery, duplicate callback, idempotent confirm, unbound XDR, illegal transition, trustline preflight; Postgres row locking under concurrency; callback signature (missing, forged, tampered, stale) | `pnpm -r test`, see [docs/testing.md](docs/testing.md) for the matrix |

## Deliverable 3: demo, packaging, evidence

| Claim | Evidence |
|---|---|
| Live demo running the full lifecycle, every step linked to stellar.expert | [app.corra.money](https://app.corra.money), backed by `api.corra.money` and `anchor.corra.money`. Tested by hand with a real Freighter wallet on 2026-10-14 (`CORRA-SZ6YHD`, tab closed mid-payment and resumed from History): deposit `2ff01fb019eb49c747373387d8f146776323afc9488a3962c0ed1cc8c8c4d6dc`, payment `c28a36b8834fc2c9c69c936505d241d2356a30f11e315edd832617a8078c2f4c` |
| Extractable module | [`packages/settlement-saga`](packages/settlement-saga) |
| Quickstart proven by CI from a clean clone (Postgres, anchor, orchestrator, one payment to CREDITED) | [`quickstart.yml`](.github/workflows/quickstart.yml). Green run on `137c65e`: [Quickstart (testnet) run](https://github.com/yigitcangokmen/corramoney/actions/runs/38546949728) |
| Walkthrough video | **pending** |

## Notes on the evidence

- The `CAP_EXCEEDED` hash above comes from `pnpm onchain-check`, the Deliverable 1 mechanics
  script. It signs a payment with a sendMax that is too low and submits it, so the failed
  transaction on chain is real. That run does not go through the saga. The saga's own
  `ONCHAIN -> CAP_EXCEEDED` path is covered by unit tests (`T2 cap exceeded` in
  [`saga.test.ts`](packages/settlement-saga/src/saga.test.ts)).
- In the demo runs the gap between signing and cash-in is seconds (55 s end to end for
  `CORRA-JA5X`), because the test anchor's SPEI transfer is simulated. A real cash-in rail is
  slower; the 30-minute window and the re-sign path in [docs/risks.md](docs/risks.md) (R8) cover that.

## Deviations from the SOW wording

1. **The SEP-38 firm quote is requested by the browser, not by `/quote`.** A firm quote needs
   the sender's SEP-10 JWT, and Corra never holds user sessions server-side. So the browser
   requests it with the sender's own session
   ([`apps/web/src/logic/anchor.ts`](apps/web/src/logic/anchor.ts), `firmQuote`), and `/confirm`
   records its id and expiry on the payment unchanged.
2. **Cash-in runs against a self-hosted SDF Anchor Platform, not testanchor.stellar.org.** No
   third-party anchor can credit a token minted by our own testnet issuer, so the cash-in uses
   Anchor Platform 4.8.0 at `anchor.corra.money` ([`infra/anchor`](infra/anchor), [`deploy`](deploy)).
   The SOW itself allows this fallback.
3. **"The server has no signing path" is narrowed to what the protocol allows.** The server signs
   three bounded things: a CAP-15 fee-bump envelope, a CAP-33 sponsorship sandwich, and a SEP-10
   client_domain co-signature. None can move user value. This is enforced by the
   `no-server-side-signing` job and by unit-tested refusals. CAP-15 and CAP-33, which the SOW also
   requires, make a fee-source signature unavoidable.
4. **The hosted demo is app.corra.money, not test.corra.money.** test.corra.money stays up as the
   earlier demo. app.corra.money serves the app in this repo (`apps/web`).
5. **`op_over_sendmax` is reported as `op_over_source_max`.** The SOW names the refused-payment
   code `op_over_sendmax`. Horizon reports the protocol's
   `PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX` as **`op_over_source_max`**; that is the string you
   will see on stellar.expert and in the evidence above.
