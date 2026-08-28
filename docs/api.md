# Corra: API Surface (Orchestrator)

> REST surface for `services/orchestrator`. The app talks only to this surface. **The orchestrator never holds a user's key**: it receives a transaction the sender already signed in their own wallet, and its only powers over that blob are to submit it or not. It does hold one key of its own, the fee-and-sponsor account, which signs only fee-bump envelopes and `BeginSponsoringFutureReserves` and can move no user value. Types come from [contracts](contracts.md).
> JSON over HTTPS. Money fields are **string decimals** (no bigint on the wire) plus an asset code.

## Overview
- **Auth:** short-lived session token (Bearer) for app <-> orchestrator. The anchor callback is authenticated by the anchor's own SEP-24 signature (see below), not by a shared secret of ours.
- **Idempotency:** the `Idempotency-Key` header is required on mutation endpoints, so a retry yields the same result with no double processing.
- **Error model:** `{ "error": { "code": "OVER_SENDMAX", "message": "...", "retriable": true } }` plus the appropriate HTTP code.
- **Money wire format:** `{ "amount": "3500.00", "asset": "TEST_MXN" }`.

---

## POST /quote
Produces a strict-receive quote. No money moves.

The anchor's SEP-38 firm quote is requested for the leg that anchor can price, and its `id` and `expiresAt` are passed through **unchanged**; we add only the saga identifier and the `maxSend` cap the sender will be asked to sign. We do not invent a quote format.

```jsonc
// req
{ "corridor": { "from": "MX/MXN", "to": "PH/PHP" },
  "destAmount": { "amount": "11210.00", "asset": "TEST_PHP" } }
// 200
{ "id": "qt_...", "mode": "strict_receive",
  "anchorQuoteId": "...", "anchorQuoteExpiresAt": 1750000000000,
  "source": { "amount": "3500.00", "asset": "TEST_MXN" },
  "dest":   { "amount": "11210.00", "asset": "TEST_PHP" },
  "path": ["TEST_MXN","USDC","TEST_PHP"],
  "maxSend": { "amount": "3552.50", "asset": "TEST_MXN" },
  "slippageBps": 150, "expiresAt": 1750000000000 }
```
- `422 NO_PATH`: no liquidity or route ([flows](flows.md) section 3).

> **Where the corridor rate comes from, stated plainly.** On testnet no anchor quotes MXN or PHP, so the `TEST_MXN -> USDC -> TEST_PHP` rate is read from orderbooks a team-run market-maker seeds, via the SDK's path-finding. v1 demonstrates routing, ordering and execution under a cap the sender signed. It does not demonstrate price discovery.

## POST /confirm
Accepts the **signed transaction** and starts the saga. **The `Idempotency-Key` header is required.**

The sender's browser builds the strict-receive path payment with the `maxSend` cap, a 30-minute `maxTime` and a `minSeqNum` precondition (CAP-21), signs it in their own wallet, and hands the orchestrator the signed XDR. Account setup (sponsored creation and trustlines, CAP-15/CAP-33) is completed and confirmed **before** this call, so the sender signs twice in the flow: once for setup, once for the payment.

```jsonc
// req
{ "quoteId": "qt_...", "sender": "G_DIEGO", "recipient": "G_MARIA",
  "signedXdr": "AAAAAg..." }
// 201
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "SIGNED",
  "maxTime": 1750000000000,
  "quote": { ... }, "legs": [ ... ], "createdAt": 1750000000000 }
```
- `409 QUOTE_EXPIRED`: TTL expired, so call `/quote` again.
- `422 UNBOUND_TRANSACTION`: the submitted XDR's destination, destination asset, destination amount or `sendMax` does not match the quote. The orchestrator refuses a blob it cannot fully account for.
- `409 IDEMPOTENT_REPLAY`: the same key returns the **same** payment; it does not create a new one.

## GET /payments/:id
Payment plus legs plus timeline.

```jsonc
// 200
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "CREDITED",
  "source": {...}, "dest": {...},
  "supersedesId": null,
  "legs": [
    { "kind": "cash_in", "anchorId": "sep24-anchor", "status": "CONFIRMED" },
    { "kind": "onchain", "txHash": "abc...", "status": "CONFIRMED" }
  ],
  "events": [
    { "seq": 1, "type": "QUOTED", "at": "..." },
    { "seq": 2, "type": "SIGNED", "at": "..." },
    { "seq": 3, "type": "CASH_IN", "at": "..." },
    { "seq": 4, "type": "CREDITED", "at": "...", "data": { "txHash": "abc..." } }
  ] }
```

## GET /payments/:id/events  *(live)*
Server-Sent Events stream that reflects the UI steps live. Fallback: 1.5s polling of `GET /payments/:id`.

```
event: state
data: {"seq":4,"type":"CREDITED","txHash":"abc..."}
```

## POST /resign
Opens a **new** saga to replace a terminal one. Re-signing never revives an `EXPIRED` or `CAP_EXCEEDED` payment.

```jsonc
// req
{ "supersedesId": "pmt_...", "quoteId": "qt_...", "signedXdr": "AAAAAg..." }
// 201  -> a new pmt_... whose supersedesId points at the old one
```
- `409` if the referenced payment is not in `EXPIRED` or `CAP_EXCEEDED`.

## POST /callbacks/sep24
Anchor -> orchestrator, on cash-in.

- **Signature verification:** SEP-24 requires the anchor to sign the callback with the `SIGNING_KEY` published in its `stellar.toml`, sending `Signature: t=<timestamp>, s=<base64 signature>`. The orchestrator verifies that signature and the timestamp's freshness. There is one scheme, the standard one; we do not carry a per-anchor secret.
- **The callback is a trigger, never an authority.** Before advancing to `CASH_IN`, the orchestrator independently confirms from chain state that the deposit actually credited the sender's account. A forged, stale or replayed callback cannot cause a submission.
- **Dedupe:** `legs UNIQUE(anchor_id, external_ref)` makes a repeated callback a no-op.
- Always return a fast `200` (do not trigger the anchor's retry); processing is idempotent.

```jsonc
// 200
{ "ok": true }
```

---

## Endpoint <-> saga mapping
| Endpoint | Saga ([contracts](contracts.md)) | State effect |
|---|---|---|
| POST /quote | `saga.quote()` | none |
| POST /confirm | `saga.confirm()` | -> QUOTED -> SIGNED |
| POST /callbacks/sep24 | `saga.onCashIn()` | SIGNED -> CASH_IN, after chain confirmation |
| POST /resign | `saga.resign()` | new saga, `supersedesId` set |
| (reconciler) | `saga.reconcile()` | advances from chain state; creates no new state |

> Reconcile is not an endpoint. It runs over this instance's own pending payments only, reads the authoritative fact from the chain, and advances the saga to match ([flows](flows.md) section 4). Submission is safe to retry: Stellar consumes the sequence number on the first successful submission and rejects every later resubmission of the same signed blob.

**Not in v1.** There is no withdraw endpoint. The cash-out leg is a mock payout handler, so `CREDITED` means the recipient's testnet account holds the destination asset and the handler acknowledged, not that anyone received money. A real payout leg is Phase 2 and depends on a licensed anchor partner.
