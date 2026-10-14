# Corra: API Surface (Orchestrator)

> REST surface for `services/orchestrator`. The app talks only to this surface. **The orchestrator never holds a user's key**: it receives a transaction the sender already signed in their own wallet, and its only powers over that blob are to submit it or not. It does hold two keys of its own: the fee-and-sponsor account, which signs only fee-bump envelopes and sponsorship setup transactions, and Corra's SEP-10 client_domain `SIGNING_KEY`, which co-signs only sequence-0 login challenges. Neither can sign for a user or move user value. Types come from [contracts](contracts.md).
> JSON over HTTPS. Money fields are **string decimals** (no bigint on the wire) plus an asset code.

## Overview
- **Auth:** none. No route takes a session token or API key. Abuse is bounded by per-IP rate limits on `/quote`, `/setup` and `/sep10/client-domain` (see `429 RATE_LIMITED` below). The anchor callback is authenticated by a signature from the anchor's `SIGNING_KEY` (see below), not by a shared secret of ours.
- **Idempotency:** the `Idempotency-Key` header is required on `/confirm` and `/resign`, so a retry yields the same result with no double processing.
- **Error model:** `{ "error": { "code": "OVER_SENDMAX", "message": "...", "retriable": true } }` plus the appropriate HTTP code.
- **Money wire format:** `{ "amount": "3500.00", "asset": "TESTMXN" }`.

---

## POST /quote
Produces a strict-receive quote. No money moves.

`/quote` returns the strict-receive route from path-finding and the `maxSend` cap the sender will be asked to sign. It does not request the anchor's SEP-38 quote.

**Who requests the SEP-38 firm quote, and why not the orchestrator.** A SEP-38 firm quote is bound to the sender's SEP-10 session. That session belongs to the sender's browser and never reaches Corra: holding it would let Corra start deposits or withdrawals at the anchor on the sender's behalf. So the browser requests the firm quote for exactly the cap (rounded up to whole centavos) through the wallet SDK, shows its id and expiry, and hands `{ id, expiresAt }` to `/confirm`, which records it on the payment unchanged. The SEP-24 deposit is then opened with that `quote_id`.

```jsonc
// req
{ "corridor": { "from": "MX/MXN", "to": "PH/PHP" },
  "destAmount": { "amount": "11210.00", "asset": "TESTPHP" } }
// 200
{ "id": "qt_...", "mode": "strict_receive",
  "source": { "amount": "3500.00", "asset": "TESTMXN" },
  "dest":   { "amount": "11210.00", "asset": "TESTPHP" },
  "path": ["TESTMXN","USDC","TESTPHP"],
  "maxSend": { "amount": "3552.50", "asset": "TESTMXN" },
  "slippageBps": 150, "expiresAt": 1750000000000 }
```
- `422 NO_PATH`: no liquidity or route ([flows](flows.md) section 3).

> **Where the corridor rate comes from, stated plainly.** On testnet no anchor quotes MXN or PHP, so the `TESTMXN -> USDC -> TESTPHP` rate is read from orderbooks a team-run market-maker seeds, via the SDK's path-finding. v1 demonstrates routing, ordering and execution under a cap the sender signed. It does not demonstrate price discovery.

## POST /confirm
Accepts the **signed transaction** and starts the saga. **The `Idempotency-Key` header is required.**

The sender's browser builds the strict-receive path payment with the `maxSend` cap, a 30-minute `maxTime` and a `minSeqNum` precondition (CAP-21), signs it in their own wallet, and hands the orchestrator the signed XDR. Account setup (sponsored creation and trustlines, CAP-33) is completed and confirmed **before** this call. Every payment is signed exactly once. A first-time sender approves three wallet prompts in total: the anchor login (a SEP-10 challenge, sequence 0, never submitted), the account setup, and the payment. A returning sender with a live anchor session and existing trustlines approves one: the payment.

```jsonc
// req
{ "quoteId": "qt_...", "sender": "G_DIEGO", "recipient": "G_MARIA",
  "signedXdr": "AAAAAg...",
  "anchorQuote": { "id": "12d499cb-...", "expiresAt": 1791811446816 } }   // optional, recorded unchanged
// 201
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "SIGNED",
  "maxTime": 1750000000000,
  "quote": { ... }, "legs": [ ... ], "createdAt": 1750000000000 }
```
- `409 QUOTE_EXPIRED`: TTL expired, so call `/quote` again.
- `422 UNBOUND_TRANSACTION`: the submitted XDR's destination, destination asset, destination amount or `sendMax` does not match the quote, or its preconditions are not the ones Corra builds (sequence window of 100, `maxTime` between 10 and 30 minutes away, no memo, fee 0, one signature). The orchestrator refuses a blob it cannot fully account for.
- `200` on a replay: the same `Idempotency-Key` for the same request returns the **same** payment; it does not create a new one.
- `409 IDEMPOTENCY_KEY_REUSED`: the same key for a different request.
- `409 QUOTE_USED`: the quote already backs a payment.
- `409 DUPLICATE_TRANSACTION`: the signed transaction already backs another payment, or is already on chain.
- `409 PAYMENT_IN_PROGRESS`: another payment of this sender is being settled. A payment of the sender still waiting for cash-in is expired as superseded instead.
- `429 RATE_LIMITED`: `/quote`, `/setup` and `/sep10/client-domain` are rate limited per IP (`/setup` also per account and globally, because the sponsor pays real reserves).

## GET /payments/:id
Payment plus legs plus timeline. `:id` is the internal id (`pmt_...`) or the public id (`CORRA-XXXXXX`).

When the payment is `CREDITED`, `legs` also holds a `cash_out` leg. It is written when the mock payout handler acknowledges (`createMockPayout` in [`saga.ts`](../packages/settlement-saga/src/saga.ts)), and its `externalRef` is the handler's reference (`mock-payout:CORRA-...`). If the handler fails, the payment stays `ONCHAIN` and the next reconcile pass asks again.

```jsonc
// 200
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "state": "CREDITED",
  "source": {...}, "dest": {...},
  "supersedesId": null,
  "legs": [
    { "kind": "cash_in", "anchorId": "sep24-anchor", "status": "CONFIRMED" },
    { "kind": "onchain", "txHash": "abc...", "status": "CONFIRMED" },
    { "kind": "cash_out", "externalRef": "mock-payout:CORRA-7QF3", "status": "CONFIRMED" }
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
Opens a **new** saga to replace a terminal one. Re-signing never revives an `EXPIRED`, `CAP_EXCEEDED` or `FAILED` payment. If the old payment's cash-in already landed, the new one counts it: no second deposit is needed.

```jsonc
// req
{ "supersedesId": "pmt_...", "quoteId": "qt_...", "signedXdr": "AAAAAg..." }
// 201  -> a new pmt_... whose supersedesId points at the old one
```
- `409 NOT_RESIGNABLE` if the referenced payment is not in `EXPIRED`, `CAP_EXCEEDED` or `FAILED`.

## POST /callbacks/sep24
Anchor -> orchestrator, on cash-in.

- **Signature verification:** the anchor signs the callback with the `SIGNING_KEY` published in its `stellar.toml`, sending `Signature: t=<timestamp>, s=<base64 signature>`. The orchestrator verifies that signature and the timestamp's freshness. There is one scheme, the standard one; we do not carry a per-anchor secret.
- **The callback is a trigger, never an authority.** Before advancing to `CASH_IN`, the orchestrator independently confirms from chain state that the deposit actually credited the sender's account. A forged, stale or replayed callback cannot cause a submission.
- **Dedupe:** `legs UNIQUE(anchor_id, external_ref)` makes a repeated callback a no-op.
- Always return a fast `200` (do not trigger the anchor's retry); processing is idempotent.

```jsonc
// 200
{ "ok": true }
```
- `401 BAD_SIGNATURE`: the signature is missing, does not verify, or is stale.

## POST /payments/:id/cash-in
The browser reports the anchor's SEP-24 transaction id, so the callback can be matched to the payment. Then the payment is reconciled once. `{ "ref": "<sep24 transaction id>" }`.

## POST /setup
Returns a sponsored setup transaction (CAP-33: create the account with 0 XLM, open one or two corridor trustlines), already signed by the fee-and-sponsor account. The sender co-signs and submits it. `{ "account": "G...", "trust": ["MXN"] }`. Rate limited per IP, per account and globally.

## POST /sep10/client-domain
Co-signs the anchor's SEP-10 challenge with Corra's client_domain `SIGNING_KEY`, so the anchor attributes the session to Corra. Refuses anything that is not a sequence-0 challenge from the anchor's own signing key. Rate limited per IP. Corra's `SIGNING_KEY` is published at `GET /.well-known/stellar.toml`.

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
