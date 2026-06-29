# Corra: API Surface (Orchestrator)

> REST surface for `services/orchestrator`. The app talks only to this surface; it never sees keys or the chain. Types come from [contracts](contracts.md).
> JSON over HTTPS. Money fields are **string decimals** (no bigint on the wire) plus an asset code.

## Overview
- **Auth (PoC):** Short-lived session token (Bearer) for app <-> orchestrator. Adapter signature verification for webhooks (see below).
- **Idempotency:** The `Idempotency-Key` header is required on mutation endpoints, so a retry yields the same result with no double processing.
- **Error model:** `{ "error": { "code": "OVER_SENDMAX", "message": "...", "retriable": true } }` plus the appropriate HTTP code.
- **Money wire format:** `{ "amount": "3500.00", "asset": "TEST_MXN" }`.

---

## POST /quote
Produces a strict-receive quote. No money moves.

```jsonc
// req
{ "corridor": { "from": "MX/MXN", "to": "PH/PHP" },
  "destAmount": { "amount": "11210.00", "asset": "TEST_PHP" } }
// 200
{ "id": "qt_...", "mode": "strict_receive",
  "source": { "amount": "3500.00", "asset": "TEST_MXN" },
  "dest":   { "amount": "11210.00", "asset": "TEST_PHP" },
  "path": ["TEST_MXN","USDC","TEST_PHP"],
  "maxSend": { "amount": "3552.50", "asset": "TEST_MXN" },
  "slippageBps": 150, "expiresAt": 1750000000000 }
```
- `422 NO_PATH`: no liquidity or route ([flows](flows.md) section 3).

## POST /confirm
Turns a quote into a payment and starts the saga. **The Idempotency-Key header is required.**

```jsonc
// req
{ "quoteId": "qt_...", "sender": "G_DIEGO", "recipient": "G_MARIA" }
// 201
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "CASH_IN_PENDING",
  "quote": { ... }, "legs": [ ... ], "createdAt": 1750000000000 }
```
- `409 QUOTE_EXPIRED`: TTL expired, so call `/quote` again.
- `409 IDEMPOTENT_REPLAY` behavior: the same key returns the **same** payment (it does not create a new one).

## GET /payments/:id
Payment plus legs plus timeline (the 5-step UI reads this).

```jsonc
// 200
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "CREDITED",
  "source": {...}, "dest": {...},
  "legs": [
    { "kind": "cash_in", "adapterId": "mock", "status": "CONFIRMED" },
    { "kind": "onchain", "txHash": "abc...", "status": "CONFIRMED" }
  ],
  "events": [
    { "seq": 1, "type": "QUOTED", "at": "..." },
    { "seq": 2, "type": "CASH_IN_CONFIRMED", "at": "..." },
    { "seq": 3, "type": "CREDITED", "at": "...", "data": { "txHash": "abc..." } }
  ] }
```

## GET /payments/:id/events  *(live)*
Server-Sent Events stream that reflects the UI steps live. Fallback: 1.5s polling of `GET /payments/:id`.

```
event: state
data: {"seq":3,"type":"CREDITED","txHash":"abc..."}
```

## POST /payments/:id/withdraw
`CREDITED -> WITHDRAW_PENDING` (optional cash-out). Async; returns `202`, and the result arrives via an event.
- `409` if the state is not `CREDITED`. A double withdraw is impossible thanks to `legs UNIQUE(payment_id,'cash_out')` (risks R6).

## POST /webhooks/:adapterId
Anchor -> orchestrator. The adapter normalizes via `parseEvent`, and the saga advances via `onEvent`.
- **Signature verification:** each adapter uses its own scheme (HMAC or secret header). An unverified request returns `401`.
- **Dedupe:** `legs UNIQUE(adapter_id, external_ref)` makes a repeated webhook a no-op.
- Always return a fast `200` (do not trigger the anchor's retry); processing is idempotent.

```jsonc
// req (adapter-specific, parseEvent normalizes it)
{ "ref": "dep_...", "type": "deposit.completed", ... }
// 200
{ "ok": true }
```

---

## Endpoint <-> saga mapping
| Endpoint | Saga ([contracts](contracts.md)) | State effect |
|---|---|---|
| POST /quote | `saga.quote()` | none |
| POST /confirm | `saga.confirm()` | -> QUOTED -> CASH_IN_PENDING |
| POST /webhooks/:id | `saga.onEvent()` | advances PENDING states |
| POST /payments/:id/withdraw | `saga.withdraw()` | CREDITED -> WITHDRAW_PENDING |
| (cron) | `saga.tick()` | reconcile/poll fallback |

> Reconcile is not an endpoint; it is a background worker that guards against lost webhooks ([flows](flows.md) section 4).
