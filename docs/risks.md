# Corra: Open risks

> Every risk here is carried into v1 on purpose. A risk that is written down and bounded is a design decision; one that is discovered at delivery is a defect. Tests: [testing](testing.md). Flows: [flows](flows.md).

## R1 - Testnet market-maker depth

**The risk.** The corridor has no real market. A market-maker account we run seeds MXN/USDC and USDC/PHP offers, and path-finding matches against those. If depth is thin or the offers drift, `/paths/strict-receive` returns nothing and the payment cannot be quoted.

**What it costs.** A `422 NO_PATH` at quote time, before cash-in starts. This is the cleanest possible failure: nothing has moved and no fiat is involved.

**Bound.** Offers are fixed and wide around the pegged rate, re-seeded manually. Depth is published in EVIDENCE.md so the measured price impact means something against a known book.

**What it does not cover.** This says nothing about real market depth, and v1 does not claim to. See R7.

## R2 - Source cost moving past the cap

**The risk.** Strict-receive fixes what the recipient gets, so all volatility lands on the source side. Between signing and submission the route can get more expensive than the `sendMax` the sender signed.

**What it costs.** The operation fails with `op_over_sendmax` and the transaction lands in a ledger as failed. **Nothing moves.** The sender still holds the deposited asset in an account only they can sign for, so no refund leg runs and no fiat moves. The fee and the sequence number are consumed, so the signed blob is spent and a retry is a new saga.

**Bound.** The cap is what the sender signed and it is never exceeded; that is asserted as a ledger invariant. The failure is a terminal state (`CAP_EXCEEDED`), not a loop back to `QUOTED`.

## R3 - Idempotency and reconciliation

**The risk.** A cash-in callback and the reconciler can both deliver the same fact. A submission can be retried. Either could double-process.

**What it costs.** Nothing, and the reason is worth stating precisely. At the ledger level, `UNIQUE(anchor_id, external_ref)` and the event `seq` make repeated delivery a no-op. At the chain level, **exactly-once submission is enforced by the protocol, not by our code**: Stellar consumes the sequence number on the first successful submission and rejects every later resubmission of the same signed blob. The reconciler can therefore retry freely.

**Bound.** Every state advance happens inside one transaction, behind `SELECT ... FOR UPDATE`, with an illegal-transition guard.

## R4 - Trustlines, reserves and account funding

**The risk.** A path payment fails with `op_no_trust` if the recipient has no trustline for the destination asset, and an account cannot exist without a base reserve. A user who has to hold XLM first is a user who never starts.

**What it costs.** Without handling, a failed transaction after cash-in has already happened, which is the worst place to fail.

**Bound.** Account setup runs and is confirmed **before** the payment is signed: sponsored creation and trustlines under CAP-33, fees under CAP-15. Sponsorship is a sandwich and the sponsored account must authorise the closing half, so **the sender signs twice in the flow** and the UI says so rather than surprising them with a second prompt.

**The cost of that choice.** It is what forces the one server-side key (R5).

## R5 - The one server-side key

**The risk.** CAP-15 requires the fee source to sign the fee-bump envelope and CAP-33 requires the sponsor to sign `BeginSponsoringFutureReserves`. So the claim "the server holds no key at all" cannot be true at the same time as "the sender needs no XLM". One of the two has to give.

**The decision.** Keep the sponsorship, hold exactly one key, and say so. The **fee-and-sponsor account** signs fee-bump envelopes and `BeginSponsoringFutureReserves`, nothing else. It pays network fees and base reserves and can move no user value.

**Bound, and checked rather than promised.** The `no-server-side-signing` CI job fails the build if a user's key is loaded, derived or signed with; if a seed-shaped `S[A-Z2-7]{55}` appears in any response or log line; if the fee-and-sponsor account is a source or destination in a `payment` or `path_payment_*`; or if it signs anything outside those two operation types. The job prints the scope it checked, so its name can never read as broader than the check.

**Residual.** A compromised fee-and-sponsor key can stop onboarding by refusing to sponsor, and can burn its own XLM. It cannot touch user funds.

## R6 - Quote staleness

**The risk.** A quote has a TTL. A sender who sits on the screen and then confirms is signing against a rate that no longer holds.

**What it costs.** Either a stale rate silently accepted, or a confusing failure late in the flow.

**Bound.** `/confirm` rejects an expired quote with `409 QUOTE_EXPIRED` before any state is created. Separately, `422 UNBOUND_TRANSACTION` rejects a signed XDR whose destination, destination asset, destination amount or `sendMax` does not match the quote it claims to be for.

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
| Cash-out in Manila | **mock** payout handler; no fiat moves |

`CREDITED` means the recipient's testnet account holds the destination asset and the mock handler acknowledged. Corra has zero users.

## R8 - The 30-minute window bounds this to fast cash-in

**The risk.** The design assumes cash-in confirms inside the signature window. That holds for instant rails and for a local anchor instance. A bank transfer or an OXXO cash deposit takes longer.

**What it costs.** On a slow rail the signed transaction expires and the sender must re-sign, which needs the sender present. That is exactly what the problem statement says they are not.

**Bound.** v1 does not solve it and does not claim to. Widening the window without weakening the cap needs a re-sign notification path, which is Phase 2.

## R9 - `minSeqNum` widens the window, it does not remove it

**The risk.** A pre-signed transaction pins a sequence number. CAP-21's `minSeqNum` keeps it valid across a range instead of one exact value.

**What it costs.** If the sender's account issues transactions past that range while waiting, the pre-signed transaction is permanently dead.

**Bound.** It routes to the same re-sign path as expiry, so it is a known branch rather than a stuck state.

## R10 - The orchestrator can decline to submit

**The risk.** Holding a signed blob means being able to not submit it.

**What it costs.** Nothing to the sender's funds. It is indistinguishable from expiry, and the deposited asset never left an account only they can sign for.

**Bound.** The signed XDR is returned to the sender's browser, so they can submit it to any Horizon themselves. Because the inner transaction relies on Corra's fee-bump, doing so needs their own XLM or their own fee-bump wrapper: the escape hatch is real but not free. Removing that dependency is Phase 2.

## R11 - Testnet is not permanent

**The risk.** SDF resets testnet periodically, clearing all accounts, assets and contracts. Every artifact in the evidence submission is a testnet hash or a deployed address.

**What it costs.** After a reset, submitted links stop resolving.

**Bound.** EVIDENCE.md is self-contained: raw transaction JSON is archived in the repo alongside every explorer link, so the evidence outlives a reset even when the links do not.
