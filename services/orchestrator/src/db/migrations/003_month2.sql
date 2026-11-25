-- Second month: balance, Blend pool and the recipient's cash-out. Additive and idempotent:
-- every statement is safe to rerun on every boot, and existing rows are left as they are.

-- D1: a payment is either cashed in for itself (Phase 1) or paid from the sender's balance.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'cash_in';
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_kind_check CHECK (kind IN ('cash_in','balance'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS payments_sender_created_idx    ON payments (sender_account, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_recipient_created_idx ON payments (recipient_account, created_at DESC);
-- B3 at the database: at most one balance payment of a sender between creation and its outcome.
CREATE UNIQUE INDEX IF NOT EXISTS payments_balance_in_flight_key ON payments (sender_account)
  WHERE kind = 'balance' AND state IN ('CASH_IN', 'ONCHAIN');

-- D1: SEP-24 deposits not bound to any payment. The balance itself lives on chain;
-- this table only links a deposit to the anchor's record.
CREATE TABLE IF NOT EXISTS deposits (
  id                  TEXT PRIMARY KEY,                  -- dep_<uuid>
  account             TEXT NOT NULL,
  anchor_id           TEXT NOT NULL,
  external_ref        TEXT,                              -- SEP-24 transaction id, write-once
  more_info_url       TEXT,
  memo                TEXT NOT NULL UNIQUE,              -- base64 sha256(id)
  asset_code          TEXT NOT NULL,
  asset_issuer        TEXT NOT NULL,
  amount_raw          NUMERIC(40,0) NOT NULL,            -- requested
  amount_credited_raw NUMERIC(40,0),
  tx_hash             TEXT,
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','CONFIRMED','EXPIRED')),
  matched_by          TEXT CHECK (matched_by IN ('ref','callback_tx','chain')),
  reason              TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anchor_id, external_ref)
);
CREATE INDEX IF NOT EXISTS deposits_account_idx ON deposits (account, created_at DESC);
CREATE INDEX IF NOT EXISTS deposits_open_idx ON deposits (status, updated_at) WHERE status IN ('PENDING','EXPIRED');
-- A confirmed deposit carries the chain facts it was confirmed from.
DO $$ BEGIN
  ALTER TABLE deposits ADD CONSTRAINT deposits_confirmed_has_chain
    CHECK (status <> 'CONFIRMED' OR (tx_hash IS NOT NULL AND amount_credited_raw IS NOT NULL AND matched_by IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A confirmed deposit is what the chain said; nothing may rewrite it.
CREATE OR REPLACE FUNCTION corra_deposit_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'CONFIRMED' AND (
       NEW.status <> OLD.status
    OR NEW.tx_hash IS DISTINCT FROM OLD.tx_hash
    OR NEW.amount_credited_raw IS DISTINCT FROM OLD.amount_credited_raw
    OR NEW.matched_by IS DISTINCT FROM OLD.matched_by) THEN
    RAISE EXCEPTION 'deposit % is CONFIRMED and immutable', OLD.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS deposits_confirmed_guard ON deposits;
CREATE TRIGGER deposits_confirmed_guard BEFORE UPDATE ON deposits
  FOR EACH ROW EXECUTE FUNCTION corra_deposit_guard();

-- D2: pool supply/withdraw transactions Corra fee-bumped. History and evidence only;
-- the position itself lives in the pool contract.
CREATE TABLE IF NOT EXISTS pool_ops (
  id              TEXT PRIMARY KEY,                      -- pop_<uuid>
  idempotency_key TEXT NOT NULL UNIQUE,
  account         TEXT NOT NULL,
  pool_id         TEXT NOT NULL,
  asset_sac       TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('supply','withdraw')),
  amount_raw      NUMERIC(40,0) NOT NULL,                -- requested
  inner_hash      TEXT NOT NULL UNIQUE,
  tx_hash         TEXT,                                  -- fee-bump envelope hash
  status          TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','SUCCESS','FAILED')),
  result_code     TEXT,
  resource_fee    BIGINT,
  ledger          INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_ops_account_idx ON pool_ops (account, created_at DESC);
CREATE INDEX IF NOT EXISTS pool_ops_open_idx ON pool_ops (updated_at) WHERE status = 'SUBMITTED';

-- D3: the cash_out leg is PENDING on a CREDITED payment and confirmed later, from the
-- anchor's signed callback and the chain. Phase 1 legs carry 'mock-payout:...' and pass.
DO $$ BEGIN
  ALTER TABLE legs ADD CONSTRAINT legs_cash_out_confirmed_has_ref
    CHECK (kind <> 'cash_out' OR status <> 'CONFIRMED' OR external_ref IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- Every CREDITED payment now has a PENDING cash_out leg; only legs with a submitted withdrawal are reconciled.
DROP INDEX IF EXISTS legs_cash_out_open_idx;
CREATE INDEX IF NOT EXISTS legs_cash_out_inflight_idx ON legs (updated_at)
  WHERE kind = 'cash_out' AND status = 'PENDING' AND tx_hash IS NOT NULL;
-- One on-chain withdrawal payment backs at most one cash-out.
CREATE UNIQUE INDEX IF NOT EXISTS legs_cash_out_tx_key ON legs (tx_hash)
  WHERE kind = 'cash_out' AND tx_hash IS NOT NULL;
