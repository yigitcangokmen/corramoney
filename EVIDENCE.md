# Evidence

One page that maps every deliverable of both Instawards SOWs to something you can open: the first
SOW (asynchronous non-custodial settlement, orchestrator and ledger, demo) in the sections below, and the
second SOW (balance and send-from-balance, Corra's Blend pool, the recipient's cash-out and channel
accounts) in the generated [month-2 block](#month-2-balance-blend-pool-cash-out-second-sow) at the end.
Every transaction is on Stellar **testnet** and was produced by the scripts in this repo (month 1 between
2026-10-03 and 2026-10-14); re-running them produces a fresh set. Every cited transaction is also archived
as raw JSON under `evidence/` (month 1 in `evidence/2026-10/tx/`), because a testnet reset deletes the
history the links open. Items still pending are marked as such.

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
| The same flow in the app with a **real Freighter wallet** (2026-10-12, `CORRA-JA5X`): SEP-10 sign-in on connect, payment signed in Freighter, SEP-24 cash-in at the anchor, CREDITED 55 s after signing | anchor deposit `b7796f7ecfc5e6bcdead50815931aac46963f782636e79c0e998175c4d0bec01`, payment `471f44efecb541287c64ce86cbe89124ab43bd2c853f614eb1d3ce1494ddc02d`. Screen recording: submitted to the Chapter Lead with the closeout form |
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
| Walkthrough video | Submitted to the Chapter Lead with the closeout form |

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

## Month 2: balance, Blend pool, cash-out (second SOW)

<!-- evidence-index:start -->

_Generated by `pnpm evidence-index` from `evidence/2026-12/`; edit `evidence/2026-12/manual.json`, not this block._

**Testnet reset.** SDF resets Stellar testnet on 2026-12-16 17:00 UTC. Every transaction cited before then is archived as Horizon JSON under `evidence/2026-12/pre-reset/tx/` (month 1 under `evidence/2026-10/tx/`), because the reset deletes the history the links open. The rebuild reuses every team key (`pnpm redeploy-after-reset`, [docs/testnet-reset.md](docs/testnet-reset.md)), so the addresses below stay; the pool gets new contract ids.

### Month-2 infrastructure, disclosed

| Role | Address |
|---|---|
| Channel account 1 (source of sponsored setups only) | `GCHPMPNRDH7KS7BOT6YTHUC3T5XIKLLTOS2WB5KX2OZQZT55GBAHKNLT` |
| Channel account 2 (source of sponsored setups only) | `GDB5L5IT34T24FJ2VVDP6LP7VR5EPGGX5Z6QFYK5LSAUIJUXNP2GD5GB` |
| Channel account 3 (source of sponsored setups only) | `GBD5AGFUZTFW53CXJ4KKLB4PKE3D3NW4XCCPYDWV54RPI6E6A4PQJLQK` |
| Channel account 4 (source of sponsored setups only) | `GAJWJUOQZG22KWO7GAACWRPXVROWXXSMW3I2XZKX5UL4ZHE7OWSIWNUH` |
| Channel account 5 (source of sponsored setups only) | `GASCQFX2EESUNB32OU6AQXTATLVTEUO2LCWKREJTMN4VL2WPUXOLUSOK` |
| Pool admin and oracle admin (team script key) | `GC6XADS7NYMJIATPMFP2SZMPERBOLP6AVJVYJPRUN3GM4OW4HDIMEFWX` |
| Oracle (Blend's mock-sep-40, unmodified) | [`CBFQSK4U76625W7GKZDMP47ATARCBA6F45EP65YGRQODQQ3GDSOG6NY5`](https://stellar.expert/explorer/testnet/contract/CBFQSK4U76625W7GKZDMP47ATARCBA6F45EP65YGRQODQQ3GDSOG6NY5) |
| Pool (Corra TESTMXN, On-Ice) | [`CAL5ZEAT7XIP5B7AAUJD6WOVG2W7YDIE27HNF7ABQIC3HBOC42TQFWHS`](https://stellar.expert/explorer/testnet/contract/CAL5ZEAT7XIP5B7AAUJD6WOVG2W7YDIE27HNF7ABQIC3HBOC42TQFWHS) |
| Blend pool factory | [`CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6`](https://stellar.expert/explorer/testnet/contract/CDV6RX4CGPCOKGTBFS52V3LMWQGZN3LCQTXF5RVPOOCG4XVMHXQ4NTF6) |
| Demo recipient (receives only; secret discarded) | `GBUUVSY5KBG5JNQNTHSF7L5KJ7VKJ732JOS3KJXUALBEQSLHX4MGJEKO` |

### Deliverable 1: balance and send-from-balance

| SOW item | Evidence | Archive |
|---|---|---|
| A deposit into a sender's own account that is not tied to any payment | [deposit 8710a9b9...eea7](https://stellar.expert/explorer/testnet/tx/8710a9b98013270085d077be00c9a9b63bd4ba92e8adccb1089658ce9150eea7); dep_9e104a9973f04bdf880faefacd022064, matched by ref, anchor ref 01dc7b39-7275-4db8-80a5-48c893aa5d4e; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx 8710a9b9](evidence/2026-12/pre-reset/tx/8710a9b98013270085d077be00c9a9b63bd4ba92e8adccb1089658ce9150eea7.json) |
| A send from that balance to the Philippines (TESTPHP) | [CORRA-Z6ZSVW 96a68729...9d4e](https://stellar.expert/explorer/testnet/tx/96a68729c59e63f28e0b0f5c6d431fae3da193affc3f83185159a5825c7a9d4e); ledger 5921381; 500.0000000 TESTPHP; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx 96a68729](evidence/2026-12/pre-reset/tx/96a68729c59e63f28e0b0f5c6d431fae3da193affc3f83185159a5825c7a9d4e.json) |
| A send from that balance to Brazil (TESTBRL) | [CORRA-2WDP6A 85c924c5...7891](https://stellar.expert/explorer/testnet/tx/85c924c573d3d63bf1f63b155cfae27e1f6f9e0f8ef9e1eb33bf00a6cbb17891); ledger 5921382; 50.0000000 TESTBRL; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx 85c924c5](evidence/2026-12/pre-reset/tx/85c924c573d3d63bf1f63b155cfae27e1f6f9e0f8ef9e1eb33bf00a6cbb17891.json) |
| A send from that balance to Argentina (TESTARS) | [CORRA-DTCQSR 64e265d5...755e](https://stellar.expert/explorer/testnet/tx/64e265d5aaa912be7b3dc71e6a03fca7175e1bd2d41d914849b6d372a295755e); ledger 5921383; 5000.0000000 TESTARS; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx 64e265d5](evidence/2026-12/pre-reset/tx/64e265d5aaa912be7b3dc71e6a03fca7175e1bd2d41d914849b6d372a295755e.json) |
| A send from that balance to Indonesia (TESTIDR) | [CORRA-BC8R6C a6bd8f3d...5e83](https://stellar.expert/explorer/testnet/tx/a6bd8f3dec51a96de89dd4fec65c1042a7496af274c07679bc4790fe96015e83); ledger 5921384; 100000.0000000 TESTIDR; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx a6bd8f3d](evidence/2026-12/pre-reset/tx/a6bd8f3dec51a96de89dd4fec65c1042a7496af274c07679bc4790fe96015e83.json) |
| A send from that balance to Thailand (TESTTHB) | [CORRA-8P9K29 6b67746e...9460](https://stellar.expert/explorer/testnet/tx/6b67746e13ba732989464d61efb9c7050aea34283b45e8e50c52e08f929c9460); ledger 5921385; 300.0000000 TESTTHB; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T18-16-10-100Z.json), [tx 6b67746e](evidence/2026-12/pre-reset/tx/6b67746e13ba732989464d61efb9c7050aea34283b45e8e50c52e08f929c9460.json) |
| The app's History showing the deposit linked to the anchor's transaction | [history-1440.png](evidence/2026-12/pre-reset/d1/history-1440.png); History tab on the local stack (headless Chrome, a keypair standing in for Freighter): a deposit with its anchor reference (b6b7fa95-95f0-4348-986c-56351c99d969, matched by ref), Anchor record and stellar.expert links, and a send from the balance. The account shown is GC7SCNH5VM73G5AHY5BGUMCCQOH3TQWC4JEC33LNYSUY3A25X3WDAWZO (app-run 2026-11-25T10-10-50), not the D1 sender above: balance-check discards its sender's secret, so that sender's History cannot be opened. A History screenshot for the D1 sender needs a run whose keys are kept (for example the post-reset app run); local stack, pre-reset | - |
| The same flow on https://app.corra.money | [app.corra.money](https://app.corra.money); deposit and 1 send(s) through https://app.corra.money; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/app/app-run-GCZYV4HH-2026-11-25T19-24-20-021Z.json) |

### Deliverable 2: Blend pool

| SOW item | Evidence | Archive |
|---|---|---|
| The pool contract on stellar.expert | ledger 5915524; [pool](https://stellar.expert/explorer/testnet/contract/CAL5ZEAT7XIP5B7AAUJD6WOVG2W7YDIE27HNF7ABQIC3HBOC42TQFWHS); verified: status 2, admin GC6XADS7NYMJIATPMFP2SZMPERBOLP6AVJVYJPRUN3GM4OW4HDIMEFWX; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-verify-2026-11-25T10-07-45-250Z.json) |
| A deposit into the pool, signed by the sender's account and fee-bumped | [fee-bump 2b7bb683...31ef](https://stellar.expert/explorer/testnet/tx/2b7bb683199b55e6d767dd3137b5207f213d65d7afb528bd1c281ea8166631ef); [inner bce89d67...4534](https://stellar.expert/explorer/testnet/tx/bce89d6779cc2f4bf54af8f12c28804c6517ac5513589dd221e1ebab90864534); ledger 5921097; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-check-2026-11-25T17-52-20-725Z.json), [tx 2b7bb683](evidence/2026-12/pre-reset/tx/2b7bb683199b55e6d767dd3137b5207f213d65d7afb528bd1c281ea8166631ef.json), [tx bce89d67](evidence/2026-12/pre-reset/tx/bce89d6779cc2f4bf54af8f12c28804c6517ac5513589dd221e1ebab90864534.json) |
| A withdrawal from the pool, signed by the sender's account and fee-bumped | [fee-bump 77818a9b...11f7](https://stellar.expert/explorer/testnet/tx/77818a9b44ca7dae9026ec7eac0c50bf07b331468397fe2e601982a454ee11f7); [inner cd7a6a80...1c80](https://stellar.expert/explorer/testnet/tx/cd7a6a804afa02e203a2b1c6acefefcf9a8553e65d4aef7187925a52081b1c80); ledger 5921099; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-check-2026-11-25T17-52-20-725Z.json), [tx 77818a9b](evidence/2026-12/pre-reset/tx/77818a9b44ca7dae9026ec7eac0c50bf07b331468397fe2e601982a454ee11f7.json), [tx cd7a6a80](evidence/2026-12/pre-reset/tx/cd7a6a804afa02e203a2b1c6acefefcf9a8553e65d4aef7187925a52081b1c80.json) |
| A screenshot of the position and the 0% rate with the On-Ice note | [poolcard-1440.png](evidence/2026-12/pre-reset/d2/poolcard-1440.png); [poolcard-390.png](evidence/2026-12/pre-reset/d2/poolcard-390.png); [poolcard-390-done.png](evidence/2026-12/pre-reset/d2/poolcard-390-done.png); Balance tab pool card on the local stack (headless Chrome, a keypair standing in for Freighter): position, 0.00% rate, On-Ice note; local stack, pre-reset | - |

### Deliverable 3: cash-out and channel accounts

| SOW item | Evidence | Archive |
|---|---|---|
| The recipient's withdrawal payment to the anchor's distribution account | [fee-bump 93ba8f2f...9fdb](https://stellar.expert/explorer/testnet/tx/93ba8f2fe1b2d52b77c2ef18d8d69847a8499a4eb01616e4bdefe3b12cd89fdb); [inner e7026393...a606](https://stellar.expert/explorer/testnet/tx/e702639322f62c794e3ad2b71595fd9673bde3a154306c79efdf0907b7e5a606); ledger 5921373; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d3/cash-out-2026-11-25T18-15-17-862Z.json), [tx 93ba8f2f](evidence/2026-12/pre-reset/tx/93ba8f2fe1b2d52b77c2ef18d8d69847a8499a4eb01616e4bdefe3b12cd89fdb.json), [tx e7026393](evidence/2026-12/pre-reset/tx/e702639322f62c794e3ad2b71595fd9673bde3a154306c79efdf0907b7e5a606.json) |
| The anchor's transaction page showing it completed | [more-info-da7cd59f-69e9-45f8-8982-c20f3224c039.html](evidence/2026-12/pre-reset/d3/more-info-da7cd59f-69e9-45f8-8982-c20f3224c039.html); anchor da7cd59f-69e9-45f8-8982-c20f3224c039 completed, payout sim-cash-pickup-da7cd59f; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d3/cash-out-2026-11-25T18-15-17-862Z.json) |
| Three sponsored setups in the same ledger, each with a different channel account as source | [setup 1 61ba6280...58c8](https://stellar.expert/explorer/testnet/tx/61ba6280ee2fae9aae4e1058146c167fbdc3f040a790f1e50c6f0d24eb5e58c8); [setup 2 8cb6a05a...1e51](https://stellar.expert/explorer/testnet/tx/8cb6a05a7d087b8704a587e816772d5433ed067250c92c4a4f007e724f041e51); [setup 3 66ebf8de...02fc](https://stellar.expert/explorer/testnet/tx/66ebf8de624db256a8309c2f3a63717cc22e36b736b6c189fc05f8f9257202fc); ledger 5921092; three setups in ledger 5921092; through api.corra.money, pre-reset | [run](evidence/2026-12/pre-reset/d3/concurrent-setups-2026-11-25T17-51-45-745Z.json), [tx 61ba6280](evidence/2026-12/pre-reset/tx/61ba6280ee2fae9aae4e1058146c167fbdc3f040a790f1e50c6f0d24eb5e58c8.json), [tx 8cb6a05a](evidence/2026-12/pre-reset/tx/8cb6a05a7d087b8704a587e816772d5433ed067250c92c4a4f007e724f041e51.json), [tx 66ebf8de](evidence/2026-12/pre-reset/tx/66ebf8de624db256a8309c2f3a63717cc22e36b736b6c189fc05f8f9257202fc.json) |
| A green run of the extended no-server-side-signing job | [CI run (no-server-side-signing job, 6958010)](https://github.com/yigitcangokmen/corramoney/actions/runs/45650434237); [Quickstart run (testnet, 6958010)](https://github.com/yigitcangokmen/corramoney/actions/runs/45650434130); Green CI and Quickstart on main at 6958010, the month-2 release commit set; other host, pre-reset | - |

### Walkthrough video

| SOW item | Evidence | Archive |
|---|---|---|
| One walkthrough video covering all three deliverables | pending (builder) | - |

### Deviations and honesty notes

- Every payment and pool transaction has the sender's 0-XLM payment account as its transaction source; the sender is the operation source and the only signer, and Corra's sponsor pays the fee by fee-bump. Why: Freighter's fee check warns when the signer is also the fee source, and skips it when it is not (Varial, `docs/risks.md` R18).
- The pool admin and oracle admin is a team script key. The admin cannot move or lock anyone's deposit without a week of on-chain notice; withdrawals work in every pool state. Supply and withdraw never read the oracle price (`docs/risks.md` R22).
- The anchor's transaction page link carries a session token, so it is never published: the page is shown by a saved copy of its HTML with the token removed (screenshot pending).
- Not done yet: video.

<!-- evidence-index:end -->
