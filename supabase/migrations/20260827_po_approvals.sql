-- PO approval queue (2026-08-27). APPLIED.
-- A purchase order is DRAFTED here and only reaches EasyEcom once an approver releases it.
-- status: pending -> created  (approved + EasyEcom write succeeded)
--                 -> rejected (with note)
--                 -> failed   (approved but the EasyEcom write failed; retryable from the dashboard)
CREATE TABLE IF NOT EXISTS po_approvals_ecom (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    status text NOT NULL DEFAULT 'pending',
    requested_by text NOT NULL,
    requested_by_name text,
    requested_at timestamptz NOT NULL DEFAULT now(),
    decided_by text,
    decided_at timestamptz,
    decision_note text,
    payload jsonb NOT NULL,          -- the exact CreatePurchaseOrder body, fired verbatim on approval
    vendor_name text,
    ref_code text,
    total_value numeric,
    total_qty integer,
    line_count integer,
    easyecom_po_id bigint,
    easyecom_status text,
    create_error text
);
CREATE INDEX IF NOT EXISTS idx_po_approvals_status ON po_approvals_ecom(status);
ALTER TABLE po_approvals_ecom ENABLE ROW LEVEL SECURITY;
