-- 2026-08-29 — DocPharma journeys get their dates from the PORTAL timeline (Dispatch→Delivery TAT was 0).
--
-- The partner API (fetch-details) carries no dispatch / pickup / OFD / RTO timestamps, so every DocPharma
-- row in shipment_journey_ecom had dispatched_at NULL (0 of 1,215), rto_at NULL (0 of 318) and
-- out_for_delivery_at NULL — the Delivery Performance TAT card read "0 shipments" for DocPharma.
-- The portal sync (docpharma_portal.js → docpharma_orders.scans/dispatched_at/rto_at/delivered_date)
-- HAS them: picked_up / manifested / out_for_delivery / undelivered / delivered / rto_initiated events for
-- ~96% of orders. Nothing copied them across. This migration makes the DATABASE do it, so it holds no
-- matter which writer (webhook, cron, backfill) last touched the journey row:
--   • sync_docpharma_journey_dates(since) — bulk, idempotent: fills ONLY NULL date columns on
--     source='docpharma' journeys from the matching docpharma_orders row (join partner_order_id = order_name)
--   • trg_docpharma_orders_journey — AFTER UPDATE on docpharma_orders: pushes the dates for THAT order
--   • pg_cron docpharma-journey-dates-hourly (50 * * * *) — backstop for journeys written after the portal row
-- Only NULLs are filled (coalesce): a date the courier feed later reports is never overwritten by ours.
-- APPLIED to the live project on 2026-08-29 via the Supabase MCP, then backfilled.

create or replace function public.sync_docpharma_journey_dates(p_since interval default interval '400 days')
returns integer language plpgsql as $$
declare v_n integer;
begin
  with src as (
    select d.partner_order_id, d.dispatched_at, d.rto_at, d.delivered_date,
           (select min((s->>'at')::timestamptz) from jsonb_array_elements(coalesce(d.scans,'[]'::jsonb)) s where s->>'label' = 'out_for_delivery') as first_ofd,
           (select array_agg((s->>'at')::timestamptz order by (s->>'at')::timestamptz) from jsonb_array_elements(coalesce(d.scans,'[]'::jsonb)) s where s->>'label' = 'out_for_delivery') as ofd_all,
           (select max((s->>'at')::timestamptz) from jsonb_array_elements(coalesce(d.scans,'[]'::jsonb)) s) as last_scan
      from docpharma_orders d
     where d.order_date > now() - p_since
  ),
  upd as (
    update shipment_journey_ecom j
       set dispatched_at       = coalesce(j.dispatched_at, s.dispatched_at),
           rto_at              = coalesce(j.rto_at, case when j.outcome = 'rto' then s.rto_at end),
           delivered_at        = coalesce(j.delivered_at, case when j.outcome = 'delivered' then s.delivered_date end),
           out_for_delivery_at = coalesce(j.out_for_delivery_at, s.first_ofd),
           ofd_dates           = case when (j.ofd_dates is null or cardinality(j.ofd_dates) = 0) and s.ofd_all is not null then s.ofd_all else j.ofd_dates end,
           last_ofd_at         = coalesce(j.last_ofd_at, case when s.ofd_all is not null then s.ofd_all[cardinality(s.ofd_all)] end),
           last_scan_at        = greatest(j.last_scan_at, s.last_scan),
           updated_at          = now()
      from src s
     where j.source = 'docpharma' and j.order_name = s.partner_order_id
       and (   (j.dispatched_at is null and s.dispatched_at is not null)
            or (j.rto_at is null and j.outcome = 'rto' and s.rto_at is not null)
            or (j.delivered_at is null and j.outcome = 'delivered' and s.delivered_date is not null)
            or (j.out_for_delivery_at is null and s.first_ofd is not null)
            or (j.last_scan_at is distinct from greatest(j.last_scan_at, s.last_scan) and s.last_scan is not null))
     returning 1
  )
  select count(*) into v_n from upd;
  return v_n;
end $$;

-- Per-order push, fired by the portal sync writing docpharma_orders.
create or replace function public.docpharma_orders_journey_trg() returns trigger language plpgsql as $$
begin
  update shipment_journey_ecom j
     set dispatched_at       = coalesce(j.dispatched_at, new.dispatched_at),
         rto_at              = coalesce(j.rto_at, case when j.outcome = 'rto' then new.rto_at end),
         delivered_at        = coalesce(j.delivered_at, case when j.outcome = 'delivered' then new.delivered_date end),
         out_for_delivery_at = coalesce(j.out_for_delivery_at, (select min((s->>'at')::timestamptz) from jsonb_array_elements(coalesce(new.scans,'[]'::jsonb)) s where s->>'label' = 'out_for_delivery')),
         ofd_dates           = case when (j.ofd_dates is null or cardinality(j.ofd_dates) = 0)
                                    then (select array_agg((s->>'at')::timestamptz order by (s->>'at')::timestamptz) from jsonb_array_elements(coalesce(new.scans,'[]'::jsonb)) s where s->>'label' = 'out_for_delivery')
                                    else j.ofd_dates end,
         last_ofd_at         = coalesce(j.last_ofd_at, (select max((s->>'at')::timestamptz) from jsonb_array_elements(coalesce(new.scans,'[]'::jsonb)) s where s->>'label' = 'out_for_delivery')),
         last_scan_at        = greatest(j.last_scan_at, (select max((s->>'at')::timestamptz) from jsonb_array_elements(coalesce(new.scans,'[]'::jsonb)) s)),
         updated_at          = now()
   where j.source = 'docpharma' and j.order_name = new.partner_order_id;
  return new;
end $$;

drop trigger if exists trg_docpharma_orders_journey on docpharma_orders;
create trigger trg_docpharma_orders_journey
  after insert or update of scans, dispatched_at, rto_at, delivered_date on docpharma_orders
  for each row execute function public.docpharma_orders_journey_trg();

-- Hourly backstop: a journey row created AFTER its portal row (webhook first, portal later) is filled here.
select cron.schedule('docpharma-journey-dates-hourly', '50 * * * *', $$select public.sync_docpharma_journey_dates(interval '120 days')$$);

-- One-time backfill.
select public.sync_docpharma_journey_dates(interval '400 days');
