<div align="center">

<img src="assets/hero.png" alt="Corra: One tap. Two countries. Zero friction." width="100%" />

# Corra

### Money, teleported.

Corra is a cross-border remittance app on Stellar, powered by an open-source **anchor-aggregation layer**.
Send local cash in one country, your recipient gets local cash in another, and nobody ever sees the word "crypto."

[![Website](https://img.shields.io/badge/corra.money-5B3DF5)](https://corra.money)
[![Stellar](https://img.shields.io/badge/Stellar-testnet-7B3FE4)](https://stellar.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-in%20development-orange)

</div>

---

## The problem

Cross-border money transfer still settles in 1-3 days and loses 5-7% to fees plus a hidden FX spread the sender never sees.

Stellar already has the rails to fix this: a single **path payment** atomically converts one currency to another through USDC on the open DEX at near-zero cost, and Stellar's own path-finding already picks the cheapest on-chain route.

What is missing sits one layer up: an **anchor aggregator** that normalizes fragmented fiat on/off-ramps behind a single adapter interface and routes each corridor to a usable ramp, while orchestrating cash-in -> USDC hub -> cash-out as one flow.

> **Liquidity on paper is not a usable ramp.** Most anchors that hold local liquidity expose no developer-integratable on/off-ramp. The path payment is a commodity. The orchestration layer that makes heterogeneous, not-ready anchors usable is the moat.

---

## How it works

<img src="assets/how-it-works.png" alt="How Corra works: quote, cash-in, path payment, credited, cash-out" width="100%" />

A sender in Mexico wants to send money to Maria in the Philippines:

1. **Quote** -- "Maria gets PHP 11,210." Corra computes what the sender pays (a strict-receive quote, so the recipient amount is guaranteed).
2. **Cash-in** -- the sender's local currency enters as a digital balance via an anchor.
3. **Path payment (~5s, atomic)** -- `MXN -> USDC (hub) -> PHP`, settled on Stellar in one atomic transaction.
4. **Credited** -- the funds land in Maria's Corra wallet. A safe terminal state.
5. **Cash-out (optional)** -- Maria withdraws to local cash through an anchor.

Every step is verifiable on `stellar.expert` by a transaction hash. No engineering knowledge required to check it.

---

## Architecture

<img src="assets/architecture.png" alt="Corra architecture" width="100%" />

Five layers, with one rule: **the app never sees keys or the chain.** It talks only to the Corra API. Only the Stellar layer touches Stellar. Only adapters touch anchors. The core (saga + ledger) is agnostic to both and knows only interfaces.

```mermaid
flowchart TB
    App["Client App<br/>sender + recipient view"]
    subgraph Core["Corra Orchestrator (the brain)"]
        Q["Quote engine"]
        SAGA["Saga state machine"]
        ADP["Anchor Adapter layer (the moat)"]
        LED[("Ledger DB<br/>payments / legs / events")]
    end
    STL["Stellar layer<br/>keystore · trustlines · strict-receive path payment · market-maker · Horizon watcher"]
    ANC["Anchors<br/>MockAdapter (now) -> Etherfuse / MoneyGram (Phase 2)"]
    NET["Stellar testnet<br/>DEX liquidity · USDC hub"]

    App --> Core
    Q --> SAGA
    SAGA --> ADP
    SAGA --> LED
    ADP --> ANC
    Core --> STL
    STL --> NET
```

The **AnchorAdapter** is a single internal interface that every anchor (and the mock) implements. Adding a new corridor means writing a new adapter, not touching the core. That is what turns a one-off integration into an aggregator.

### Payment lifecycle

The orchestrator drives every transfer through an explicit, idempotent state machine. Only the on-chain leg is atomic; the cash-in and cash-out legs are slow and external, so the flow is a saga with compensation (refund) built in.

```mermaid
stateDiagram-v2
    [*] --> QUOTED
    QUOTED --> CASH_IN_PENDING: user confirms
    CASH_IN_PENDING --> CASH_IN_CONFIRMED: anchor credits funds
    CASH_IN_PENDING --> FAILED: timeout / rejected
    CASH_IN_CONFIRMED --> ONCHAIN_PENDING: submit strict-receive path payment
    ONCHAIN_PENDING --> CREDITED: settles (~5s, atomic)
    ONCHAIN_PENDING --> REFUNDING: no route / tx fails
    REFUNDING --> QUOTED: sender refunded
    CREDITED --> WITHDRAW_PENDING: recipient cashes out
    CREDITED --> [*]: funds in recipient wallet (safe terminal)
    WITHDRAW_PENDING --> COMPLETED
    FAILED --> [*]
    COMPLETED --> [*]
```

Full design notes are published in [`/docs`](docs):

| Doc | What's inside |
|---|---|
| [Architecture](docs/architecture.md) | The five layers, the golden rule, and why the adapter layer is the moat. |
| [Flows](docs/flows.md) | The happy path and every failure branch as explicit saga sequences. |
| [Contracts](docs/contracts.md) | The TypeScript type boundaries that isolate the core from anchors and the chain. |
| [Ledger](docs/ledger.md) | The Postgres schema: saga state, payment legs, and the append-only event log. |
| [API](docs/api.md) | The `/quote` and `/confirm` HTTP surface the client app talks to. |
| [Testing](docs/testing.md) | How each leg and failure path is verified, end to end. |
