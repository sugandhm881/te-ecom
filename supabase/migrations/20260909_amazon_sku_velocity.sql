-- ─────────────────────────────────────────────────────────────────────────────
-- THE FBA RESTOCK PLAN WAS FORECASTING FROM A THIRD OF THE DEMAND.
--
-- `fba_sku_velocity` filters `fulfillment_channel = 'AFN'`, so the plan's DRR only
-- ever saw Amazon's FBA orders. Over the last 90 days:
--
--     MFN (merchant-fulfilled / FBM)   2,354 units across 39 ASINs
--     AFN (Amazon-fulfilled / FBA)     1,589 units across  4 ASINs
--
-- Last 30 days: 912 MFN + 436 AFN. The plan computed DRR from the 436 — **32% of
-- the real Amazon demand** — and could not see 35 of the 39 ASINs at all, so a
-- product selling well on FBM looked like a product with no demand.
--
-- User, 2026-09-09: "on FBA forecasting dashboard need to overall sale FBM & FBA
-- and then calc DRR".
--
-- This returns BOTH channels combined AND kept apart, so the plan can forecast on
-- total demand while the page still shows where that demand came from — the split
-- is the thing to check before shipping warehouse stock into FBA.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.amazon_sku_velocity()
returns table(
    asin text, seller_sku text, title text,
    u7 bigint, u30 bigint, u60 bigint, u90 bigint,
    afn_u7 bigint, afn_u30 bigint, afn_u90 bigint,
    mfn_u7 bigint, mfn_u30 bigint, mfn_u90 bigint,
    unit_price numeric, orders30 bigint, last_sale timestamp with time zone
)
language sql
stable
as $function$
  select oi.asin,
    -- the most recent SKU/title wins, exactly as fba_sku_velocity does
    (array_agg(oi.seller_sku order by o.purchase_date desc))[1] as seller_sku,
    (array_agg(oi.title order by o.purchase_date desc))[1] as title,
    -- BOTH channels: this is what DRR is computed from
    coalesce(sum(oi.quantity_ordered) filter (where o.purchase_date >= now()-interval '7 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.purchase_date >= now()-interval '30 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.purchase_date >= now()-interval '60 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.purchase_date >= now()-interval '90 days'),0)::bigint,
    -- …and kept apart, so the page can show where the demand came from
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='AFN' and o.purchase_date >= now()-interval '7 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='AFN' and o.purchase_date >= now()-interval '30 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='AFN' and o.purchase_date >= now()-interval '90 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='MFN' and o.purchase_date >= now()-interval '7 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='MFN' and o.purchase_date >= now()-interval '30 days'),0)::bigint,
    coalesce(sum(oi.quantity_ordered) filter (where o.fulfillment_channel='MFN' and o.purchase_date >= now()-interval '90 days'),0)::bigint,
    round(avg((nullif(oi.item_price::text,''))::numeric / nullif(oi.quantity_ordered,0))
          filter (where (nullif(oi.item_price::text,''))::numeric > 0), 2) as unit_price,
    count(distinct o.amazon_order_id) filter (where o.purchase_date >= now()-interval '30 days')::bigint,
    max(o.purchase_date)
  from amazon_order_items oi
  join amazon_orders o on o.amazon_order_id = oi.amazon_order_id
  where o.purchase_date >= now()-interval '90 days'
    and lower(coalesce(o.order_status,'')) not like '%cancel%'
    and oi.asin is not null
  group by oi.asin;
$function$;

comment on function public.amazon_sku_velocity() is
    'Per-ASIN Amazon demand over 7/30/60/90 days, BOTH fulfilment channels combined and also split AFN (FBA) vs MFN (FBM). Drives the FBA restock plan''s DRR, which previously saw AFN only — a third of the real demand. fba_sku_velocity is kept for the AFN-only views.';
