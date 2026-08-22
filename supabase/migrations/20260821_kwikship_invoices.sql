-- KwikShip freight invoices — the real bills, held against what this dashboard COMPUTES.
--
-- The whole KwikShip Freight page is an expectation derived from our own rate card, because KwikShip
-- publishes no billing API. This table is the other half: what they actually invoiced. With both, the
-- Invoices tab can show a per-period variance, which is the only way a wrong rate card ever gets caught.
--
-- Deliberately separate from kwikship_payments: an invoice is a claim, a payment is a settlement, and
-- storing them in one table (e.g. by overloading `direction`) would corrupt the ledger's paid totals.
create table if not exists public.kwikship_invoices (
    id             bigint generated always as identity primary key,
    invoice_no     text        not null unique,
    invoice_date   date,
    -- The period the invoice covers. Nullable because not every invoice states one, but the variance
    -- comparison only runs when both ends are present — a guessed period would invent a variance.
    period_from    date,
    period_to      date,
    shipments      integer,
    freight_amount numeric,
    gst_amount     numeric,
    total_amount   numeric     not null check (total_amount >= 0),
    notes          text,
    source_file    text,
    created_by     text,
    created_at     timestamptz not null default now()
);

create index if not exists idx_kwikship_invoices_period on public.kwikship_invoices (period_from, period_to);
create index if not exists idx_kwikship_invoices_date   on public.kwikship_invoices (invoice_date desc);

alter table public.kwikship_invoices enable row level security;

comment on table public.kwikship_invoices is
  'KwikShip freight invoices, entered by hand or parsed from a PDF/Excel upload. Compared against the '
  'rate-card charge the dashboard computes. RLS on, service-role only — the portal writes through the server.';
