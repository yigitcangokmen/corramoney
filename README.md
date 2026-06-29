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
