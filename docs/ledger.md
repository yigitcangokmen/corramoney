# Corra: Ledger (schema and state transition rules)

> The ledger records payment status; **the chain is the authority**. Where the two disagree, the chain wins and the reconciler advances the ledger to match. Postgres.

## 1. Tables

```sql
-- One payment = one saga. idempotency_key UNIQUE means the same request cannot create two payments.
CREATE TABLE payments (
  id                TEXT PRIMARY KEY,             -- pmt_...
  public_id         TEXT NOT NULL UNIQUE,         -- short id shown to the user
  idempotency_key   TEXT NOT NULL UNIQUE,         -- idempotency key of the confirm() call
  sender_account    TEXT NOT NULL,
  recipient_account TEXT NOT NULL,
  corridor_from     TEXT NOT NULL,                -- "MX/MXN"
  corridor_to       TEXT NOT NULL,                -- "PH/PHP"
  quote             JSONB NOT NULL,               -- frozen quote snapshot: anchor quote id + expiry, unchanged
  source_raw        NUMERIC(40,0) NOT NULL,       -- minor unit (bigint)
  dest_raw          NUMERIC(40,0) NOT NULL,
  send_max_raw      NUMERIC(40,0) NOT NULL,       -- the cap the sender signed
  signed_xdr        TEXT,                         -- the pre-signed transaction, NULL once submitted or expired
  inner_tx_hash     TEXT NOT NULL UNIQUE,         -- hash of the signed transaction: one row per signed blob
  max_time          TIMESTAMPTZ,                  -- timebound the sender signed (10 to 30 min)
  supersedes_id     TEXT UNIQUE REFERENCES payments(id), -- set when this saga replaces an EXPIRED/CAP_EXCEEDED/FAILED one
  state             TEXT NOT NULL,                -- PaymentState
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Legs: cash_in / onchain / cash_out. external_ref is the anchor side; idempotent dedupe.
CREATE TABLE legs (
  id            TEXT PRIMARY KEY,                 -- leg_...
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  kind          TEXT NOT NULL,                    -- cash_in | onchain | cash_out
  anchor_id     TEXT,                             -- which anchor served this leg
  external_ref  TEXT,                             -- anchor leg reference (SEP-24 transaction id)
  tx_hash       TEXT,                             -- for the onchain leg
  amount_raw    NUMERIC(40,0) NOT NULL,
  asset_code    TEXT NOT NULL,
  asset_issuer  TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',  -- LegStatus
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, kind),                      -- one of each leg per payment
  UNIQUE (anchor_id, external_ref)                -- the same anchor event is not processed twice
);

-- Append-only timeline. Never UPDATE/DELETE.
CREATE TABLE payment_events (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  seq         INT  NOT NULL,                      -- monotonic order within a payment
  type        TEXT NOT NULL,                      -- QUOTED, SIGNED, CASH_IN, ...
  from_state  TEXT,
  to_state    TEXT,
  data        JSONB,                              -- event payload (txHash, ref, error...)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, seq)                        -- do not write the same sequence twice (idempotent progress)
);
```

**What the ledger never stores.** No names, no phone numbers, no bank details, no identity documents, no KYC data. Customer identity stays with the anchor, which is the licensed party required to hold it. The only user-linked values here are Stellar account IDs, which are public by construction.

**`signed_xdr` is a blob, not a key.** It is a transaction the sender already signed, fully bound to a recipient, an amount and a cap. It is deleted on submission or expiry. Corra signs nothing with a user's key. The server holds two keys of its own: the fee-and-sponsor account, which signs only fee-bump envelopes (CAP-15) and sponsorship setups (CAP-33) so the sender needs no XLM, and Corra's SEP-10 client_domain `SIGNING_KEY`, which co-signs only login challenges. Neither can move user value. A CI job named `no-server-side-signing` asserts that scoped invariant and prints the scope it checks; see the README for what it checks.

## 2. Allowed state transitions

Five states plus three terminal exits. Any other transition is rejected (illegal transition guard).

```mermaid
stateDiagram-v2
    [*] --> QUOTED
    QUOTED --> SIGNED: sender signs in their own wallet
    SIGNED --> CASH_IN: cash-in confirmed AND verified on chain
    SIGNED --> EXPIRED: maxTime passed
    CASH_IN --> ONCHAIN: signed XDR submitted
    CASH_IN --> EXPIRED: submission landed after maxTime
    ONCHAIN --> CREDITED: settles
    ONCHAIN --> CAP_EXCEEDED: op_over_source_max, nothing moved
    ONCHAIN --> FAILED: landed failed for another reason, codes kept
    CREDITED --> [*]
    EXPIRED --> [*]
    CAP_EXCEEDED --> [*]
    FAILED --> [*]
```

| from | allowed to |
|---|---|
| QUOTED | SIGNED |
| SIGNED | CASH_IN, EXPIRED |
| CASH_IN | ONCHAIN, EXPIRED |
| ONCHAIN | CREDITED, CAP_EXCEEDED, FAILED |
| CREDITED / EXPIRED / CAP_EXCEEDED / FAILED | *(terminal)* |

**Terminal exits never loop back.** Re-signing does not revive an `EXPIRED`, `CAP_EXCEEDED` or `FAILED` saga. It opens a **new** payment row whose `supersedes_id` points at the old one, so the ledger keeps exactly one row per signed transaction and the timeline of a retried payment stays readable. `UNIQUE(inner_tx_hash)` enforces that, and `/confirm` also refuses a signed transaction that is already on chain.

**A re-sign does not ask for a second deposit.** None of the payments it replaces landed, so their cash-in is still in the sender's account. When the new payment looks for its cash-in it adds up the deposits carrying its own memo and those of the unspent payments it replaces, up to five re-signs back.

**`FAILED` keeps what the chain said.** `CAP_EXCEEDED` means `op_over_source_max` and nothing else. A payment that lands failed for any other reason (the recipient removed their trustline: `op_no_trust`; the sender spent the deposit: `op_underfunded`) is `FAILED`, and the Horizon result code is recorded on the event, never guessed.

**One pending payment per sender.** Every payment from one sender is signed against the same `minSeqNum` window, so only one of them could ever land. `/confirm` refuses with `409 PAYMENT_IN_PROGRESS` while another payment of the sender is in `CASH_IN` or `ONCHAIN`, and expires any payment still in `SIGNED` with the reason `superseded by a newer payment`.

**The cash-in is matched by memo.** The SEP-24 deposit carries a hash memo, `base64(sha256(payment id))`, and only credits with that memo count for the payment. Several credits with the same memo add up, so a short deposit can be topped up.

**Expiry waits for the chain.** A payment is only called `EXPIRED` once `maxTime` plus a 120-second grace period has passed **and** Horizon reports the signed transaction as not found. The grace absorbs ledger close time and Horizon ingestion lag, so a payment that landed in the last ledger before `maxTime` is settled, not expired.

**`CASH_IN` is not entered on the callback alone.** The anchor's SEP-24 callback is signed with the `SIGNING_KEY` published in its `stellar.toml`, and the signature and timestamp freshness are both checked. Even then the callback is only a trigger: before advancing, the orchestrator independently confirms from chain state that the deposit actually credited the sender's account. A forged, stale or replayed callback therefore cannot cause a submission.

**`CASH_IN -> EXPIRED` covers a real race.** Cash-in can be confirmed just before `maxTime` and the submission land just after it. The network rejects it with `tx_too_late` and it never enters a ledger, exactly like a `SIGNED` expiry, so it exits the same way. Before calling a payment dead the orchestrator checks whether the signed transaction already landed (a concurrent submission may have won), so a `tx_bad_seq` from a lost race is settled, not expired.

**What `CAP_EXCEEDED` looks like on chain.** The transaction fails at the operation level with `op_over_source_max` (Horizon's name for the protocol's `PATH_PAYMENT_STRICT_RECEIVE_OVER_SENDMAX`), so it lands in a ledger as a failed transaction. No path payment is applied and the sender keeps the deposited asset in an account only they can sign for, but the fee and the sequence number are consumed, so the signed blob is spent.

## 3. Progress protocol (idempotent)

Every state advance happens inside a **single transaction**:
1. Lock the payment with `SELECT ... FOR UPDATE` (prevents a concurrent callback + reconciler race).
2. Is the transition allowed? If not, no-op (for example, a late duplicate callback).
3. Update `payments.state` and update `legs`.
4. Insert `(payment_id, seq+1)` into `payment_events`. Under the row lock no second writer can take the same `seq`; `UNIQUE(payment_id, seq)` is the backstop, and a conflict would abort the whole transaction rather than write a gap.
5. commit.

> A callback **and** the reconciler can deliver the same fact, so `UNIQUE(anchor_id, external_ref)` plus the event `seq` make repeated delivery harmless at the ledger level.

**Exactly-once submission is not ours to enforce, and we do not claim it.** The reconciler may retry submission any number of times; the effect is exactly-once because Stellar consumes the transaction's sequence number on the first successful submission and rejects every later resubmission of the same signed blob. That guarantee comes from the protocol, not from application logic.

## 4. Invariants (must hold after every commit)

- **Conservation of funds:** at `CREDITED`, the dest amount of the `onchain` leg equals `payments.dest_raw` (no tolerance; strict-receive fixes the destination amount).
- **The cap is never exceeded:** the source amount actually spent is never greater than `send_max_raw`, which is what the sender signed.
- **Single active leg:** only one leg is `PENDING` at a time (sequential saga, not parallel).
- **Terminal is immutable:** after `CREDITED`, `EXPIRED`, `CAP_EXCEEDED` or `FAILED`, `payments.state` never changes (a database trigger refuses it, and a CHECK keeps `signed_xdr` empty on a terminal row). A retry is a new row, not a mutation.
- **Append-only timeline:** `payment_events` rows are never updated or deleted (a trigger refuses it).
- **Event monotonicity:** `payment_events.seq` increases with no gaps; the timeline is the audit log.
- **No user key in the schema:** no column holds a user's secret key, a seed, or anything from which one could be derived. `signed_xdr` is a signed artifact and is deleted on submission or expiry. The fee-and-sponsor key lives in the deployment's secret store, never in this database.
- **The chain outranks the ledger:** if the ledger says `ONCHAIN` and the chain says the transaction settled, the reconciler advances the ledger. The reconciler never makes a discretionary decision.

## 5. Reconciler

For payments that sit in `SIGNED`, `CASH_IN` or `ONCHAIN` longer than X seconds, the reconciler reads the authoritative fact and advances the saga to match:

- **onchain:** read the transaction from Horizon by hash, or the account's recent transactions when no hash was recorded.
- **cash_in:** read the SEP-24 transaction status through `@stellar/typescript-wallet-sdk`, and confirm the credit from chain state.

It runs over its own pending payments only. It indexes nothing, watches no account that did not start a payment through this instance, and holds no funds and no keys. This is the safety belt against a lost callback, and it is why a lost callback costs a delay rather than a stuck payment.

Context: [contracts](contracts.md) · [flows](flows.md)
