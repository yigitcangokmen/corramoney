# Corra: API Surface (Orchestrator)

> REST surface for `services/orchestrator`. The app talks only to this surface. **The orchestrator never holds a user's key**: it receives a transaction the sender already signed in their own wallet, and its only powers over that blob are to submit it or not. It does hold keys of its own: the fee-and-sponsor key, the client_domain key, and five channel accounts that only source sponsored setups creating an account (fee and sequence only; no reserve, no value, never a signer). The fee-and-sponsor account signs only fee-bump envelopes (around one sender-signed path payment, or one user-signed, validated pool `submit`) and sponsorship setup transactions; Corra's SEP-10 client_domain `SIGNING_KEY` co-signs only sequence-0 login challenges. None can sign for a user or move user value. Types come from [contracts](contracts.md).
> JSON over HTTPS. Money fields are **string decimals** (no bigint on the wire) plus an asset code.

## Overview
- **Auth:** none. No route takes a session token or API key. Abuse is bounded by per-IP rate limits on `/quote`, `/setup`, `/sep10/client-domain`, `/deposits`, `/deposits/:id/link`, `/send`, `/pool/submit` and the `/accounts/:account/*` read routes (see `429 RATE_LIMITED` below). The anchor callback is authenticated by a signature from the anchor's `SIGNING_KEY` (see below), not by a shared secret of ours.
- **Idempotency:** the `Idempotency-Key` header is required on `/confirm`, `/resign`, `/send` and `/pool/submit`, so a retry yields the same result with no double processing.
- **Read routes:** `GET /accounts/:account/deposits`, `GET /accounts/:account/payments` and `GET /accounts/:account/pool-ops` are unauthenticated and rate limited per IP. They never return a signed blob or an idempotency key. Most of a payment row is chain data, but not all of it: the internal payment `id`, the `externalRef` and `anchorId` of a Phase 1 cash-in leg (the anchor's SEP-24 transaction id) and `quote.anchorQuoteId` (the SEP-38 quote id) are not on chain. Deposit rows (here and in `GET /deposits/:id`) carry the anchor's SEP-24 transaction id (`anchorRef`) and `moreInfoUrl`, which are not chain data, and that URL carries an anchor token that the test anchor's read-only more_info page accepts without expiry, so anyone holding the link can view that transaction's status (see [risks](risks.md) R21); the app shows it as a link only.
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

The sender's browser builds the strict-receive path payment with the `maxSend` cap, a 30-minute `maxTime` and a `minSeqNum` precondition (CAP-21), signs it in their own wallet, and hands the orchestrator the signed XDR. The transaction source is the sender's **payment account** (see `POST /setup`), at its current sequence + 100 with `minSeqNum` at its current sequence; the operation source is the sender, who is the only signer. Account setup (sponsored creation, trustlines and the payment account, CAP-33) is completed and confirmed **before** this call. Every payment is signed exactly once. A first-time sender approves three wallet prompts in total: the anchor login (a SEP-10 challenge, sequence 0, never submitted), the account setup, and the payment. A returning sender with a live anchor session and existing trustlines approves one: the payment.

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
- `422 UNBOUND_TRANSACTION`: the transaction source is not the sender's payment account (`source is not the sender's payment account: set up the account first if you have none`, also when the sender has none yet) or the operation source is not the sender, the submitted XDR's destination, destination asset, destination amount or `sendMax` does not match the quote, or its preconditions are not the ones Corra builds (sequence window of 100, `minTime` 0, `maxTime` between 10 and 30 minutes away, no memo, fee 0, one signature). The orchestrator refuses a blob it cannot fully account for.
- `200` on a replay: the same `Idempotency-Key` for the same request returns the **same** payment; it does not create a new one.
- `409 IDEMPOTENCY_KEY_REUSED`: the same key for a different request.
- `409 QUOTE_USED`: the quote already backs a payment.
- `409 DUPLICATE_TRANSACTION`: the signed transaction already backs another payment, or is already on chain.
- `409 PAYMENT_IN_PROGRESS`: another payment of this sender is being settled. A payment of the sender still waiting for cash-in is expired as superseded instead.
- `429 RATE_LIMITED`: `/quote`, `/setup` and `/sep10/client-domain` are rate limited per IP (`/setup` also globally, and per account for the account's own setup transaction, because the sponsor pays real reserves; a payment-account-only setup does not spend the account's token, so a stranger cannot lock the account out).

## GET /payments/:id
Payment plus legs plus timeline. `:id` is the internal id (`pmt_...`) or the public id (`CORRA-XXXXXX`).

`kind` is `cash_in` (Phase 1: signed first, paid in by an anchor deposit for this payment) or `balance` (paid from TESTMXN the sender already holds, see `POST /send`). A balance payment's `cash_in` leg is a marker: `CONFIRMED`, `externalRef` `balance:CORRA-...`, no `anchorId`. It records that no anchor deposit backs the payment.

When the payment is `CREDITED`, `legs` also holds a `cash_out` leg: `PENDING`, the destination amount, `anchorId`, no `externalRef`. `CREDITED` means the onchain leg landed and the destination amount is in the recipient's own account. The recipient's withdrawal at the anchor (see `POST /payments/:id/cash-out/submit`) fills the leg's `externalRef` (the anchor's SEP-24 withdrawal id) and `txHash` (the inner hash of the recipient's payment), and the leg turns `CONFIRMED` only from the anchor's signed `completed` callback plus that payment on chain. The payment's state stays `CREDITED` throughout; cash-out events are appended with `from = to = CREDITED`: `CASH_OUT_SUBMITTED {ref, txHash, maxTime}`, `CASH_OUT_ONCHAIN {ref, txHash, ledger}`, `CASH_OUT_FAILED {ref, txHash, reason: failed | rejected | expired, codes?}`, `CASH_OUT_ANCHOR_COMPLETED {ref, withdrawMemo, stellarTxId?, externalId?, moreInfoUrl?}`, `CASH_OUT_ANCHOR_FAILED {ref, anchorStatus, paid}`, `CASH_OUT_MISMATCH {ref, reason}`, `CASHED_OUT {ref, txHash, ledger, payout, moreInfoUrl}`. The `moreInfoUrl` in `CASH_OUT_ANCHOR_COMPLETED` and `CASHED_OUT` is served by the same unauthenticated read routes and carries an anchor token that the test anchor's read-only more_info page accepts without expiry, so anyone holding the link can view that withdrawal's status (R21). Phase 1 payments credited before this kept a `CONFIRMED` leg with `externalRef` `mock-payout:CORRA-...`; they are never cash-out candidates.

```jsonc
// 200
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "kind": "cash_in", "state": "CREDITED",
  "source": {...}, "dest": {...},
  "supersedesId": null,
  "legs": [
    { "kind": "cash_in", "anchorId": "sep24-anchor", "status": "CONFIRMED" },
    { "kind": "onchain", "txHash": "abc...", "status": "CONFIRMED" },
    { "kind": "cash_out", "anchorId": "corra-anchor", "status": "PENDING" }
  ],
  "events": [
    { "seq": 1, "type": "QUOTED", "at": "..." },
    { "seq": 2, "type": "SIGNED", "at": "..." },
    { "seq": 3, "type": "CASH_IN", "at": "..." },
    { "seq": 4, "type": "CREDITED", "at": "...", "data": { "txHash": "abc...", "ledger": 123 } }
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
- A re-signed balance payment is a balance send: the `/send` checks and rate limits apply (`429 RATE_LIMITED`), and it is submitted at once. A replay is never rate limited.

## POST /callbacks/sep24
Anchor -> orchestrator, on cash-in and on the recipient's cash-out.

- **Withdrawals** (`kind: "withdrawal"`) go to the payment whose `cash_out` leg holds the callback's reference, and nowhere else. `completed` is recorded as `CASH_OUT_ANCHOR_COMPLETED` only with the anchor's `withdraw_memo`; the leg turns `CONFIRMED` once the payment Corra recorded and submitted for the leg is on chain from the recipient to the anchor's distribution account, in TESTPHP, for exactly the leg amount, with that memo (and, when the callback names a `stellar_transaction_id`, that very transaction). Callback first or chain first, the reconciler finishes the join. `error`, `expired` and `refunded` append `CASH_OUT_ANCHOR_FAILED {anchorStatus, paid}` once per status and leave the leg as it is (`paid: false` also when the chain lookup failed; the app then reads the leg's later `CASH_OUT_ONCHAIN`). Nothing asks the anchor later, so a withdrawal's `completed`, `error`, `expired` or `refunded` is recorded before the answer: `200` once written, `503 CALLBACK_NOT_RECORDED` (retriable) when recording throws or takes over 10 s, for the anchor to resend (Anchor Platform 4.8.0 retries a non-2xx callback up to 3 times with backoff). Other callbacks get a fast `200`.

- **Dispatch:** every callback goes to both, independently: the payment whose `cash_in` leg holds the callback's reference, and the deposits (see `POST /deposits`). A payment holding a ref never hides a deposit's callback; both are triggers and the chain decides each. For deposits: the deposit linked to that reference; otherwise, for a `completed` callback, the deposit whose memo the anchor paid with: the memo of its `stellar_transaction_id` on chain, or, when the anchor reports no hash (Anchor Platform does not), its `deposit_memo` (hash, hex) when its `to` is that deposit's account.

- **Signature verification:** the anchor signs the callback with the `SIGNING_KEY` published in its `stellar.toml`, sending `Signature: t=<timestamp>, s=<base64 signature>`. The orchestrator verifies that signature and the timestamp's freshness. There is one scheme, the standard one; we do not carry a per-anchor secret.
- **Cash-in and deposit callbacks are triggers, never an authority.** Before advancing to `CASH_IN`, the orchestrator independently confirms from chain state that the deposit actually credited the sender's account. A forged, stale or replayed callback cannot cause a submission. A withdrawal's signed `completed` callback is different: it is one of the two required witnesses for the `cash_out` leg's `CONFIRMED` (see **Withdrawals** above).
- **Dedupe:** `legs UNIQUE(anchor_id, external_ref)` makes a repeated callback a no-op.
- Cash-in and deposit callbacks always get a fast `200` (do not trigger the anchor's retry); processing is idempotent. A withdrawal's `completed`, `error`, `expired` or `refunded` is awaited and may answer `503 CALLBACK_NOT_RECORDED` to trigger the retry (see **Withdrawals** above).

```jsonc
// 200
{ "ok": true }
```
- `401 BAD_SIGNATURE`: the signature is missing, does not verify, or is stale.

## POST /payments/:id/cash-in
The browser reports the anchor's SEP-24 transaction id, so the callback can be matched to the payment. Then the payment is reconciled once. `{ "ref": "<sep24 transaction id>" }`.

## POST /send
Pays from the TESTMXN the sender already holds (D1). **The `Idempotency-Key` header is required.** No anchor deposit is bound to it: the sender topped up earlier with `POST /deposits`, or holds the balance for any other reason.

The browser reads the sender's payment account's current sequence, builds the strict-receive payment for a fresh `/quote` as the payment account's next transaction, signs it once in the wallet, and posts it. The orchestrator checks it, creates the payment directly in `CASH_IN` (one write: `QUOTED`, `SIGNED`, `CASH_IN {source: 'balance', balance}`), answers `201`, and submits it through the same fee-bump as Phase 1. It usually settles in the next ledger.

Balance transaction shape (anything else is `422 UNBOUND_TRANSACTION`):

| Field | Value |
|---|---|
| envelope | v1 transaction, not a fee-bump |
| source | the sender's payment account |
| sequence | the payment account's current sequence + 1 |
| preconditions | time bounds only: `minTime` 0, `maxTime` within 6 minutes (5 minutes plus 60 s of clock slack); no `minSeqNum`, ledger bounds, sequence age or gap, extra signers |
| fee | `0` (Corra's fee-bump pays) |
| memo | none |
| operations | exactly one `pathPaymentStrictReceive` matching the quote, operation source the sender |
| signatures | exactly one, the sender's |

```jsonc
// req  (header Idempotency-Key: <uuid>)
{ "quoteId": "qt_...", "sender": "G_DIEGO", "recipient": "G_MARIA", "signedXdr": "AAAAAg..." }
// 201
{ "id": "pmt_...", "publicId": "CORRA-7QF3", "kind": "balance", "state": "CASH_IN",
  "legs": [ { "kind": "cash_in", "status": "CONFIRMED", "externalRef": "balance:CORRA-7QF3", "amount": { ... } } ], ... }
```
Refusals, in the order they are checked, all before anything is stored:
- `422 UNBOUND_TRANSACTION`: the blob is not the shape above or does not match the quote.
- `422 RECIPIENT_NO_TRUSTLINE`: the recipient cannot receive the destination asset.
- `409 DUPLICATE_TRANSACTION`: the signed transaction already backs a payment or is already on chain.
- `409 PAYMENT_IN_PROGRESS` (retriable): another payment of this sender is `CASH_IN` or `ONCHAIN`. The database enforces one balance payment in flight per sender too, so two concurrent sends end in one `201` and one `409`.
- `409 SIGNED_PAYMENT_WAITING` (retriable): a pre-signed payment of this sender is `SIGNED`, waiting for its cash-in. Its blob (payment account sequence + 100, `minSeqNum` at the sequence it was signed at) would stay valid after this one landed at sequence + 1, so both could land. Allowed again once the waiting payment is credited or expires (a new `/confirm` only adds another `SIGNED` payment).
- `429 RATE_LIMITED` (per account): counted only here, once the blob is proven to be the sender's, so requests that merely name an account cannot lock it out. The per-IP limit is checked before everything.
- `422 INSUFFICIENT_BALANCE` (retriable): the sender's spendable TESTMXN (balance minus selling liabilities) is below the quote's `maxSend`.
- `422 UNBOUND_TRANSACTION` "sequence is not the payment account's next": a stale blob, signed before another Corra payment or pool step of the sender used the payment account's next sequence. Sign again.
- `409 QUOTE_EXPIRED`, `409 QUOTE_USED`, `404 QUOTE_NOT_FOUND`, `409 IDEMPOTENCY_KEY_REUSED` (also when a `/confirm` key is replayed on `/send`, or the reverse), `429 RATE_LIMITED`.
- `200` on a replay with the same key and request. A replay is never rate limited.

Then: `ONCHAIN {txHash, ledger}`, and `CREDITED {txHash, ledger}` or `CAP_EXCEEDED` / `FAILED {txHash, ledger, codes}` (`ledger` when known; `op_underfunded` if the balance was spent in between), or `EXPIRED {reason}` when it never landed within `maxTime` plus 120 s. `/payments/:id/cash-in` on a balance payment answers `409 CASH_IN_ALREADY_LINKED`; `/resign` of a failed one requires a new balance blob.

A sender's `SIGNED` Phase 1 payment still waiting for cash-in is **not** superseded by a balance send; both stay valid. Not enforced: a balance send can spend TESTMXN that the `SIGNED` payment was waiting for, in which case that one lands `FAILED` (`op_underfunded`) or expires. The app shows a hint when this can happen.

## POST /payments/:id/cash-out/submit
The recipient's signed withdrawal payment for a `CREDITED` payment (D3). Body `{ "ref": "<the anchor's SEP-24 withdrawal id>", "signedXdr": "<base64, up to 4096 characters>" }`. The recipient's signature on the blob is what binds `ref` to the payment's cash-out leg; there is no separate start call.

| Field | Value |
|---|---|
| envelope | v1 transaction, not a fee-bump |
| source | the recipient's payment account (sequence its current + 1, no `minSeqNum`) |
| fee | `0` (Corra's fee-bump pays) |
| time bounds | `minTime` 0, `maxTime` within 6 minutes (5 minutes plus 60 s of clock slack); no other preconditions |
| memo | the anchor's `withdraw_memo` (id, text or hash) |
| operations | exactly one `payment`, operation source the recipient, destination the anchor's distribution account (`GCBZ...UKI4`; never a muxed `M...`), TESTPHP from Corra's issuer, exactly the leg amount |
| signatures | exactly one, the recipient's |

The leg's `txHash` (the inner hash) is written before the network call. Refusals, in order, all before any write:
- `404 PAYMENT_NOT_FOUND`; `409 CASH_OUT_NOT_READY` (retriable): not `CREDITED` yet; `409 ALREADY_CASHED_OUT`: the leg is `CONFIRMED` (or a Phase 1 `mock-payout:` leg); `422 CASH_OUT_NOT_AVAILABLE`: the payment is not in TESTPHP.
- `422 UNBOUND_TRANSACTION`: the blob is not the shape above (its message names the rule).
- the same blob again with the same `ref` is a replay: `200` with `replay: true` (sent again if it never landed), no rate-limit token, also after its `maxTime` (the recorded blob's time window is not checked again; the chain decides); with another `ref`, `409 CASH_OUT_REF_MISMATCH`.
- another blob while one is recorded: `409 CASH_OUT_ALREADY_PAID` if that one landed, else `409 CASH_OUT_IN_PROGRESS` (retriable) until the reconciler clears it (landed failed, or not on chain 120 s after its `maxTime`).
- `409 CASH_OUT_ANCHOR_STOPPED`: the anchor already stopped this `ref` (a signed `error`/`expired`/`refunded` callback); start a new withdrawal.
- `409 CASH_OUT_ALREADY_PAID`: the anchor already completed this `ref` (a signed `completed` callback); a second payment for it would be lost.
- `409 CASH_OUT_ATTEMPTS`: three earlier blobs for this leg landed failed (the sponsor paid their fees).
- `422 UNBOUND_TRANSACTION` "source is not the recipient's payment account..."; `429 RATE_LIMITED`: 5 new withdrawal payments per IP per 10 minutes, counted only for a blob proven to be the recipient's; `422 INSUFFICIENT_BALANCE` (retriable); `422 UNBOUND_TRANSACTION` "sequence is not the payment account's next".
- recording: `409 CASH_OUT_REF_TAKEN` (the ref belongs to another leg of this anchor), `409 DUPLICATE_TRANSACTION` (one chain payment backs at most one cash-out).
- the network: `422 CASH_OUT_FAILED` (retriable): it can never land (`tx_too_late` on a first send, or a first send refused with a result code and not on chain), or it landed failed (`codes` in the message); the leg's `txHash` is cleared, the `ref` kept; sign again. `422 REFUSED`: the sponsor refused to fee-bump it. `502 SEND_FAILED` (retriable): no answer, or an error answer (`tx_bad_seq`, a timeout, any refusal of a replay, `tx_too_late` included) while the chain does not show the blob yet; the record stays, replay the same body, and the reconciler clears it once it is not on chain 120 s after its `maxTime`. Before clearing on an error answer Corra asks the chain: a blob found landed is recorded and answered `200`.

```jsonc
// 200
{ "txHash": "<fee-bump envelope hash>", "ledger": 5908461, "replay": false, "payment": { "state": "CREDITED", "legs": [...], "events": [...] } }
```

## GET /accounts/:account/payments
`?role=sender|recipient` (default `sender`), `?limit=1..100` (default 50). Newest first, both kinds, without events, signed blobs or idempotency keys.

```jsonc
// 200
{ "payments": [ { "id": "pmt_...", "kind": "balance", "state": "CREDITED", ... }, ... ] }
```
- `400 BAD_REQUEST`: not a `G...` account, another role, or a limit outside 1..100.

## POST /deposits
Records a SEP-24 deposit into the user's own account (D1), **not bound to any payment**. The balance itself is read from chain; this row only links the anchor's record to a credit. `{ "account": "G...", "amount": "2000.00" }`: MXN, up to 2 decimals, 1.00 to 1,000,000.00. The account must already trust TESTMXN.

The response's `memo` (base64 of sha256 of the deposit id) is the hash memo the browser passes to the anchor's SEP-24 deposit (`memo_type: hash`), without a `quote_id`.

```jsonc
// 201
{ "id": "dep_...", "account": "G...", "anchorRef": null, "moreInfoUrl": null, "memo": "q1w2...=",
  "requested": { "amount": "2000.0000000", "asset": "TESTMXN", "issuer": "G..." }, "credited": null, "txHash": null,
  "status": "PENDING", "matchedBy": null, "reason": null, "createdAt": 1750000000000, "updatedAt": 1750000000000 }
```
- `400 BAD_REQUEST`: not a `G...` account, or the amount is not a string in range with at most 2 decimals.
- `422 ACCOUNT_NOT_READY` (retriable): the account does not exist or has no TESTMXN trustline; run `/setup` first.
- `429 RATE_LIMITED`: per IP and per account (3 per 10 minutes). The account is an unauthenticated body field and nothing proves the caller owns it: a third party can use up an account's 3-per-10-minutes budget and block its deposits for 10 minutes. See [risks.md](risks.md) R24 (the request bounds) and R14 (no login).

## POST /deposits/:id/link
The browser reports the anchor's SEP-24 transaction id. `{ "ref": "<sep24 transaction id>" }` (`[A-Za-z0-9._:-]`, up to 128). Write-once: the same ref again is a no-op; any other field in the body is ignored. Then the chain is checked once. Returns the deposit.
- `404 DEPOSIT_NOT_FOUND`; `409 DEPOSIT_ALREADY_LINKED`: this deposit holds another ref, or the ref belongs to another deposit; `429 RATE_LIMITED`.

## GET /deposits/:id
The deposit, as above. Reads the database only, so the app can poll it. `404 DEPOSIT_NOT_FOUND`.

## GET /accounts/:account/deposits
`?limit=1..100` (default 50). `{ "deposits": [ ... ] }`, newest first.

### Deposit matching
- **Tiers** (`matchedBy`): `ref` (the anchor's signed callback names the linked reference), `callback_tx` (the signed callback names the deposit's memo, through its `stellar_transaction_id` on chain or its `deposit_memo`, in both cases only when its `to` is the deposit's account, when the link was lost or someone else linked the deposit to a wrong ref; the anchor's ref is then bound to this deposit), `chain` (the reconciler, or a link, found the credit on its own).
- **`CONFIRMED` only from a chain credit:** a payment of TESTMXN from the anchor's distribution account to the account, carrying the deposit's memo. A callback alone never confirms anything. `credited` is the sum of every such credit; `txHash` the latest one. A sum short of `requested` is recorded on the `PENDING` row (both figures shown) and checked again, since a later credit with the memo may complete it; at 24 h it confirms as it is, `reason 'short credit'`.
- **Ref binding:** a completed signed callback that names an open deposit by its memo and its `to` account binds its ref at once, even before the credit is visible, replacing any ref linked earlier. On a confirmed deposit, a callback rebinds only when its `stellar_transaction_id` is the deposit's `txHash`, or the deposit has no ref yet. A callback whose `to` is another account writes nothing to the deposit, whatever ref it carries. `CONFIRMED` still needs the chain credit.
- **`moreInfoUrl`** comes only from the anchor's signed callback, never from a client.
- **Expiry:** no credit within 24 h -> `EXPIRED`, `reason 'no credit within 24h'`. An expired deposit is re-checked hourly for 7 days; a late credit flips it to `CONFIRMED` with `reason 'credited after expiry'` (`'short credit after expiry'` when short).
- **Cadence:** a `PENDING` deposit is checked at most every 30 s, and at most 25 deposits per reconcile pass. `updatedAt` is the last change or the last check.

## POST /pool/submit
Moves TESTMXN into or out of Corra's Blend lending pool (D2) with one user signature; Corra validates the transaction, pays its fee (CAP-15 fee-bump through Stellar RPC) and sends it. **The `Idempotency-Key` header is required** (up to 128 characters). Body `{ "signedXdr": "AAAAAg..." }` (up to 16,384 characters). The position itself is read from the pool contract (`get_positions`), not from Corra; this route keeps a record for History and evidence. The pool ids come from `packages/shared/src/testnet-blend.ts` (written by `pnpm deploy-pool`).

The browser builds the transaction with blend-sdk, simulates it at RPC (which adds the auth entry and the resources) and signs it once. Accepted shape, checked in this order (anything else is `422 REFUSED` with the rule's message):

| # | Rule |
|---|---|
| 1-2 | a plain v1 transaction, not a fee-bump |
| 3 | the transaction source (the signer's payment account) is a `G...` account (no muxed `M...`) and not Corra's sponsor |
| 4-6 | exactly one operation: a contract call whose operation source is the signer: set, a plain `G...` account, other than the transaction source and the sponsor |
| 7-8 | the contract is Corra's pool and the function is `submit` |
| 9 | `from`, `spender` and `to` are all the signer |
| 10-11 | exactly one request, a `{address, amount, request_type}` map |
| 12-14 | `request_type` 0 (supply) or 1 (withdraw), `address` the pool asset, `0 < amount <= 1,000,000` units |
| 15 | exactly one auth entry, with source-account credentials (the transaction signature authorizes it; no address-credential entry), rooted at this very `submit` call |
| 16 | supply: exactly one sub-invocation, the asset's `transfer(signer, pool, amount)`; withdraw: none |
| 17 | Soroban data present, resource fee at most 0.5 XLM (`MAX_SOROBAN_RESOURCE_FEE`) |
| 18 | the inner fee is the resource fee plus 0..100 stroops (Corra's fee-bump bids the inclusion fee) |
| 19 | no footprint key names the sponsor (its account, a trustline of it, or contract data keyed by its address) |
| 20-21 | no memo; time bounds `minTime` 0, `maxTime` within the next 6 minutes; no other preconditions |
| 22 | exactly one signature, the signer's (the operation source's) |
| - | after the rules: the transaction source is a payment account of the signer (its own Horizon record: sponsored by Corra, master weight 0, the signer its only signer), else `transaction source is not the signer's payment account` |

Not checked on purpose: the sequence (the network refuses a stale one) and the balance (the pool fails the transaction; the browser simulated it first).

```jsonc
// req  (header Idempotency-Key: <uuid>)
{ "signedXdr": "AAAAAg..." }
// 201 (200 on a replay with the same key and blob)
{ "id": "pop_...", "account": "G...", "poolId": "C...", "assetSac": "C...", "kind": "supply",
  "amount": { "amount": "20.0000000", "asset": "TESTMXN", "issuer": "G..." }, "innerHash": "3a9e...", "txHash": "3151...",
  "status": "SUCCESS", "resultCode": null, "resourceFee": "720532", "ledger": 5901040, "createdAt": 1764000000000, "updatedAt": 1764000000000 }
```
`status` is `SUCCESS`, `FAILED` (with `resultCode`, e.g. `tx_bad_seq` before any ledger, `op_invoke_host_function_trapped` in one) or `SUBMITTED` when the network has not answered within 30 s; the reconciler settles a `SUBMITTED` row from the chain by its fee-bump hash, or marks it `FAILED not_found` after 10 minutes (the signature died after 6). When the RPC no longer holds the ledgers since the submit (Corra was down longer than its retention), it marks it `FAILED unknown` instead: it may have landed, so the app says to check the position. `txHash` is the fee-bump envelope, `innerHash` the user's transaction.
- `200`: a replay with the same key and the same blob, never rate limited, even after the signed window closed. If the row is still `SUBMITTED`, the network does not know it and its window is open, Corra sends it again (same fee-bump hash) and answers with the outcome.
- `400 IDEMPOTENCY_KEY_REQUIRED`, `400 BAD_REQUEST` (no or oversized `signedXdr`).
- `409 IDEMPOTENCY_KEY_REUSED`: the key was used for another blob. `409 DUPLICATE_TRANSACTION`: the blob is already recorded under another key; it takes no account or global token.
- `422 REFUSED`: not the shape above; the message names the rule. Nothing is stored and no account token is taken.
- `429 RATE_LIMITED`: 30 per IP and 10 per account per 10 minutes, 300 per day in total (bounds the sponsor's spend at about 150 XLM a day). The account limit counts only a blob proven to be that account's.
- `502 SEND_FAILED` (retriable): the send to Stellar RPC failed before the node answered. The row stays `SUBMITTED`; retry with the same key and blob.
- `503 POOL_NOT_CONFIGURED` (retriable): no pool is deployed on this network (`testnet-blend.ts` is `null`).

## GET /accounts/:account/pool-ops
`?limit=1..100` (default 50). `{ "ops": [ ... ] }`, newest first, without idempotency keys or signed blobs. `400 BAD_REQUEST` for a bad account or limit, `429` per IP, `503 POOL_NOT_CONFIGURED` without a pool. There is no `GET /pool-ops/:id`: the app polls this list.

## POST /setup
Returns the sponsored setup transactions the account still needs (CAP-33), each already signed by the fee-and-sponsor account. The transaction source is one of Corra's channel accounts for a transaction that creates an account (signed by that channel too), otherwise the sponsor; the sponsor still pays every reserve. With all five channels leased (each for up to 315 s, or until its setups land), both are sponsor-sourced as in Phase 1. `{ "account": "G...", "trust": ["MXN"], "paymentAccount": "G..." }` (`paymentAccount` optional: a fresh key from the browser, different from `account`).

```jsonc
// 200
{ "paymentAccountXdr": "AAAA...",   // only if the account has no payment account and `paymentAccount` was sent
  "xdr": "AAAA..." }                // only if the account does not exist or lacks a requested trustline
```
- `paymentAccountXdr`: the sender's **payment account**, the transaction source of every payment and pool step the sender signs: begin sponsoring, createAccount with 0 XLM, setOptions on the new account (master weight 0, thresholds 1/1/1, the sender as its only signer), end. The browser checks that shape, signs it with the throwaway key once and drops the key; the sender signs nothing (no wallet prompt). Submit it **first**: it takes its source's next sequence, `xdr` the one after (the same source when both create an account).
- `xdr`: the Phase 1 sandwich (create the account with 0 XLM if missing, open the missing corridor trustlines). The sender co-signs it in their wallet and submits it.
- An account that already has a payment account (Horizon `GET /accounts?signer=`) gets no second one; the key sent is ignored. A merged payment account counts as none, so the next `/setup` creates a fresh one.
- `400 BAD_REQUEST`: `paymentAccount` is not a G key or equals `account`.
- `409 NOTHING_TO_SET_UP`: the account, its trustlines and its payment account all exist (or no `paymentAccount` was sent for an account that only lacks one).

Rate limited per IP, per account and globally. The per-account `429` is decided before anything is built, leased or signed. The per-account limit (1 per 10 minutes) counts every `/setup` that returns an `xdr`, so after a setup that did not land (declined in the wallet, or failed on chain, for example `tx_bad_seq` from a channel collision after a restart) that account can set up again only after up to 10 minutes; a payment-account-only setup is not counted.

## POST /sep10/client-domain
Co-signs the anchor's SEP-10 challenge with Corra's client_domain `SIGNING_KEY`, so the anchor attributes the session to Corra. Refuses anything that is not a sequence-0 challenge from the anchor's own signing key. Rate limited per IP. Corra's `SIGNING_KEY` is published at `GET /.well-known/stellar.toml`.

## GET /health
`200 { "ok": true }` while the process serves requests: a liveness probe only (the local stack and the
release checks wait on it). It reports no balances and never turns 503 for a low one: sponsor and
channel balances, the anchor's assets, the pool's TTL, the demo recipient and the key files are checked
from outside by `pnpm ops-check` ([release-checklist](release-checklist.md)).

## GET /.well-known/stellar.toml
Corra's own stellar.toml: its client_domain `SIGNING_KEY` (public), which an anchor reads to verify the
co-signature on a SEP-10 challenge.

## Rate limits
Per route, from `DEFAULT_LIMITS` in `services/orchestrator/src/app.ts`. A replay (same Idempotency-Key and
body) never takes a token; a per-account token is taken only once the request is proven to be that account's.

| Limit | Max | Window | Applies to |
|---|---|---|---|
| `setupPerIp` | 5 | 10 min | `POST /setup` |
| `setupPerAccount` | 1 | 10 min | `POST /setup`, only for the account's own setup transaction |
| `setupGlobal` | 60 | 1 h | `POST /setup` (also bounds channel use) |
| `quotePerIp` | 60 | 1 min | `POST /quote` |
| `clientDomainPerIp` | 30 | 1 min | `POST /sep10/client-domain` |
| `depositPerIp` | 10 | 10 min | `POST /deposits` |
| `depositPerAccount` | 3 | 10 min | `POST /deposits` |
| `depositLinkPerIp` | 30 | 10 min | `POST /deposits/:id/link` (each link walks Horizon once) |
| `sendPerIp` | 20 | 10 min | `POST /send`, a balance `POST /resign` |
| `sendPerAccount` | 10 | 10 min | the same, once the blob is the sender's |
| `readPerIp` | 60 | 1 min | `GET /accounts/:account/payments`, `/deposits`, `/pool-ops` |
| `poolPerIp` | 30 | 10 min | `POST /pool/submit` |
| `poolPerAccount` | 10 | 10 min | `POST /pool/submit`, once the blob is the account's |
| `poolGlobal` | 300 | 24 h | `POST /pool/submit` (bounds the sponsor's pool fees) |
| `cashOutPerIp` | 5 | 10 min | `POST /payments/:id/cash-out/submit`, new withdrawal payments only |

The local stack (`CORRA_LOCAL_SETUP_LIMITS=1`, honoured only with a localhost anchor) raises `setupPerIp`
to 200 and `setupGlobal` to 2,000, because every script there shares one IP. `POST /confirm` and
`GET /payments/:id` have no per-IP limit ([risks](risks.md) R24).

---

## Endpoint <-> saga mapping
| Endpoint | Saga ([contracts](contracts.md)) | State effect |
|---|---|---|
| POST /quote | `saga.quote()` | none |
| POST /confirm | `saga.confirm()` | -> QUOTED -> SIGNED |
| POST /send | `saga.confirm({ kind: 'balance' })` | -> QUOTED -> SIGNED -> CASH_IN in one write, then submitted |
| GET /accounts/:account/payments | `saga.listPayments()` | none |
| POST /deposits, /deposits/:id/link, GET /deposits/... | `deposits.create()`, `.link()`, `.get()`, `.listByAccount()` | no payment state |
| POST /callbacks/sep24 | deposits: `saga.onCashIn()` and `deposits.onCallback()`, independently; withdrawals: `cashOuts.onCallback()` only | SIGNED -> CASH_IN, after chain confirmation; or a deposit -> CONFIRMED; or a cash_out leg -> CONFIRMED (state stays CREDITED) |
| POST /payments/:id/cash-out/submit | `cashOuts.submit()` | none; the cash_out leg gets its ref and tx |
| POST /resign | `saga.resign()` | new saga, `supersedesId` set |
| POST /pool/submit, GET /accounts/:account/pool-ops | `poolOps.submit()`, `.list()` | no payment state; a `pool_ops` row |
| (reconciler) | `saga.reconcile()`, `deposits.reconcileDeposits()`, `poolOps.reconcile()`, `cashOuts.reconcile()` | advances from chain state; creates no new state |

> Reconcile is not an endpoint. It runs over this instance's own pending payments only, reads the authoritative fact from the chain, and advances the saga to match ([flows](flows.md) section 4). Submission is safe to retry: Stellar consumes the sequence number on the first successful submission and rejects every later resubmission of the same signed blob.

**Cash-out on testnet.** The withdrawal is a real SEP-24 TESTPHP withdrawal at Corra's own test anchor; the cash pickup behind it is simulated and no fiat moves. A real payout needs a licensed anchor partner (Phase 2).
