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
| A deposit into a sender's own account that is not tied to any payment | [deposit 67d563b9...fb11](https://stellar.expert/explorer/testnet/tx/67d563b9407cd74a0741acca4ead74678de588bfcdb3994092ec34c3c4c2fb11); dep_a927c193fa1a402899a0e35107975585, matched by ref, anchor ref 5ff23f7a-58e0-4b46-bca3-08ec527f3609; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx 67d563b9](evidence/2026-12/pre-reset/tx/67d563b9407cd74a0741acca4ead74678de588bfcdb3994092ec34c3c4c2fb11.json) |
| A send from that balance to the Philippines (TESTPHP) | [CORRA-9QTT9K b6aa736e...a2ab](https://stellar.expert/explorer/testnet/tx/b6aa736e296305be72e7b22f162e2764316fb6a2be9f1854a967aa79e319a2ab); ledger 5915454; 500.0000000 TESTPHP; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx b6aa736e](evidence/2026-12/pre-reset/tx/b6aa736e296305be72e7b22f162e2764316fb6a2be9f1854a967aa79e319a2ab.json) |
| A send from that balance to Brazil (TESTBRL) | [CORRA-KKNBQ3 e65947b7...b6be](https://stellar.expert/explorer/testnet/tx/e65947b746b55e3745283f2f112d0ac740b44b5a8c204a753d5afe8fc4efb6be); ledger 5915456; 50.0000000 TESTBRL; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx e65947b7](evidence/2026-12/pre-reset/tx/e65947b746b55e3745283f2f112d0ac740b44b5a8c204a753d5afe8fc4efb6be.json) |
| A send from that balance to Argentina (TESTARS) | [CORRA-UWRJSY 27c12eba...178a](https://stellar.expert/explorer/testnet/tx/27c12ebaabc5c1ab29a5518effd7e7003da0ac5b356cf57fc33e2f61d146178a); ledger 5915457; 5000.0000000 TESTARS; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx 27c12eba](evidence/2026-12/pre-reset/tx/27c12ebaabc5c1ab29a5518effd7e7003da0ac5b356cf57fc33e2f61d146178a.json) |
| A send from that balance to Indonesia (TESTIDR) | [CORRA-U94KJY a6ece478...0bca](https://stellar.expert/explorer/testnet/tx/a6ece47878f321a45ab7b142e22b406595b1f69aa09578980c7709335a390bca); ledger 5915459; 100000.0000000 TESTIDR; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx a6ece478](evidence/2026-12/pre-reset/tx/a6ece47878f321a45ab7b142e22b406595b1f69aa09578980c7709335a390bca.json) |
| A send from that balance to Thailand (TESTTHB) | [CORRA-9JG6KE bf85eb70...9881](https://stellar.expert/explorer/testnet/tx/bf85eb7078dc65727340d663a4ec763f092a401ea4a210c8ad2380caf0799881); ledger 5915461; 300.0000000 TESTTHB; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d1/balance-check-2026-11-25T10-02-30-480Z.json), [tx bf85eb70](evidence/2026-12/pre-reset/tx/bf85eb7078dc65727340d663a4ec763f092a401ea4a210c8ad2380caf0799881.json) |
| The app's History showing the deposit linked to the anchor's transaction | [history-1440.png](evidence/2026-12/pre-reset/d1/history-1440.png); History tab on the local stack (headless Chrome, a keypair standing in for Freighter): a deposit with its anchor reference (b6b7fa95-95f0-4348-986c-56351c99d969, matched by ref), Anchor record and stellar.expert links, and a send from the balance. The account shown is GC7SCNH5VM73G5AHY5BGUMCCQOH3TQWC4JEC33LNYSUY3A25X3WDAWZO (app-run 2026-11-25T10-10-50), not the D1 sender above: balance-check discards its sender's secret, so that sender's History cannot be opened. A History screenshot for the D1 sender needs a run whose keys are kept (for example the post-reset app run); local stack, pre-reset | - |
| The same flow on https://app.corra.money | pending (builder) | - |

### Deliverable 2: Blend pool

| SOW item | Evidence | Archive |
|---|---|---|
| The pool contract on stellar.expert | ledger 5915524; [pool](https://stellar.expert/explorer/testnet/contract/CAL5ZEAT7XIP5B7AAUJD6WOVG2W7YDIE27HNF7ABQIC3HBOC42TQFWHS); verified: status 2, admin GC6XADS7NYMJIATPMFP2SZMPERBOLP6AVJVYJPRUN3GM4OW4HDIMEFWX; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-verify-2026-11-25T10-07-45-250Z.json) |
| A deposit into the pool, signed by the sender's account and fee-bumped | [fee-bump 945a1e07...fcec](https://stellar.expert/explorer/testnet/tx/945a1e079bd8a9e6f5a81c85f5220536c5164d54a8045ba4818bf7c60afefcec); [inner 69429684...6f04](https://stellar.expert/explorer/testnet/tx/694296843dbc96ca7ea360bc6d3dac360b4cfd8f962523889344510d8f7d6f04); ledger 5915484; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-check-2026-11-25T10-04-35-576Z.json), [tx 945a1e07](evidence/2026-12/pre-reset/tx/945a1e079bd8a9e6f5a81c85f5220536c5164d54a8045ba4818bf7c60afefcec.json), [tx 69429684](evidence/2026-12/pre-reset/tx/694296843dbc96ca7ea360bc6d3dac360b4cfd8f962523889344510d8f7d6f04.json) |
| A withdrawal from the pool, signed by the sender's account and fee-bumped | [fee-bump aba63eff...839f](https://stellar.expert/explorer/testnet/tx/aba63eff8301d1c925e4310148f459ce41f23565b8ed475f7eca88826723839f); [inner 5fa2a6b4...0984](https://stellar.expert/explorer/testnet/tx/5fa2a6b44e7a5c7dfb0ce556fecd38b38744f78f4dfac9b9c6e75b3559720984); ledger 5915486; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d2/pool-check-2026-11-25T10-04-35-576Z.json), [tx aba63eff](evidence/2026-12/pre-reset/tx/aba63eff8301d1c925e4310148f459ce41f23565b8ed475f7eca88826723839f.json), [tx 5fa2a6b4](evidence/2026-12/pre-reset/tx/5fa2a6b44e7a5c7dfb0ce556fecd38b38744f78f4dfac9b9c6e75b3559720984.json) |
| A screenshot of the position and the 0% rate with the On-Ice note | [poolcard-1440.png](evidence/2026-12/pre-reset/d2/poolcard-1440.png); [poolcard-390.png](evidence/2026-12/pre-reset/d2/poolcard-390.png); [poolcard-390-done.png](evidence/2026-12/pre-reset/d2/poolcard-390-done.png); Balance tab pool card on the local stack (headless Chrome, a keypair standing in for Freighter): position, 0.00% rate, On-Ice note; local stack, pre-reset | - |

### Deliverable 3: cash-out and channel accounts

| SOW item | Evidence | Archive |
|---|---|---|
| The recipient's withdrawal payment to the anchor's distribution account | [fee-bump 0a7ffd77...0bb6](https://stellar.expert/explorer/testnet/tx/0a7ffd773c3f3f0e3a832c6a8f3c58c3b997aa437048f5fdd1ee170473d90bb6); [inner 7464c6d2...db35](https://stellar.expert/explorer/testnet/tx/7464c6d282fe2ad828297950c9a45a576a4d1cac02ff158ca9b965892370db35); ledger 5915475; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d3/cash-out-2026-11-25T10-03-49-273Z.json), [tx 0a7ffd77](evidence/2026-12/pre-reset/tx/0a7ffd773c3f3f0e3a832c6a8f3c58c3b997aa437048f5fdd1ee170473d90bb6.json), [tx 7464c6d2](evidence/2026-12/pre-reset/tx/7464c6d282fe2ad828297950c9a45a576a4d1cac02ff158ca9b965892370db35.json) |
| The anchor's transaction page showing it completed | [more-info-bb6a8b2f-8858-43df-a879-47a3306cf6cb.html](evidence/2026-12/pre-reset/d3/more-info-bb6a8b2f-8858-43df-a879-47a3306cf6cb.html); anchor bb6a8b2f-8858-43df-a879-47a3306cf6cb completed, payout sim-cash-pickup-bb6a8b2f; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d3/cash-out-2026-11-25T10-03-49-273Z.json) |
| Three sponsored setups in the same ledger, each with a different channel account as source | [setup 1 c4dced2c...d99a](https://stellar.expert/explorer/testnet/tx/c4dced2c4f8a8eb6cac683ee411c6841d2bcfd457a6446aebbe15d06c4ffd99a); [setup 2 4cf15c10...2a72](https://stellar.expert/explorer/testnet/tx/4cf15c109a7c80c584309168497e38fbbde5a6c28b8b2e54367aee3e30cd2a72); [setup 3 9b756799...9d8e](https://stellar.expert/explorer/testnet/tx/9b756799fc10872bef44d114e12b8d927615ad19ee12fc86206ea96ecf3d9d8e); ledger 5915489; three setups in ledger 5915489; local stack, pre-reset | [run](evidence/2026-12/pre-reset/d3/concurrent-setups-2026-11-25T10-04-51-140Z.json), [tx c4dced2c](evidence/2026-12/pre-reset/tx/c4dced2c4f8a8eb6cac683ee411c6841d2bcfd457a6446aebbe15d06c4ffd99a.json), [tx 4cf15c10](evidence/2026-12/pre-reset/tx/4cf15c109a7c80c584309168497e38fbbde5a6c28b8b2e54367aee3e30cd2a72.json), [tx 9b756799](evidence/2026-12/pre-reset/tx/9b756799fc10872bef44d114e12b8d927615ad19ee12fc86206ea96ecf3d9d8e.json) |
| A green run of the extended no-server-side-signing job | pending (builder) | - |

### Walkthrough video

| SOW item | Evidence | Archive |
|---|---|---|
| One walkthrough video covering all three deliverables | pending (builder) | - |

### Deviations and honesty notes

- Every payment and pool transaction has the sender's 0-XLM payment account as its transaction source; the sender is the operation source and the only signer, and Corra's sponsor pays the fee by fee-bump. Why: Freighter's fee check warns when the signer is also the fee source, and skips it when it is not (Varial, `docs/risks.md` R18).
- The pool admin and oracle admin is a team script key. The admin cannot move or lock anyone's deposit without a week of on-chain notice; withdrawals work in every pool state. Supply and withdraw never read the oracle price (`docs/risks.md` R22).
- The anchor's transaction page link carries a session token, so it is never published: the page is shown by a saved copy of its HTML with the token removed (screenshot pending).
- Not done yet: D1.hosted, D3.ci, video.

<!-- evidence-index:end -->
