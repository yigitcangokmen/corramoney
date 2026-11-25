# Corra: Demo walkthrough

> What a reviewer sees, in order, and what each step proves. The walkthrough video follows this script; every step ends in something clickable. Evidence index: EVIDENCE.md.

## The two accounts

The demo runs in the hosted app at [app.corra.money](https://app.corra.money). The sender is the reviewer's own Freighter wallet on testnet (Varial, the wallet formerly named Freighter); no key that can sign for the sender or hold value is generated or shipped to the browser; setup creates the sender's 0-XLM payment account with a throwaway key that the same transaction sets to weight 0, and the key is never stored. The sender needs no XLM: account creation and trustlines are sponsored.

For the recipient, the app offers a public demo recipient account (`demoRecipient` in `packages/shared/src/testnet.ts`, created by `pnpm demo-recipient`), so one person can run a two-sided payment without a second wallet. It holds a trustline for every destination asset, its secret was discarded when it was created, and it only ever receives.

## The five steps

**1. Quote.** Enter an amount the recipient should receive and their address. The page shows the source cost, the `sendMax` cap that will be signed, and the anchor's SEP-38 quote id with its expiry. The browser requests that firm quote with the sender's own SEP-10 session.

> Proves: strict-receive fixes the recipient's side. The quote id is the anchor's, recorded by `/confirm` unchanged.

**2. Setup, and the first signature.** Sponsored account creation and trustlines, under CAP-15 and CAP-33 so the sender needs no XLM. The sponsored account authorises the closing half of the sponsorship sandwich, so this is a real signature and not a background step.

> Proves: setup is a separate, one-time signature, and the UI says so before the payment prompt appears. A first-time sender approves three prompts in total (anchor login, setup, payment); a returning sender approves only the payment.

**3. The payment signature.** The browser builds the strict-receive path payment with the cap, a 30-minute `maxTime` and a `minSeqNum` precondition, and hands it to the wallet. The wallet prompt appears on the sender's own screen.

> Proves: the key never leaves the wallet. The orchestrator receives a signed blob, not a key.

**4. The sender leaves.** Close the tab. Nothing is waiting on the sender any more.

> Proves: the asynchronous case, which is the whole point. Everything after this happens without them.

**5. Cash-in, then settlement.** The anchor reports the deposit. The orchestrator verifies the credit from chain state before doing anything, then submits the already-signed transaction. `MXN -> USDC -> PHP` settles atomically into the recipient's own account.

> Proves: the callback is a trigger, not an authority. And the ordering problem is solved without anyone taking custody.

Each step links to its transaction on stellar.expert from the page itself.

## The failure branches, shown deliberately

A demo that only shows the happy path is a demo that has not been tested. Three branches are staged on purpose:

- **Cap exceeded.** Forced by moving the seeded orderbook against the signed cap. The transaction lands in a ledger as **failed** with `op_over_source_max`. Nothing moves, and the sender still holds the deposited asset. Shown as a failed-transaction hash, which is what a refunded saga actually looks like on chain.
- **Timebound expiry.** One saga runs with a deliberately short `maxTime` and is never submitted. This branch produces no hash of its own, because a transaction that fails its time bounds never enters a ledger. So it gets a screen recording of the saga moving to `EXPIRED` and the UI asking for a re-signature, **plus the re-signed payment's own tx hash**, which closes the loop.
- **Lost callback.** The cash-in callback is dropped. The reconciler reads the deposit from chain state and advances the saga anyway. Shown as a recovery run with its own hash.

## What this demo does not show

- **A real anchor.** The cash-in runs against SDF Anchor Platform 4.8.0 that we operate at `anchor.corra.money`, because no third-party anchor can credit a token minted by our own issuer. The SPEI transfer behind it is simulated by the anchor's business server, so the gap between signing and cash-in is seconds.
- **Price discovery.** The corridor rate comes from orderbooks our market-maker seeds. What is demonstrated is routing, ordering and execution under a signed cap.
- **Money.** `CREDITED` means the recipient's testnet account holds the destination asset. The recipient can then cash it out at the test anchor (Cash out tab, a SEP-24 TESTPHP withdrawal); the cash pickup is simulated. No fiat moves at any point.

## Month 2: balance, pool, cash-out

The second walkthrough covers the three month-2 deliverables, with two Freighter accounts at 0 XLM (a sender S and a recipient R). Every step ends in a stellar.expert link or the anchor's own page.

1. **Connect.** One SEP-10 sign-in at the anchor; it is never submitted.
2. **Set up.** One prompt; Corra sponsors the account, its TESTMXN trustline and the payment account, so S holds 0 XLM.
3. **Add money.** 2,000 at the anchor's page; the simulated SPEI makes the anchor pay TESTMXN into S's own account. The deposit is tied to no payment.
4. **History.** The deposit row shows the anchor's reference and opens its transaction on stellar.expert.

   > Proves: a deposit into the sender's own account, confirmed from the chain, not from the anchor's word.

5. **Send from the balance.** Philippines, 500, "Pay from my balance now": one prompt, one ledger. On stellar.expert the transaction source is S's payment account, the operation source is S, and Corra's sponsor pays the fee.
6. **Four more corridors.** Brazil, Argentina, Indonesia, Thailand, each from the same balance; History lists all five.

   > Proves: five sends from one balance, none of them needing a new deposit.

7. **The pool.** The pool card on the Balance tab: On-Ice, 0% rate, borrowing off. The admin cannot move or lock anyone's deposit without a week of on-chain notice; withdrawals work in every pool state.
8. **Move 100 in, take it back.** One prompt each; both fee-bumped by Corra, S still at 0 XLM.

   > Proves: a deposit into Corra's Blend pool and a withdrawal, signed by the sender's account and fee-bumped.

9. **Cash out (R).** R's Cash out tab lists the TESTPHP it received. Cash out opens the anchor's page; confirm there, then sign one payment to the anchor's distribution account. Corra shows "Paid to the anchor", and the anchor's transaction page says completed.
10. **Three sign-ups in one ledger.** `pnpm concurrent-setups` in a terminal: three sponsored setups in one ledger, each sourced by a different channel account.
11. **CI.** The green `no-server-side-signing` job.
12. **EVIDENCE.md.** Every item above, with its archived transaction JSON.

If the testnet was reset before recording, the walkthrough says so: SDF reset testnet on 2026-12-16, the stack was rebuilt by script with the same addresses, and the pool has new contract ids.

## Timing

About two minutes end to end, most of it waiting for cash-in. The recording is cut, and the cut is visible rather than hidden.

## Before recording

- [ ] Market-maker offers re-seeded, depth published
- [ ] Demo recipient account exists, trustlines open; a Freighter testnet wallet ready for the sender
- [ ] Anchor Platform instance up, MXN test asset configured
- [ ] The three failure branches staged and their hashes captured
- [ ] EVIDENCE.md links resolving
