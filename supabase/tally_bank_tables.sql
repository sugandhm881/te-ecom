-- ─────────────────────────────────────────────────────────────────────────────
-- Finance → Tally: bank-statement import, learned mappings and the delete audit.
--
-- These five were created live against Supabase while the feature was being built, so this file was
-- written afterwards FROM THE ACTUAL DATABASE (information_schema + pg_indexes) rather than from
-- memory. Run it on any environment that does not already have them; every statement is idempotent.
--
-- The other Tally tables live in tally_tables.sql (vouchers, masters, books cache, bridge status)
-- and tally_batch_tables.sql (nightly push batches).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── imported statement lines ─────────────────────────────────────────────────────────────────────
-- The dedup guard. Every line is hashed on date+amount+narration+ref; the UNIQUE index on line_hash
-- is what actually stops a re-uploaded statement booking the same transaction twice — the single most
-- damaging mistake a bank import can make. A row here means "already booked".
CREATE TABLE IF NOT EXISTS tally_bank_lines_ecom (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    line_hash   text NOT NULL UNIQUE,
    company     text,
    bank_ledger text NOT NULL DEFAULT 'HDFC BANK',
    txn_date    date NOT NULL,
    narration   text,
    reference   text,
    withdrawal  numeric(14,2) NOT NULL DEFAULT 0,
    deposit     numeric(14,2) NOT NULL DEFAULT 0,
    balance     numeric(14,2),
    ledger      text,
    -- NULL after the voucher is deleted: the line is then released back to the pending pile
    voucher_id  uuid,
    source_file text,
    imported_by text,
    imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tally_bank_lines_date_idx ON tally_bank_lines_ecom (txn_date DESC);
CREATE INDEX IF NOT EXISTS tally_bank_lines_vch_idx  ON tally_bank_lines_ecom (voucher_id);

-- ── statement lines not yet booked ───────────────────────────────────────────────────────────────
-- Uploaded but still unmapped, so "what is left to do" survives closing the browser tab. Deliberately
-- NOT the table above: that one's UNIQUE(line_hash) MEANS "already imported", so pending rows living
-- in it would make every uploaded line look already-done. A line is in exactly one of the two.
CREATE TABLE IF NOT EXISTS tally_bank_pending_ecom (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    line_hash       text NOT NULL,
    company         text NOT NULL,
    bank_ledger     text NOT NULL,
    txn_date        date NOT NULL,
    narration       text NOT NULL DEFAULT '',
    reference       text,
    withdrawal      numeric(14,2) NOT NULL DEFAULT 0,
    deposit         numeric(14,2) NOT NULL DEFAULT 0,
    balance         numeric(14,2),
    source_file     text,
    -- why it came back here: a voucher was deleted, or an admin released the line
    returned_reason text,
    uploaded_by     text,
    uploaded_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tally_bank_pending_hash_uq ON tally_bank_pending_ecom (line_hash);
CREATE INDEX IF NOT EXISTS tally_bank_pending_co_idx  ON tally_bank_pending_ecom (company, txn_date);

-- ── learned narration → ledger mappings ──────────────────────────────────────────────────────────
-- Every correction an operator makes is remembered here, so the same narration shape is never asked
-- about twice. `pattern` is the normalised signature of the narration, not the raw text.
CREATE TABLE IF NOT EXISTS tally_bank_rules_ecom (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company     text,
    bank_ledger text NOT NULL DEFAULT 'HDFC BANK',
    pattern     text NOT NULL,
    ledger      text NOT NULL,
    direction   text DEFAULT 'any',
    hits        integer NOT NULL DEFAULT 0,
    created_by  text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (bank_ledger, pattern, direction)
);
CREATE INDEX IF NOT EXISTS tally_bank_rules_pattern_idx ON tally_bank_rules_ecom (pattern);

-- ── narration labels ─────────────────────────────────────────────────────────────────────────────
-- A running account with a service partner carries transactions that mean opposite things but read
-- identically in the bank narration: with RapidShyp, money OUT is a wallet recharge and money IN is a
-- COD remittance. Direction is the only thing that separates them, so the label is keyed on it.
CREATE TABLE IF NOT EXISTS tally_narration_labels_ecom (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    company    text NOT NULL,
    ledger     text NOT NULL,
    direction  text NOT NULL CHECK (direction IN ('payment', 'receipt')),
    label      text NOT NULL,
    created_by text,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tally_narration_labels_uq
    ON tally_narration_labels_ecom (company, ledger, direction);

-- ── delete audit ─────────────────────────────────────────────────────────────────────────────────
-- A full snapshot taken BEFORE an admin hard-deletes a register entry. The delete aborts if this
-- insert fails: no audit ⇒ no delete. Append-only.
CREATE TABLE IF NOT EXISTS tally_voucher_deletions_ecom (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_id           uuid NOT NULL,
    company              text,
    voucher_type         text,
    voucher_date         date,
    party_ledger         text,
    reference            text,
    narration            text,
    total_amount         numeric(14,2),
    entries              jsonb,
    prior_status         text,
    -- true ⇒ it had reached Tally, so it still exists THERE and must be removed with Alt+D
    was_posted           boolean NOT NULL DEFAULT false,
    tally_masterid       text,
    tally_voucher_number text,
    batch_ref            text,
    snapshot             jsonb,
    entered_by           text,
    entered_at           timestamptz,
    posted_by            text,
    deleted_by           text NOT NULL,
    deleted_at           timestamptz NOT NULL DEFAULT now(),
    reason               text
);
CREATE INDEX IF NOT EXISTS tally_vdel_when_idx ON tally_voucher_deletions_ecom (deleted_at DESC);
CREATE INDEX IF NOT EXISTS tally_vdel_who_idx  ON tally_voucher_deletions_ecom (deleted_by);

-- Reached only through the service-role key from the server; no client-side policies.
ALTER TABLE tally_bank_lines_ecom          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_bank_pending_ecom        ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_bank_rules_ecom          ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_narration_labels_ecom    ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_voucher_deletions_ecom   ENABLE ROW LEVEL SECURITY;
