# Corra: Open risks

> Every risk here is carried into v1 on purpose. A risk that is written down and bounded is a design decision; one that is discovered at delivery is a defect. Tests: [testing](testing.md). Flows: [flows](flows.md).

## R1 - Testnet market-maker depth

**The risk.** The corridor has no real market. A market-maker account we run seeds MXN/USDC and USDC/PHP offers, and path-finding matches against those. If depth is thin or the offers drift, `/paths/strict-receive` returns nothing and the payment cannot be quoted.

**What it costs.** A `422 NO_PATH` at quote time, before cash-in starts. This is the cleanest possible failure: nothing has moved and no fiat is involved.

**Bound.** Offers are fixed and wide around the pegged rate, re-seeded manually. Depth is published in EVIDENCE.md so the measured price impact means something against a known book.

**What it does not cover.** This says nothing about real market depth, and v1 does not claim to. See R7.

## R2 - Source cost moving past the cap

**The risk.** Strict-receive fixes what the recipient gets, so all volatility lands on the source side. Between signing and submission the route can get more expensive than the `sendMax` the sender signed.

**What it costs.** The operation fails with `op_over_source_max` and the transaction lands in a ledger as failed. **Nothing moves.** The sender still holds the deposited asset in an account only they can sign for, so no refund leg runs and no fiat moves. The fee and the sequence number are consumed, so the signed blob is spent and a retry is a new saga.

**Bound.** The cap is what the sender signed and it is never exceeded; that is asserted as a ledger invariant. The failure is a terminal state (`CAP_EXCEEDED`), not a loop back to `QUOTED`.

## R3 - Idempotency and reconciliation

**The risk.** A cash-in callback and the reconciler can both deliver the same fact. A submission can be retried. Either could double-process.

**What it costs.** Nothing, and the reason is worth stating precisely. At the ledger level, `UNIQUE(anchor_id, external_ref)` and the event `seq` make repeated delivery a no-op. At the chain level, **exactly-once submission is enforced by the protocol, not by our code**: Stellar consumes the sequence number on the first successful submission and rejects every later resubmission of the same signed blob. The reconciler can therefore retry freely.

**Bound.** Every state advance happens inside one transaction, behind `SELECT ... FOR UPDATE`, with an illegal-transition guard.

## R4 - Trustlines, reserves and account funding

**The risk.** A path payment fails with `op_no_trust` if the recipient has no trustline for the destination asset, and an account cannot exist without a base reserve. A user who has to hold XLM first is a user who never starts.

**What it costs.** Without handling, a failed transaction after cash-in has already happened, which is the worst place to fail.

**Bound.** Account setup runs and is confirmed **before** the payment is signed: sponsored creation and trustlines under CAP-33, fees under CAP-15. Sponsorship is a sandwich and the sponsored account must authorise the closing half, so setup is its own wallet prompt, and the UI says so rather than surprising the sender. A first-time sender sees three prompts (anchor login, setup, payment); a returning sender sees one (the payment).

**The cost of that choice.** It is what forces the fee-and-sponsor key (R5).

## R5 - The server-side keys

**The risk.** CAP-15 requires the fee source to sign the fee-bump envelope and CAP-33 requires the sponsor to sign `BeginSponsoringFutureReserves`. So the claim "the server holds no key at all" cannot be true at the same time as "the sender needs no XLM". One of the two has to give.

**The decision.** Keep the sponsorship, hold the keys this needs, and say so. The server holds the fee-and-sponsor key, the client_domain key, and five channel accounts that only source sponsored setups creating an account (fee and sequence only; no reserve, no value, never a signer). The **fee-and-sponsor account** signs fee-bump envelopes and sponsorship setups, nothing else; it pays network fees and base reserves and can move no user value. Corra's **SEP-10 client_domain `SIGNING_KEY`** co-signs sequence-0 login challenges only, so the anchor can attribute the session to Corra. A **channel account** signs only a setup it sources, inside its lease, that creates an account; its signature authorizes only that fee and sequence.

**Bound, and checked rather than promised.** The `no-server-side-signing` CI job statically scans the server code and fails the build if a key is loaded or a signing call is made outside `sponsor.ts`, `client-domain.ts` and `channels.ts`, or a raw signing primitive is imported; if a seed-shaped `S[A-Z2-7]{55}` string literal appears; if the fee-sponsor secret is used anywhere but `createSponsor()` or the channel secrets anywhere but `createChannels()`; or if an allowed module has more signing call sites or key loads than its documented scope (2, 1 and 1 call sites; 1 key load each). It proves it fails on a violating fixture, and runs the unit tests in which the sponsor key refuses a fee-bump touching its own account and any setup outside the fixed shape. The job prints the scope it checked, so its name can never read as broader than the check.

**Residual.** A compromised fee-and-sponsor key can stop onboarding by refusing to sponsor, and can burn its own XLM. A compromised client_domain key can make the anchor attribute other logins to Corra. A compromised channel key loses only its own XLM: it is never a signer anywhere, and the sponsor refuses to fee-bump anything it sources. None can touch user funds.

## R6 - Quote staleness

**The risk.** A quote has a TTL. A sender who sits on the screen and then confirms is signing against a rate that no longer holds.

**What it costs.** Either a stale rate silently accepted, or a confusing failure late in the flow.

**Bound.** A quote lives 2 minutes, long enough to read the Review screen and approve the wallet prompt; the price risk inside it is bounded by the signed `sendMax`, not by the TTL. `/confirm` rejects an expired quote with `409 QUOTE_EXPIRED` before any state is created. Separately, `422 UNBOUND_TRANSACTION` rejects a signed XDR whose destination, destination asset, destination amount or `sendMax` does not match the quote it claims to be for.

## R7 - Demo honesty

**The risk.** A testnet demo can read as a working product. Every part of this one is real except the parts that are not, and conflating them is how a reviewer stops trusting the rest.

**Bound.** The split is published rather than implied.

| Leg | Status |
|---|---|
| `MXN -> USDC -> PHP` path payment, and its atomicity | **real**, on testnet, verifiable by hash |
| Client-side signing, no user key anywhere | **real**, asserted by CI |
| SEP-10, SEP-24 and SEP-38 protocol integration | **real** |
| The anchor behind that integration | **ours**, a self-hosted Anchor Platform |
| The corridor rate | **ours**, from orderbooks our market-maker seeds |
| Cash-out in Manila | **real protocol, our anchor**: a SEP-24 TESTPHP withdrawal at the test anchor; the cash pickup is **simulated**, no fiat moves |

`CREDITED` means the recipient's testnet account holds the destination asset. The cash-out is the recipient's own withdrawal afterwards, confirmed by the test anchor's signed callback and the chain; its payout is simulated. Corra has zero users.

## R8 - The 30-minute window bounds this to fast cash-in

**The risk.** The design assumes cash-in confirms inside the signature window. That holds for instant rails and for a local anchor instance. A bank transfer or an OXXO cash deposit takes longer.

**What it costs.** On a slow rail the signed transaction expires and the sender must re-sign, which needs the sender present. That is exactly what the problem statement says they are not.

**Bound.** v1 does not solve it and does not claim to. Widening the window without weakening the cap needs a re-sign notification path, which is Phase 2.

## R9 - `minSeqNum` widens the window, it does not remove it

**The risk.** A pre-signed transaction pins a sequence number. CAP-21's `minSeqNum` keeps it valid across a range instead of one exact value.

**What it costs.** If the payment account's sequence moves past that range while waiting, the pre-signed transaction is permanently dead. The window is the sender's payment account's, not the sender's: the sender's own wallet activity elsewhere no longer touches it; only the sender's Corra payments and pool steps move it (and the sender, who can bump or merge it). Two blobs in the same slot never both land, but a superseded pre-signed blob stays valid until its `maxTime`, and anyone holding it can fee-bump it; the ledger only stops Corra from submitting it.

**Bound.** The reconciler reads the payment account's sequence while the payment waits for cash-in and expires it as soon as the window is used up, or the account is gone (merged), with the reason `payment account sequence left the signing window`, so the app can say so before the user pays in. It routes to the same re-sign path as expiry. A balance payment is refused while a pre-signed one waits (`SIGNED_PAYMENT_WAITING`), so Corra does not land both in normal use; the check is not atomic, and two requests from the same sender in the same instant can both be accepted (accepted at testnet volume, J-u2b-S1-3).

## R10 - The orchestrator can decline to submit

**The risk.** Holding a signed blob means being able to not submit it.

**What it costs.** Nothing to the sender's funds. It is indistinguishable from expiry, and the deposited asset never left an account only they can sign for.

**Bound.** The signed XDR is returned to the sender's browser, so they can submit it to any Horizon themselves. Because the inner transaction relies on Corra's fee-bump, doing so needs their own XLM or their own fee-bump wrapper: the escape hatch is real but not free. Removing that dependency is Phase 2.

## R11 - Testnet is not permanent

**The risk.** SDF resets testnet periodically, clearing all accounts, assets, contracts and transaction history; the next reset is 2026-12-16 17:00 UTC. Every artifact in the evidence is a testnet hash or a deployed address.

**What it costs.** After a reset, every stellar.expert link stops resolving, the app stops working until the accounts are rebuilt, and the pool stays down until Blend redeploys its factory.

**Bound.** The raw transaction JSON of every cited hash is archived in the repo before the reset: Horizon's transaction, operations and effects, plus the RPC's record of a Soroban transaction (`pnpm archive-tx`; month 1 under `evidence/2026-10/tx/`, month 2 under `evidence/2026-12/pre-reset/tx/`), so the evidence outlives the reset even when the links do not. The rebuild is one script (`pnpm redeploy-after-reset`, [testnet-reset](testnet-reset.md)) that reuses every team key, so the issuers, the distribution account, the sponsor, the channels and the 7 Stellar Asset Contract ids stay the addresses the SOW names; only the pool, its oracle and the demo recipient get new ids, and the old ones are kept in the pre-reset evidence.

**Residual.** The pool depends on Blend redeploying its factory on the new testnet; Corra never deploys Blend's factory itself. If it is not back by the delivery cut-off, the D2 evidence is the archived pre-reset set and EVIDENCE.md says so. The RPC keeps a Soroban transaction's record only for a short window, so a pool hash archived late has Horizon's JSON but no RPC record.

## R12 - The holder of the signed blob chooses when it lands

**The risk.** The sender signs a cap, not a price. Until `maxTime`, whoever holds the signed transaction (Corra, or the sender's browser) can submit it at any moment of their choosing.

**What it costs.** At most the slippage between the quoted cost and `sendMax`: the destination amount is fixed and the source can never exceed the cap the sender signed. Nothing else can change.

**Bound.** The cap is the bound. The 30-minute window keeps it short, and the default slippage is 1.5%.

## R13 - Concurrent account setups share the sponsor's sequence number (closed by channel accounts)

**The risk.** A sponsored setup sourced from the one fee-and-sponsor account is submitted by the user after co-signing. Two setups prepared at the same moment would carry the same sequence number, so only the first one submitted would land (`tx_bad_seq` for the other).

**Closed.** A setup that creates an account (a new sign-up's payment account and account) is sourced by one of five channel accounts, leased in memory to that sign-up until its setups land or 315 s pass; three sign-ups at once land in one ledger (`pnpm concurrent-setups`). The sponsor still pays every reserve.

**Residual.** A restart of the orchestrator drops the leases (at worst one setup fails `tx_bad_seq`). That `/setup` already spent the account's per-account token (1 per 10 minutes), so a brand-new account, or an existing one adding a trustline, can set up again only after up to 10 minutes; until then the retry gets `429 RATE_LIMITED`. Lease griefing: five `/setup` calls for fresh addresses hold all five channels for 315 s, bounded by the setup limits; the effect is the Phase 1 sponsor-sourced shape, not an outage. A declined wallet prompt holds its lease up to 315 s. A trustline-only setup of an existing account still shares the sponsor's sequence. Concurrent payment-account-only setups for the same existing sender can each land on a different channel, creating up to five payment accounts per burst, bounded by the `/setup` limits; each costs 1.5 XLM of sponsor reserves, and the lowest id is used. Leases live in one process, and the local stack is already a second one: it signs with the same five channels (`deploy.sh` and `local-stack.sh` read the same `.env.testnet`), its leases are invisible to production's, and both start with the first channel. A local setup (`pnpm concurrent-setups`, the drive scripts, a manual sign-up) made while a production user is in the wallet prompt can take the same channel at the same sequence, so one of the two fails `tx_bad_seq`, and that user waits up to 10 minutes for the per-account `/setup` limit before setting up again (the same as after a restart). Bound: do not run those scripts while production takes sign-ups; a separate production channel set, or a lock per channel shared by both processes, would remove it (not built).

## R14 - `/setup` needs no login

**The risk.** Anyone can ask for a sponsored setup for a key they hold, co-sign it and submit it. Each one locks the sponsor's reserves: 1 XLM for the account and 0.5 XLM per trustline, and a 0-XLM account can never pay them back.

**What it costs.** At most 2 XLM per setup (one or two trustlines, from the corridor assets only), and the global limit caps it at 60 setups an hour.

**Bound.** Per-IP, per-account and global rate limits, and the setup shape is fixed (no duplicates, no foreign assets, fee and time bounds capped). Requiring a SEP-10 session before `/setup` is Phase 2.

**Payment accounts.** Anyone can ask `/setup` to create a payment account for any address, existing or not: the sender signs nothing in it. That is harmless to the address (it gains a 0-XLM account only its own key controls) and bounded by the same `/setup` limits. Each payment account locks 1.5 XLM more of the sponsor's reserves (account 1 XLM + signer 0.5 XLM), so a user costs 3.0 to 3.5 XLM; on mainnet (Phase 2) that stays locked until the user merges the payment account, which returns it.

## R15 - A deposit paid through the asset's contract may carry no memo

**The risk.** The anchor can pay through the asset's Stellar Asset Contract. A Soroban transaction cannot carry a memo, and Corra matches each deposit to its payment by memo.

**What it costs.** Such a deposit would not be matched, and the payment would expire with the money in the sender's account, ready for a re-sign.

**Bound.** The test anchor pays with a classic payment that carries the memo; every deposit in the evidence did. Matching by a muxed id or the SEP-24 transaction id is Phase 2.

## R16 - Fee-bump bids under surge pricing

**The risk.** The sponsor wraps every payment in a fee-bump. Under surge pricing a low bid loses and the payment waits.

**What it costs.** A delay, and in a long surge an expiry with the money still in the sender's account.

**Bound.** Each submission bids what recent ledgers charged (Horizon's p90), never less than 1000 and never more than 20,000 stroops per operation; the sponsor key refuses any higher bid. A surge above that cap still delays the payment.

## R17 - A flooded sender account can hide a deposit

**The risk.** `findDeposit` walks the sender's payments back from the newest, at most 20 pages of 200, until it reaches the payment's creation time. About 4000 dust payments sent to the sender after the deposit push it out of that view.

**What it costs.** The deposit is not found, so the payment waits and expires with the money in the sender's account. Nothing is lost: the money stays in the sender's own account, and a re-sign reuses that deposit once it is back in view (the re-sign's search walks the same capped history).

**Bound.** The 20-page cap keeps one reconcile pass bounded. Matching by the transaction id the anchor reports is Phase 2.

**Deposits (D1).** An unbound deposit is found the same way, by its memo in the account's payments from the distribution account. The reconciler checks at most 5 deposits per 10-second pass, and a deposit's turn comes by its age: every 30 s while it is younger than 10 minutes, every 2 minutes up to 2 hours, then every 10 minutes until it expires at 24 h (an expired one hourly for 7 days). A normal check reads one page; a flooded account up to 20. The anchor's signed callback and the browser's link check at once, outside that cadence. There is no cap on open deposits per account: `account` is an unauthenticated body field, so a cap would let anyone lock a victim's Add money; `POST /deposits` is rate limited instead (R24).

## R18 - Wallet heuristics

**The risk.** Wallets add checks of their own. Varial 5.52.0 (the wallet formerly named Freighter) shows an "INSUFFICIENT FUNDS FOR FEE" modal when the signing account is the envelope's fee source and its available XLM is not greater than the fee. A Phase 1 payment had the 0-XLM sender as transaction source with fee 0, so the modal fired (seen 2026-11-24).

**What it costs.** A warning on a product whose sender holds no XLM by design; "Got it" dismisses it, but a reviewer would see it.

**Bound.** Every payment and pool step now has the sender's payment account as transaction source, so the sender is never the fee source and Varial runs no fee check (its designed rule, tested upstream: "does not show unfunded warning when another account pays the fee"). `packages/stellar/src/wallet-fee-check.test.ts` ports that rule and fails if any shape regresses to a sender-sourced envelope. Varial older than 5.49.0 has no fee-source gate and would still warn. The builder's run of the real Varial review on the local stack (HUMAN-TASKS u2b) is pending; its result goes into EVIDENCE.md. Varial runs Blockaid only on mainnet: that check is a mainnet gate (R23).

## R19 - The cash-out's payout is simulated, and a paid anchor can still fail

**The risk.** The recipient's withdrawal is a real SEP-24 TESTPHP payment to the test anchor, but the cash pickup behind it is simulated by the anchor's business server. If the anchor reports `error` or `refunded` after the recipient's payment landed, the TESTPHP is with the anchor and nothing refunds it on testnet.

**What it costs.** On testnet, test tokens. The leg stays `PENDING` with its landed transaction (`CASH_OUT_ANCHOR_FAILED {paid: true}`), and a new withdrawal for that payment is refused (`CASH_OUT_ALREADY_PAID`), so the recipient is never asked to pay twice.

**Bound.** Corra records only withdrawal payments it validated and submitted itself; a payment the recipient sends to the anchor outside Corra is not recorded and confirms nothing. The anchor's poller refunds nothing on a wrong amount (only an out-of-band payment can carry one, since Corra pins the amount). Local and production share the anchor's distribution account, so both pollers see every payment to it; each acts only on its own platform's withdrawals, matched by the platform's random memo, exact amount and asset. A real payout and its refunds need a licensed anchor (Phase 2).

**Bounded scan.** The anchor's payout poller reads at most 10 pages of 200 payments to the distribution account per tick, back to the oldest open withdrawal. Only after more than 2,000 payments to that account inside one withdrawal's 24-hour window can a withdrawal fall out of view (it then expires instead of completing, and each tick repeats the 10 reads). Nothing is lost: the recipient's payment is on chain and the anchor's record can be finished by hand. A stored-cursor scan would remove it (not built; testnet volume is far below it).

## R20 - A lost `completed` callback leaves the cash-out waiting

**The risk.** The cash-out leg turns `CONFIRMED` only from the anchor's signed `completed` withdrawal callback plus the payment on chain, and nothing asks the anchor later. Anchor Platform 4.8.0 retries a failed callback only 3 times, over about a minute (5 s to 30 s backoff). If the orchestrator is down or its database or Horizon fails for longer than that, the `completed` callback is lost.

**What it costs.** The leg stays `PENDING` with its landed transaction and no `CASH_OUT_ANCHOR_COMPLETED`. The recipient's Cash out row says the payment reached the anchor and is waiting for the anchor's confirmation, and it never moves on. The reconciler keeps re-reading the transaction from Horizon on every pass, but the chain alone never confirms the leg. The anchor's own record says `completed`, so no money is lost, only Corra's view of it.

**Bound.** Recovery is manual: an operator checks the anchor's record (its more_info page) and the chain, and finishes the leg by hand. Nothing does it automatically, by design for now: asking the anchor without its signed callback would be a new trust path (Corra would act on an unsigned read). A paid leg that will never confirm is re-checked on every idle period, which costs Horizon reads, not money.

## R21 - A stored more_info link is a permanent public read-only link

**The risk.** Deposit rows and the cash-out events `CASH_OUT_ANCHOR_COMPLETED` and `CASHED_OUT` store the anchor's `moreInfoUrl`, which carries the anchor's HS256 token. The read routes and the event stream that return them need no login, and the test anchor's more_info page checks the token's signature, `jti`, audience and transaction id but ignores its expiry, so stored links keep working.

**What it costs.** Anyone who has the link, or who reads the account's rows, can open that one transaction's status page at the anchor: its id, kind, status, amounts, the anchor account and Stellar transaction, the simulated payout reference and the completion time. The page is read-only; the token cannot start, change or pay anything.

**Bound.** Accepted under J58 and J118: stored links must keep working and the page shows only one transaction's status. The evidence files still strip `token=` from every `moreInfoUrl` for hygiene (I-u4-21). A real anchor (Phase 2) sets its own more_info policy.

## R22 - Pool admin powers

**The risk.** Corra's Blend pool and its oracle are administered by a team script key (`POOL_ADMIN_SECRET`, never loaded by the orchestrator). Blend gives a pool admin powers over the pool's configuration.

**What it costs.** The admin cannot move or lock anyone's deposit without a week of on-chain notice; withdrawals work in every pool state. A reserve change (for example enabling borrowing, which would turn the 0% rate into a real one and put deposits at risk) is queued and takes effect only after Blend's one-week timelock, visibly on chain. The pool status can move between On-Ice and other states, but supply is the only thing a status can stop; withdraw never. The oracle's price is never read by supply or withdraw, so an admin-set price cannot change what a user puts in or takes out.

**Bound.** The deployed configuration (borrowing off: c_factor = l_factor = 0, take rate 0, max 2 positions, our oracle) is verified on chain by `pnpm pool-check --verify-only` and `pnpm ops-check`. The admin key lives only in `.env.testnet` for the scripts.

## R23 - Mainnet gates

What stands between this testnet build and a mainnet pilot (Phase 2), stated so none of it is mistaken for done:

- **Payment-account reserve.** Each user locks 3.0 to 3.5 XLM of the sponsor's reserves (account, trustline, payment account and its signer). On mainnet that is real money, locked until the user merges the payment account, which returns it.
- **Blockaid.** Varial runs Blockaid only on mainnet. Its verdict on a payment-account-sourced fee-0 payment, and on both setup transactions, is unknown until tried there (R18).
- **Channel accounts.** One channel set and in-memory leases per process (R13): a mainnet deployment needs its own channel set, and shared leases if more than one process serves sign-ups.
- **A licensed anchor.** The cash-in and the cash-out run against Corra's own test anchor; real fiat needs a licensed anchor partner (R7, R19).

## R24 - Horizon request volume

**The risk.** Corra reads public Horizon for everything it trusts: deposits, payments, payment accounts, balances. A burst of requests, or an account flooded on purpose, multiplies those reads.

**Bound.**
- Deposits: at most 5 checks per 10-second pass, by age (R17), normally one page each. A pass takes the deposits due longest first (due = last check + the interval for its age), never a class first: a checked deposit's next due time lies after every deposit already due, so any due deposit, an expired one or one whose callback was lost included, is checked within (deposits due before it / 5) passes. A flood of new deposits through `POST /deposits` (10 per IP and 3 per account per 10 minutes) slows that turn but cannot block it.
- Payment accounts: the `?signer=` listing is read to the first page that holds a match, at most 50 pages of 200 (anyone can add a sender as a signer of their own accounts; past 10,000 such records a real payment account would drop out of view). The app's 8-second balance poll reads the payment account it already knows directly and lists only when it is gone or reshaped.
- `POST /confirm` and `GET /payments/:id` have no per-IP limit; `/confirm` reads Horizon once per request it accepts. Not abused so far; a limiter would change Phase 1 behaviour.
- A lagging Horizon replica right after a setup can make the first payment fail closed (`UNBOUND_TRANSACTION`, "set up the account first"); nothing is lost and a retry works.

**Residual.** No back-off on HTTP 429 from Horizon (throttling of testnet Horizon is not observed). The Balance card says "Horizon is not answering" only after 3 failed reads in a row or 90 seconds without an answer.

## R25 - Analytics

**What is recorded.** Corra counts usage with a self-hosted GoatCounter (cookie-less; it counts sessions by a hash it does not store, so no consent banner): one page view per visit, always as `/`, with the link's `utm_campaign` and `utm_source`, and three named events, `wallet-connect`, `quote` and `sign` (a payment, a pool move or a withdrawal approved in the wallet; never the sign-in or the setup). Each hit is one `count.js` request with exactly these fields: the path (`/` for the page view, the event name for an event), the referrer, the page title, the page's query string (`location.search`, so `utm_campaign` and `utm_source` ride along), the screen width, a bot flag, an event flag and a random cache-buster. The referrer of the page view is the browser's `document.referrer` (the page the visitor came from); the referrer of an event is the participant tag (`S1`-`S99` interview, `B1`-`B99` builder demo, `U1`-`U99` user test) when the visit came from such a link, and is empty otherwise (`eventOf` passes `''` so `count.js` does not fill in `document.referrer`; checked on 2.7.0, and the server does not read the HTTP Referer header). GoatCounter takes a `utm_source` in the query as the hit's ref. For the Day-29 funnel, the ref column of an event is therefore the participant tag or empty.

**What is never recorded.** No address, amount, hash, id or error text leaves the app through analytics: `track()` takes only the event name (`apps/web/src/logic/analytics.ts`, checked by a source scan test). GoatCounter itself stores the browser, screen size and country of a page view, and the referrer.

**Two instances.** Production counts at https://stats.corra.money; the local stack at http://stats.localhost:8094, so localhost user tests are counted too. The Day-29 report combines both exports.

**Trust path.** The app loads `count.js` from the stats host into the origin that builds the transactions handed to Freighter. It loads it with subresource integrity (`COUNT_JS_SRI` in `apps/web/src/logic/analytics.ts`, the sha384 of the file `arp242/goatcounter:2.7.0` serves, with `crossorigin="anonymous"`), so a changed `count.js` from a compromised GoatCounter container or site is refused by the browser and only counting stops. The integrity binds the image version: upgrading GoatCounter means a new hash in the app, and `pnpm ops-check` (`stats`) FAILs when the served file does not match. The hits themselves still go to the stats host, which sees what any analytics host sees (above).

