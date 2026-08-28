# Corra: Demo walkthrough

> What a reviewer sees, in order, and what each step proves. The walkthrough video follows this script; every step ends in something clickable. Evidence index: EVIDENCE.md.

## The two accounts

Reviewer mode ships two pre-funded throwaway testnet accounts, a sender and a recipient, so one person can run a two-sided payment alone without installing a wallet or funding anything. Both hold only valueless test assets, belong to no user, and their public keys are listed in the repo.

**This is not the non-custodial path.** It exists so the demo has no install step. The funded flow signs in the user's own wallet through Freighter, and the walkthrough shows that path too.

## The five steps

**1. Quote.** Enter an amount the recipient should receive and their address. The page shows the source cost, the `sendMax` cap that will be signed, and the anchor's SEP-38 quote id with its expiry.

> Proves: strict-receive fixes the recipient's side. The quote id is the anchor's, passed through unchanged.

**2. Setup, and the first signature.** Sponsored account creation and trustlines, under CAP-15 and CAP-33 so the sender needs no XLM. The sponsored account authorises the closing half of the sponsorship sandwich, so this is a real signature and not a background step.

> Proves: the sender signs twice in this flow, and the UI says so before the second prompt appears.

**3. The payment signature.** The browser builds the strict-receive path payment with the cap, a 30-minute `maxTime` and a `minSeqNum` precondition, and hands it to the wallet. The wallet prompt appears on the sender's own screen.

> Proves: the key never leaves the wallet. The orchestrator receives a signed blob, not a key.

**4. The sender leaves.** Close the tab. Nothing is waiting on the sender any more.

> Proves: the asynchronous case, which is the whole point. Everything after this happens without them.

**5. Cash-in, then settlement.** The anchor reports the deposit. The orchestrator verifies the credit from chain state before doing anything, then submits the already-signed transaction. `MXN -> USDC -> PHP` settles atomically into the recipient's own account.

> Proves: the callback is a trigger, not an authority. And the ordering problem is solved without anyone taking custody.

Each step links to its transaction on stellar.expert from the page itself.

## The failure branches, shown deliberately

A demo that only shows the happy path is a demo that has not been tested. Three branches are staged on purpose:

- **Cap exceeded.** Forced by moving the seeded orderbook against the signed cap. The transaction lands in a ledger as **failed** with `op_over_sendmax`. Nothing moves, and the sender still holds the deposited asset. Shown as a failed-transaction hash, which is what a refunded saga actually looks like on chain.
- **Timebound expiry.** One saga runs with a deliberately short `maxTime` and is never submitted. This branch produces no hash of its own, because a transaction that fails its time bounds never enters a ledger. So it gets a screen recording of the saga moving to `EXPIRED` and the UI asking for a re-signature, **plus the re-signed payment's own tx hash**, which closes the loop.
- **Lost callback.** The cash-in callback is dropped. The reconciler reads the deposit from chain state and advances the saga anyway. Shown as a recovery run with its own hash.

## What this demo does not show

- **A real anchor.** The cash-in runs against an Anchor Platform instance we operate, because no third-party anchor can credit a token minted by our own issuer. `testanchor.stellar.org` appears once, as a conformance check that our client code works against an implementation we did not write.
- **Price discovery.** The corridor rate comes from orderbooks our market-maker seeds. What is demonstrated is routing, ordering and execution under a signed cap.
- **Money.** `CREDITED` means the recipient's testnet account holds the destination asset and the mock payout handler acknowledged. No fiat moves at any point.

## Timing

About two minutes end to end, most of it waiting for cash-in. The recording is cut, and the cut is visible rather than hidden.

## Before recording

- [ ] Market-maker offers re-seeded, depth published
- [ ] Both reviewer-mode accounts funded, trustlines open
- [ ] Anchor Platform instance up, MXN test asset configured
- [ ] The three failure branches staged and their hashes captured
- [ ] EVIDENCE.md links resolving
