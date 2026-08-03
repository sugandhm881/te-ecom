-- Run this in Supabase SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────
-- Nightly batch push to Tally, with Teams approval.
--
-- Users enter vouchers during the day (status 'draft'). At 23:50 IST a cron re-validates them against
-- Tally's freshly-synced masters, groups the valid ones into a BATCH, and asks for approval in Teams.
-- Only once an admin approves do the vouchers become 'queued' for the bridge agent to post.
--
-- The batch lives in Postgres, NOT in a memory variable (which is how the Amazon review approval works)
-- — a nightly finance batch must survive a server restart, and finance needs the audit trail.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. voucher table: batch grouping + the new awaiting_approval state ───────────────────────────
ALTER TABLE tally_vouchers_ecom ADD COLUMN IF NOT EXISTS batch_id uuid;
-- Why a voucher was NOT allowed into a batch. It stays 'draft' so that fixing it puts it in the next
-- run automatically; this column is what the Teams card's "Blocked" section reports.
ALTER TABLE tally_vouchers_ecom ADD COLUMN IF NOT EXISTS validation_error TEXT;

ALTER TABLE tally_vouchers_ecom DROP CONSTRAINT IF EXISTS tally_vouchers_ecom_status_check;
ALTER TABLE tally_vouchers_ecom ADD CONSTRAINT tally_vouchers_ecom_status_check
    CHECK (status IN ('draft','awaiting_approval','queued','posting','posted','failed','cancelled'));

CREATE INDEX IF NOT EXISTS tally_vouchers_batch_idx ON tally_vouchers_ecom (batch_id);

-- ── 2. the batches themselves ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tally_push_batches_ecom (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    ref             TEXT NOT NULL UNIQUE,          -- TB-YYYYMMDD-n, quoted in Teams so an old card can't be approved by mistake
    company         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'awaiting_approval'
                    CHECK (status IN ('awaiting_approval','approved','rejected','pushing','done','failed','expired','empty')),

    voucher_count   INT  NOT NULL DEFAULT 0,
    total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    blocked_count   INT  NOT NULL DEFAULT 0,
    blocked         JSONB,                          -- [{id, type, date, amount, error}] — shown in the card

    -- approval
    approved_by     TEXT,
    approved_at     TIMESTAMPTZ,
    approval_source TEXT CHECK (approval_source IN ('teams','dashboard','auto')),
    rejected_by     TEXT,
    rejected_at     TIMESTAMPTZ,

    -- outcome
    posted_count    INT NOT NULL DEFAULT 0,
    failed_count    INT NOT NULL DEFAULT 0,
    result_notified BOOLEAN NOT NULL DEFAULT FALSE, -- so the watcher posts the result card exactly once
    error           TEXT,

    trigger         TEXT NOT NULL DEFAULT 'cron',   -- cron | manual
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ                     -- unapproved after this → vouchers return to 'draft'
);

CREATE INDEX IF NOT EXISTS tally_batches_status_idx ON tally_push_batches_ecom (status, created_at DESC);

-- ── 3. books cache — lets the LIVE dashboard show Tally reports in bridge mode ───────────────────
-- The VPS cannot read localhost:9000, so the bridge agent uploads the trial balance and day book here
-- every ~15 min. `synced_at` is surfaced in the UI as an "as of" stamp so nobody mistakes a cached
-- statement for a live one.
CREATE TABLE IF NOT EXISTS tally_books_cache_ecom (
    id           BIGSERIAL PRIMARY KEY,
    company      TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('trial_balance','day_book','meta')),
    period_from  DATE,
    period_to    DATE,
    payload      JSONB NOT NULL,
    synced_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (company, kind, period_from, period_to)
);
-- Only ever ONE row per (company, kind) is kept — the newest. The unique key includes the period, so
-- it cannot enforce that on its own: `meta` has NULL periods (and a unique index treats NULLs as
-- distinct, so ON CONFLICT never matches), and the current year's period_to is today, which moves
-- daily. Both would insert rather than replace, accumulating multi-MB payloads forever. The upload
-- route prunes older rows for the same (company, kind) immediately after each write.

-- ── RLS: service-role only, same as every other tally_* table ───────────────────────────────────
ALTER TABLE tally_push_batches_ecom ENABLE ROW LEVEL SECURITY;
ALTER TABLE tally_books_cache_ecom  ENABLE ROW LEVEL SECURITY;
