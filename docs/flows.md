# Corra: Flows (happy + failure paths)

> Concrete sequences for the saga. There is one happy path; the failure paths are handled separately (no silent failures, every error transitions to a state). See also [contracts](contracts.md) and [ledger](ledger.md).

## 1. Happy path (Diego MX -> Maria PH)

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender App
    participant O as Orchestrator
    participant L as Ledger
    participant K as Stellar
    participant A as Anchor
    participant X as Stellar testnet

    S->>O: POST /quote (dest = ₱11,210)
    O->>X: findPathStrictReceive
    X-->>O: path [MXN,USDC,PHP] + estSource
    O->>K: buildStrictReceive (unsigned XDR, sendMax +1.5%, timebound)
    O-->>S: Quote + UNSIGNED XDR (source MXN 3,500 · TTL 30s)
    Note over S: signs locally. The key never leaves the client.
    S->>O: POST /confirm (quoteId, signed XDR, idemKey)
    O->>L: payments(SIGNED) + event
    O->>K: preflight ensureAccount/ensureTrustline (sender, recipient)
    O->>A: initiateDeposit(sender, TEST_MXN)
    A-->>O: ref (PENDING)
    O->>L: CASH_IN_PENDING
    A-->>O: webhook deposit CONFIRMED
    O->>L: CASH_IN_CONFIRMED
    O->>K: submitSigned(XDR)
    K->>X: path payment tx
    X-->>K: SUCCESS (atomic ~3s)
    O->>L: ONCHAIN -> CREDITED (+ event)
    O-->>S: GET /payments/:id -> CREDITED (Maria received it)
    Note over S,X: Funds are in Maria's wallet: safe terminal state
    Note over O: Corra never held a key at any point
```

## 2. Failure: over-sendmax (exchange rate moved)

After cash-in, the market moves; the actual source cost exceeds `sendMax` -> the tx is rejected -> **refund** -> re-quote. The sender's funds are not lost.

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender App
    participant O as Orchestrator
    participant L as Ledger
    participant K as Stellar
    participant A as Anchor
    participant X as Stellar testnet

    Note over O,L: ...CASH_IN_CONFIRMED (Diego's TEST_MXN is ready)
    O->>K: submitSigned(XDR)
    K->>X: path payment tx
    X-->>K: op_over_sendmax (cost > sendMax)
    O->>L: ONCHAIN_PENDING -> REFUNDING (+ event: reason)
    O->>A: refund initiateWithdraw(sender, TEST_MXN)
    A-->>O: refund CONFIRMED
    O->>L: REFUNDING -> QUOTED
    O-->>S: 409 "rate updated, get a fresh quote"
    S->>O: POST /quote (again)
```

## 3. Failure: no route / insufficient liquidity

If market-maker depth is insufficient, no path is found. This error is caught at the quote stage **before confirm** -> cash-in never starts (the cleanest failure).

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender App
    participant O as Orchestrator
    participant X as Stellar testnet

    S->>O: POST /quote (dest = ₱X)
    O->>X: findPathStrictReceive
    X-->>O: no path / insufficient depth
    O-->>S: 422 "this amount is not supported right now"
    Note over O,X: No funds moved. The demo cap (≤ MXN 50k) prevents this in practice (R1).
```

## 4. Failure: webhook loss -> reconcile (tick)

If the anchor webhook never arrives, the payment is stuck in PENDING. The `tick` job pulls the true status from Horizon/adapter and advances it. **At-least-once delivery, exactly-once effect.**

```mermaid
sequenceDiagram
    autonumber
    participant T as tick (cron)
    participant O as Orchestrator
    participant L as Ledger
    participant A as Anchor
    participant X as Stellar testnet

    Note over L: payment stuck in CASH_IN_PENDING for >Xs (webhook did not arrive)
    T->>O: tick(paymentId)
    O->>A: status(ref)
    A-->>O: CONFIRMED
    O->>L: FOR UPDATE -> transition allowed? -> CASH_IN_CONFIRMED (event seq+1)
    Note over O,L: If a late duplicate webhook arrives afterward:<br/>UNIQUE(payment_id,seq) conflicts -> no-op
    O->>X: submitSigned(XDR) ... (flow continues)
```

## 5. Failure: the signed transaction expired

Signing happens before cash-in, so a slow cash-in can outlive the timebound. The transaction dies safely and the sender re-signs. This is the cost of not holding a key, and it is funded rather than hidden.

```mermaid
sequenceDiagram
    autonumber
    participant S as Sender App
    participant O as Orchestrator
    participant L as Ledger
    participant K as Stellar
    participant X as Stellar testnet

    Note over O,L: ...CASH_IN_CONFIRMED, but later than the timebound allowed
    O->>K: submitSigned(XDR)
    K->>X: path payment tx
    X-->>K: tx_too_late
    O->>L: ONCHAIN_PENDING -> EXPIRED (+ event: reason)
    O-->>S: 409 "signed transaction expired, please sign again"
    S->>O: POST /quote (fresh XDR to sign)
    Note over O,X: No funds moved on-chain. The cash-in balance stays with the sender.
```

## Summary
- **Single atomic point:** the path payment (third leg). Everything before and after is saga.
- **Every failure transitions to a state:** over-sendmax -> REFUNDING -> QUOTED, no-path -> 422 at quote, webhook-loss -> tick reconcile, expired timebound -> EXPIRED -> re-sign.
- **Funds never evaporate:** either refunded to the sender, or in the recipient's wallet (CREDITED is the safe terminal state).
