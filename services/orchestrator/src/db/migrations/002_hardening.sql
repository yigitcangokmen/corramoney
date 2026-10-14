-- The database itself enforces what docs/ledger.md promises, instead of trusting the code alone.

-- Ledgers written before this migration may hold several payments for one signed transaction.
-- The first one keeps the hash; any later one still pending is expired (its blob is already
-- spoken for), and every later one gets its hash tagged so the unique index below can exist.
-- Idempotent: once no duplicates remain, every statement here matches nothing.
DO $$ DECLARE d record; BEGIN
  FOR d IN
    SELECT id, inner_tx_hash, state, first_id FROM (
      SELECT id, inner_tx_hash, state,
             first_value(id) OVER (PARTITION BY inner_tx_hash ORDER BY created_at, id) AS first_id,
             row_number() OVER (PARTITION BY inner_tx_hash ORDER BY created_at, id) AS n
      FROM payments) ranked
    WHERE n > 1
  LOOP
    IF d.state IN ('SIGNED', 'CASH_IN', 'ONCHAIN') THEN
      -- ONCHAIN means the shared transaction landed, credited to the first row: FAILED, not EXPIRED.
      INSERT INTO payment_events (payment_id, seq, type, from_state, to_state, data)
        SELECT d.id, COALESCE(MAX(seq), 0) + 1,
               CASE WHEN d.state = 'ONCHAIN' THEN 'FAILED' ELSE 'EXPIRED' END, d.state,
               CASE WHEN d.state = 'ONCHAIN' THEN 'FAILED' ELSE 'EXPIRED' END,
               jsonb_build_object('reason', 'the signed transaction already backs ' || d.first_id)
        FROM payment_events WHERE payment_id = d.id;
      UPDATE legs SET status = 'FAILED' WHERE payment_id = d.id AND status = 'PENDING';
      UPDATE payments SET state = CASE WHEN d.state = 'ONCHAIN' THEN 'FAILED' ELSE 'EXPIRED' END, signed_xdr = NULL
        WHERE id = d.id;
    END IF;
    UPDATE payments SET inner_tx_hash = d.inner_tx_hash || ':duplicate:' || d.id WHERE id = d.id;
  END LOOP;
END $$;

-- A payment re-signed twice by older code: the first re-sign keeps the link, later ones lose it.
UPDATE payments p SET supersedes_id = NULL
  WHERE supersedes_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM payments o WHERE o.supersedes_id = p.supersedes_id AND (o.created_at, o.id) < (p.created_at, p.id));

-- A finished payment never keeps its signed blob (older code could leave one behind).
UPDATE payments SET signed_xdr = NULL
  WHERE state IN ('CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED') AND signed_xdr IS NOT NULL;

-- One signed transaction backs at most one payment; a payment is superseded at most once.
CREATE UNIQUE INDEX IF NOT EXISTS payments_inner_tx_hash_key ON payments (inner_tx_hash);
CREATE UNIQUE INDEX IF NOT EXISTS payments_supersedes_id_key ON payments (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payments_sender_state_idx ON payments (sender_account, state);

DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_state_check
    CHECK (state IN ('QUOTED', 'SIGNED', 'CASH_IN', 'ONCHAIN', 'CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A terminal payment never keeps its signed blob.
DO $$ BEGIN
  ALTER TABLE payments ADD CONSTRAINT payments_terminal_no_blob
    CHECK (state NOT IN ('CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED') OR signed_xdr IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE legs ADD CONSTRAINT legs_kind_check CHECK (kind IN ('cash_in', 'onchain', 'cash_out'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE legs ADD CONSTRAINT legs_status_check CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Terminal states are immutable.
CREATE OR REPLACE FUNCTION corra_terminal_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('CREDITED', 'EXPIRED', 'CAP_EXCEEDED', 'FAILED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'payment % is terminal (%) and cannot move to %', OLD.id, OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payments_terminal_guard ON payments;
CREATE TRIGGER payments_terminal_guard BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION corra_terminal_guard();

-- The timeline is append-only.
CREATE OR REPLACE FUNCTION corra_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payment_events is append-only';
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS payment_events_append_only ON payment_events;
CREATE TRIGGER payment_events_append_only BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION corra_append_only();
