-- Ledger schema from docs/ledger.md, plus a quotes table for quotes not yet confirmed.
-- The chain is the authority; this records saga state and its append-only timeline.
-- No names, phone numbers, bank details or KYC data are stored here, by design.

CREATE TABLE IF NOT EXISTS quotes (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  payment_id  TEXT UNIQUE,                       -- a quote backs at most one payment
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id                TEXT PRIMARY KEY,
  public_id         TEXT NOT NULL UNIQUE,
  idempotency_key   TEXT NOT NULL UNIQUE,
  sender_account    TEXT NOT NULL,
  recipient_account TEXT NOT NULL,
  corridor_from     TEXT NOT NULL,
  corridor_to       TEXT NOT NULL,
  quote             JSONB NOT NULL,
  source_raw        NUMERIC(40,0) NOT NULL,
  dest_raw          NUMERIC(40,0) NOT NULL,
  send_max_raw      NUMERIC(40,0) NOT NULL,
  signed_xdr        TEXT,                        -- NULL once submitted or expired
  inner_tx_hash     TEXT NOT NULL,
  max_time          TIMESTAMPTZ NOT NULL,
  supersedes_id     TEXT REFERENCES payments(id),
  state             TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_pending_idx ON payments (state, updated_at)
  WHERE state IN ('SIGNED', 'CASH_IN', 'ONCHAIN');

CREATE TABLE IF NOT EXISTS legs (
  id            TEXT PRIMARY KEY,
  payment_id    TEXT NOT NULL REFERENCES payments(id),
  kind          TEXT NOT NULL,
  anchor_id     TEXT,
  external_ref  TEXT,
  tx_hash       TEXT,
  amount_raw    NUMERIC(40,0) NOT NULL,
  asset_code    TEXT NOT NULL,
  asset_issuer  TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, kind),
  UNIQUE (anchor_id, external_ref)
);

CREATE TABLE IF NOT EXISTS payment_events (
  id          BIGSERIAL PRIMARY KEY,
  payment_id  TEXT NOT NULL REFERENCES payments(id),
  seq         INT  NOT NULL,
  type        TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (payment_id, seq)
);
