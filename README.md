<div align="center">

<img src="assets/hero.png" alt="Corra: send local cash, get local cash. Cross-border remittance on Stellar." width="100%" />

### Money, teleported.

Corra is a **non-custodial cross-border remittance app on Stellar**.
Send local cash in one country, your recipient gets local cash in another, and nobody ever sees the word "crypto."

[![Live demo](https://img.shields.io/badge/live%20demo-test.corra.money-5B3DF5)](https://test.corra.money)
[![Website](https://img.shields.io/badge/corra.money-0B1437)](https://corra.money)
[![Stellar](https://img.shields.io/badge/Stellar-testnet-7B3FE4)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## See it work first

**[test.corra.money](https://test.corra.money)** runs a real Stellar testnet payment on every click. Not a mockup, not a recording:

```
MXN 3,499.99  ->  USDC  ->  PHP 11,210      settled in seconds
```

Each run submits a live `path_payment_strict_receive` and gives you the transaction hash to check on `stellar.expert` yourself. The verify link only appears once *that* run has a hash, so you are never shown a canned transaction as proof.

**Corra's server never holds a private key.** It builds an unsigned transaction, your browser signs it, and the server only relays the signed XDR onward. Details in [Non-custodial by design](#non-custodial-by-design).

---

## The problem

Cross-border money transfer still settles in 1-3 days and is expensive: the World Bank puts the global average cost of sending $200 at 6.49% in Q1 2025, against a UN Sustainable Development Goal target of 3%, plus an FX spread the sender never sees.

Stellar already solves the settlement half. A single **strict-receive path payment** atomically converts one currency to another through USDC on the open DEX at near-zero cost, and Stellar's own path-finding picks the cheapest route. That part is a commodity, and we treat it as one.

What is missing sits either side of that leg:

**1. A remittance is asynchronous, but signing is not.** Cash-in confirms minutes after the sender has walked away from the kiosk. Every obvious design here reaches for custody, which is the wrong answer for users and impossible for a builder without a money transmission licence. There is no existing Stellar building block for *sign now, settle later, never hold the key*.

**2. A single path payment is not a payment.** No ledger, no idempotency, no refund when the source cost moves past the cap, no recovery when cash-in confirms but settlement was never submitted, no handling for a pre-signed transaction whose timebound expired.

Both are orchestration problems that sit *above* the SEP layer rather than duplicating it.

---

## What we don't build

Corra depends on the ecosystem's existing pieces and writes none of them. This is deliberate and worth being explicit about:

| Concern | What we use | Lines we write |
|---|---|---|
| SEP-1 / SEP-10 / SEP-12 / SEP-24 | [`@stellar/typescript-wallet-sdk`](https://github.com/stellar/typescript-wallet-sdk) (SDF) | none |
| Transactions, Horizon, path payments | [`@stellar/stellar-sdk`](https://github.com/stellar/js-stellar-sdk) (SDF) | none |
| Wallet connection and signing | [`@creit.tech/stellar-wallets-kit`](https://github.com/Creit-Tech/Stellar-Wallets-Kit) | none |
| FX routing | Stellar DEX path-finding | none |

We do not implement a SEP client, and we do not wrap the SEPs in a parallel abstraction of our own.

**On SEP-31:** it is an anchor-to-anchor protocol whose sending side requires a licensed entity and bilateral agreements with each counterparty. It is not something a consumer app can implement, and we don't claim to. SEP-24 is the wallet-side standard and is what we use.

**What is left for us to write** is the part no building block provides: the non-custodial signing flow, and the orchestration and ledger around it.

---

## Non-custodial by design

The obvious way to drive an asynchronous payment is to hold the user's key and sign when cash-in lands. Corra does not do that. Instead the transaction is **pre-signed**:

```mermaid
sequenceDiagram
    participant U as Sender (browser)
    participant O as Corra orchestrator
    participant H as Stellar

    U->>O: request a quote
    O->>U: unsigned XDR<br/>(strict-receive, sendMax cap, timebound)
    Note over U: signs locally. The key never leaves the browser.
    U->>O: signed XDR
    Note over O: waits for cash-in to confirm
    O->>H: submit the signed transaction
    H->>O: tx hash
```

Corra signs nothing with a user's key, and that is the invariant worth stating precisely rather than as a false absolute. **There is exactly one server-side key that touches a user's transaction: the fee-and-sponsor account.** CAP-15 fee-bump requires the fee source to sign the envelope, and CAP-33 sponsorship requires the sponsor to sign `BeginSponsoringFutureReserves`, so that signature is unavoidable if the sender is to need no XLM. It signs only fee-bump envelopes and `BeginSponsoringFutureReserves`, it pays network fees and base reserves, and it can move no user value.

The CI job that enforces this is named **`no-server-side-signing`**, and it prints the exact scope it asserts so the name can never be read as broader than the check. On every run it fails the build if any of these is violated:

- no module loads, derives, or signs with a key belonging to a user
- no server response or log line contains a seed-shaped `S[A-Z2-7]{55}`
- the fee-and-sponsor account never appears as a source or destination in any `payment` or `path_payment_*` operation
- the fee-and-sponsor account signs nothing except fee-bump envelopes and `BeginSponsoringFutureReserves`

The last two are what make the first two meaningful. A job that only asserted "no signing anywhere" would be asserting something the protocol makes impossible, and would have to be either disabled or quietly narrowed the first time sponsorship was wired up.

This is not only a security posture, it is what makes the architecture legally coherent: the regulated legs (cash-in, cash-out, customer KYC) stay entirely with the licensed anchor, and Corra is an interface and an orchestrator that never touches user funds.

**It has costs, and we fund them rather than hide them:**

- A pre-signed transaction pins a sequence number, so the account cannot transact in between.
- The timebound can expire before cash-in confirms. That is a real failure branch: the transaction dies safely and the sender is asked to sign again, never left silently stuck.

---

## Payment lifecycle

Only the on-chain leg is atomic. The cash-in and cash-out legs are slow and external, so the flow is a saga with compensation built in.

```mermaid
stateDiagram-v2
    [*] --> QUOTED
    QUOTED --> SIGNED: sender signs, client-side
    SIGNED --> CASH_IN: cash-in confirmed AND verified on chain
    SIGNED --> EXPIRED: timebound passed before cash-in
    CASH_IN --> ONCHAIN: submit the signed XDR
    ONCHAIN --> CREDITED: settles atomically
    ONCHAIN --> CAP_EXCEEDED: over sendMax, nothing moved
    CREDITED --> [*]
    EXPIRED --> [*]
    CAP_EXCEEDED --> [*]
```

`EXPIRED` leaves from `SIGNED`, not from `ONCHAIN`: a transaction whose timebound passed never enters a ledger at all. `CASH_IN` is never entered on the anchor callback alone, the deposit is independently confirmed from chain state first. And the two terminal exits do not loop back, re-signing opens a **new** saga that references the old one by id, so the ledger keeps one row per signed transaction.

Design notes are published in [`/docs`](docs):

| Doc | What's inside |
|---|---|
| [Architecture](docs/architecture.md) | The layers and the boundaries between them. |
| [Flows](docs/flows.md) | The happy path and every failure branch as explicit saga sequences. |
| [Contracts](docs/contracts.md) | The TypeScript type boundaries. |
| [Ledger](docs/ledger.md) | The Postgres schema: saga state, payment legs, append-only event log. |
| [API](docs/api.md) | The `/quote` and `/confirm` HTTP surface. |
| [Testing](docs/testing.md) | How each leg and failure path is verified, end to end. |
| [Risks](docs/risks.md) | Every risk carried into v1, what it costs, and what bounds it. |
| [Demo](docs/demo.md) | What a reviewer sees, in order, and what each step proves. |

---

## What this proves, and what it doesn't

The demo is honest about its own boundaries, and the page labels each step:

| Leg | Status |
|---|---|
| `MXN -> USDC -> PHP` path payment | **real**, on Stellar testnet, verifiable by hash |
| Client-side signing, keyless server | **real**, asserted by tests |
| Cash-in at the kiosk, cash-out in Manila | **simulated**, no anchor is integrated yet |
| DEX liquidity | **self-seeded** on testnet, not an open market |

The demo sender is a throwaway testnet account whose key ships to the browser on purpose, so anyone can click without installing a wallet. It carries a bounded balance and no real value.

**No real anchor is integrated yet.** Securing one is BD work, not engineering, and it depends on third parties saying yes. Until then this demonstrates a mechanism, not a live corridor.

---

## Anchor reality check

While mapping which Mexico and Philippines ramps could actually be integrated, we probed the ecosystem directly. `anchors.stellar.org` has no public API, so the directory was scraped and every home domain fetched:

| | |
|---|---|
| Anchor entries in the directory | 79 |
| Declaring no SEP support at all | 48 |
| Home domains probed | 330 |
| Declaring `TRANSFER_SERVER_SEP0024` | 42 |
| Whose SEP-24 endpoint actually responds | **19** |
| Distinct live operators behind those | **~12** |

**Roughly 55% of declared SEP-24 endpoints are dead.** Worse, 22 of the 42 declarations come from domains impersonating real financial institutions: `goldmansachs.com.co`, `bnymellon.com.co`, `pimco.dev` and others, carrying real company names and real CEO names in their `stellar.toml`, pointing at endpoints that do not exist.

This is why Corra scopes carefully. Liquidity on paper is not an integratable ramp, and a directory listing is not a working endpoint.

*Measured 2026-07-28. Numbers move; the method is reproducible.*

---

## Tech stack

| Layer | Choice |
|---|---|
| Language | TypeScript, end to end |
| Stellar | `@stellar/stellar-sdk`, `@stellar/typescript-wallet-sdk` |
| Signing | `@creit.tech/stellar-wallets-kit` (client-side only) |
| Orchestrator | Node.js + Fastify |
| Database | Postgres (saga state + append-only event log) |
| Frontend | React + Vite |

---

## Status

Testnet, in active development. No real money moves. Mainnet, real KYC and a licensed anchor relationship are explicitly future phases and depend on partners, not on code.

## Contact

Website: [corra.money](https://corra.money) · Twitter / X: [@corra_money](https://x.com/corra_money)

## License

[MIT](LICENSE).
