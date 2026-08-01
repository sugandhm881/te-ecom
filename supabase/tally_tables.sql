-- Run this in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────
-- Finance → Data Entry Dashboard → Tally Prime integration.
--
-- Tally's XML gateway only listens on localhost:9000 of the finance PC, so the LIVE dashboard (VPS)
-- can never call it directly. Vouchers are therefore composed + validated here, parked in
-- tally_vouchers_ecom, and a small bridge agent running ON the Tally PC pulls the queue and posts them.
-- tally_masters_ecom mirrors Tally's ledgers/voucher types so the entry form's pickers work (and every
-- ledger name can be validated) even while the bridge is offline.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Vouchers: the draft → queue → posted pipeline (also the audit trail) ─────────────────────────
CREATE TABLE IF NOT EXISTS tally_vouchers_ecom (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    voucher_type      TEXT NOT NULL,            -- Payment | Receipt | Journal | Contra | Sales | Purchase | Credit Note | Debit Note
    voucher_date      DATE NOT NULL,            -- IST calendar date (never derived from toISOString())
    company           TEXT NOT NULL,
    party_ledger      TEXT,                     -- NULL for Journal/Contra
    reference         TEXT,                     -- carries the ECOM-<uuid8> dedup marker
    narration         TEXT,
    entries           JSONB NOT NULL,           -- [{ledger, dr_cr:'DR'|'CR', amount, bill_ref?, bill_type?}]
    total_amount      NUMERIC(14,2) NOT NULL,   -- = sum of the DR side

    status            TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft','queued','posting','posted','failed','cancelled')),
    attempts          INT NOT NULL DEFAULT 0,   -- hard stop at 3; never silently retry forever

    -- Filled from Tally's import response (via the bridge ack)
    tally_masterid       TEXT,
    tally_voucher_number TEXT,
    tally_guid           TEXT,

    error             TEXT,                     -- LINEERROR text or transport error
    request_xml       TEXT,                     -- exactly what was sent
    response_xml      TEXT,                     -- exactly what Tally replied

    -- Blocks a double-post: one row per logical voucher, enforced by the DB not by app logic.
    idempotency_key   TEXT UNIQUE,

    source            TEXT NOT NULL DEFAULT 'manual',   -- manual | shopify-sales | freight | settlement | influencer-payout
    source_ref        TEXT,                             -- e.g. the order name / AWB this was derived from

    created_by        TEXT,                     -- JWT sub (email) of whoever drafted it
    posted_by         TEXT,                     -- who pressed Post to Tally
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    posted_at         TIMESTAMPTZ
);

-- The bridge pulls by status oldest-first; the register filters by date and by source lineage.
CREATE INDEX IF NOT EXISTS tally_vouchers_status_idx ON tally_vouchers_ecom (status, created_at);
CREATE INDEX IF NOT EXISTS tally_vouchers_date_idx   ON tally_vouchers_ecom (voucher_date DESC);
CREATE INDEX IF NOT EXISTS tally_vouchers_source_idx ON tally_vouchers_ecom (source, source_ref);

-- ── Masters mirror: Tally's chart of accounts, refreshed by the bridge every ~30 min ─────────────
-- Purpose is twofold: it feeds the form's searchable pickers, AND it is the whitelist every ledger
-- name is checked against before XML is built. Without that check Tally silently AUTO-CREATES unknown
-- ledgers under Suspense, which quietly corrupts the chart of accounts.
CREATE TABLE IF NOT EXISTS tally_masters_ecom (
    id          BIGSERIAL PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('ledger','group','voucher_type','stock_item','cost_centre')),
    name        TEXT NOT NULL,
    parent      TEXT,                       -- ledger → its group; voucher_type → its base type
    gst_rate    NUMERIC(5,2),
    is_billwise BOOLEAN NOT NULL DEFAULT FALSE,   -- bill-wise ledgers need BILLALLOCATIONS to settle a bill
    meta        JSONB,
    company     TEXT,
    synced_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (kind, name)
);

CREATE INDEX IF NOT EXISTS tally_masters_kind_idx ON tally_masters_ecom (kind, name);

-- ── Bridge liveness: one row, upserted on every heartbeat. Powers the UI's connection chip. ──────
CREATE TABLE IF NOT EXISTS tally_bridge_status_ecom (
    id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_seen_at      TIMESTAMPTZ,
    agent_version     TEXT,
    tally_reachable   BOOLEAN NOT NULL DEFAULT FALSE,
    company           TEXT,
    masters_synced_at TIMESTAMPTZ,
    sync_requested    BOOLEAN NOT NULL DEFAULT FALSE,   -- UI asks for a master refresh; agent clears it
    note              TEXT
);
INSERT INTO tally_bridge_status_ecom (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── keep updated_at honest ───────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION tally_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tally_vouchers_touch ON tally_vouchers_ecom;
CREATE TRIGGER tally_vouchers_touch BEFORE UPDATE ON tally_vouchers_ecom
    FOR EACH ROW EXECUTE FUNCTION tally_touch_updated_at();

-- ── RLS: locked to the service role only. The Node server holds SUPABASE_SERVICE_KEY (which bypasses
-- RLS); no anon/authenticated policy is created, so the browser can never read the books directly.
ALTER TABLE tally_vouchers_ecom      ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_masters_ecom       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_bridge_status_ecom ENABLE ROW LEVEL SECURITY;
