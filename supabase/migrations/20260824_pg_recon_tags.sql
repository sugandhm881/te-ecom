-- PG Recon: identify GoKwik membership and payment type from SHOPIFY TAGS, not gateway labels.
--
-- WHY TAGS. Asked for directly ("use Tags of Shopify to identify, don't use EasyEcom as source of
-- gateway"), and the data agrees:
--   * `orders.gateway` needs a per-order GraphQL sync and still has holes — 103 null in July,
--     466 in August. Tags arrive WITH the order at ingest: the GoKwik tag covers ~98% of orders in
--     every month of 2026, and every manual / Cashfree order carries none. No sync, no holes.
--   * The old rule charged EVERY 'cod' row regardless of processor — a manual or Cashfree COD was
--     billed to GoKwik's expectation. Membership is now explicit: GoKwik tag (or a gokwik% gateway
--     label for the rare tagged-less row), everything else reported as excluded, never guessed.
--   * Abandoned-cart recovery orders (tags KC_ABC / ABC_tellephant, ~371 in July) are EXCLUDED from
--     the charge. This is the closest thing found to GoKwik's own exclusion rule: their July COD
--     invoice says 2,765 transactions / ₹47,397.66, and the tag-based COD population minus ABC,
--     fee on the ex-shipping base, lands at ₹47,710 — within 0.66%. (All-in with ABC was ₹53,413.)
--     The residual ~185-order gap is GoKwik's to explain; ABC rows are surfaced separately so the
--     assumption is visible, not buried.
--
-- COD FEE BASE NOW EXCLUDES SHIPPING. On these orders `total_shipping` is dominated by the COD fee
-- GoKwik itself collects from the customer (the Gokwik_cod_fees tag marks it); billing us 2% on the
-- fee they collected for themselves makes no sense, and the invoice arithmetic above only converges
-- on the ex-shipping base. Config-level change, effective for the whole history of the rate row.
update public.pg_charge_config_ecom set base_excludes_shipping = true where payment_type = 'cod';

-- Return type gains `abc`, so the old signature must go first (SQL-language bodies in $$ strings are
-- not dependency-tracked, so pg_recon_summary survives the drop and picks up the new column).
drop function if exists public.pg_recon_rows(timestamp with time zone, timestamp with time zone);

create function public.pg_recon_rows(p_from timestamp with time zone, p_to timestamp with time zone)
returns table(order_name text, created_at timestamp with time zone, financial_status text, gateway text,
              payment_type text, charged boolean, abc boolean,
              order_value numeric, shipping numeric, fee_base numeric, fee_percent numeric,
              gst_percent numeric, fee numeric, gst numeric, total_charge numeric, settlement numeric)
language sql stable as $function$
    with base as (
        select o.name as order_name, o.created_at, o.financial_status, o.gateway,
               coalesce(o.total_price, 0)    as order_value,
               coalesce(o.total_shipping, 0) as shipping,
               -- ',tag1,tag2,' — Shopify separates with ', ', normalised so LIKE can test whole tags
               -- (a bare '%cod%' would also match 'ppcod-upi' and 'Gokwik_cod_fees').
               (',' || lower(replace(coalesce(o.tags, ''), ', ', ',')) || ',') as tagcsv
        from orders o
        where o.created_at >= p_from and o.created_at <= p_to
    ), t as (
        select b.*,
               (b.tagcsv like '%,gokwik,%')                                    as gk_tag,
               (b.tagcsv like '%,cod,%')                                       as cod_tag,
               (b.tagcsv like '%,gokwik_ppcod,%' or b.tagcsv like '%,gokwik_ppcod_upi,%'
                 or b.tagcsv like '%,ppcod-upi,%')                             as ppcod_tag,
               (b.tagcsv like '%,kc_abc,%' or b.tagcsv like '%,abc_tellephant,%') as is_abc
        from base b
    ), cls as (
        select t.*,
            case
                -- Tags first: they are stamped by GoKwik's own checkout at order time.
                when t.ppcod_tag or t.financial_status = 'partially_paid'      then 'partial'
                when t.cod_tag                                                 then 'cod'
                when t.gk_tag and t.financial_status in ('paid','voided','refunded','partially_refunded')
                                                                               then 'prepaid'
                -- Tagless fallback: the old gateway/status reading, kept for the ~2% without tags.
                when t.gateway ilike '%cash%on%delivery%'                      then 'cod'
                when t.gateway ilike '%ppcod%'                                 then 'partial'
                when t.financial_status in ('paid','voided','refunded','partially_refunded')
                                                                               then 'prepaid'
                when t.financial_status = 'pending'                            then 'cod'
                else 'other'
            end as payment_type,
            (t.gk_tag or coalesce(t.gateway, '') ilike 'gokwik%') as gk_member
        from t
    ), scoped as (
        select c.*,
            (c.gk_member and not c.is_abc
             and c.payment_type in ('cod','prepaid','partial'))    as is_charged,
            -- pg_charge_for matches on a gateway pattern; a tag-identified order whose gateway label
            -- never synced still has to resolve the gokwik% prepaid rate.
            coalesce(c.gateway, case when c.gk_member then 'GoKwik (by tag)' end) as rate_gateway
        from cls c
    )
    select s.order_name, s.created_at, s.financial_status, s.gateway, s.payment_type,
           s.is_charged, s.is_abc,
           s.order_value, s.shipping,
           fb.fee_base, c.fee_percent, c.gst_percent,
           round(fb.fee_base * c.fee_percent / 100, 2),
           round(fb.fee_base * c.fee_percent / 100 * c.gst_percent / 100, 2),
           round(fb.fee_base * c.fee_percent / 100 * (1 + c.gst_percent / 100), 2),
           round(s.order_value - fb.fee_base * c.fee_percent / 100 * (1 + c.gst_percent / 100), 2)
    from scoped s
    left join lateral pg_charge_for(s.payment_type, s.rate_gateway, s.created_at::date) c on true
    left join lateral (
        select case when coalesce(c.base_excludes_shipping, false)
                    then greatest(s.order_value - s.shipping, 0) else s.order_value end as fee_base
    ) fb on true;
$function$;

-- Summary: unchanged in structure, plus the ABC bucket so the exclusion is a visible number.
create or replace function public.pg_recon_summary(p_from timestamp with time zone, p_to timestamp with time zone)
returns jsonb language sql stable as $function$
    with r as (select * from pg_recon_rows(p_from, p_to))
    select jsonb_build_object(
        'totals', (select jsonb_build_object(
            'orders', count(*),
            'gross',  coalesce(sum(order_value), 0),
            'fee',    coalesce(sum(fee)   filter (where charged), 0),
            'gst',    coalesce(sum(gst)   filter (where charged), 0),
            'charge', coalesce(sum(total_charge) filter (where charged), 0),
            'charged_orders',   count(*) filter (where charged),
            'unclassified',       count(*) filter (where charged and fee is null),
            'unclassified_value', coalesce(sum(order_value) filter (where charged and fee is null), 0),
            'excluded_orders',    count(*) filter (where not charged),
            'excluded_value',     coalesce(sum(order_value) filter (where not charged), 0),
            'excluded_would_add', coalesce(sum(total_charge) filter (where not charged), 0),
            -- abandoned-cart recovery: excluded from the charge on evidence, shown so the assumption
            -- is inspectable rather than silent
            'abc_orders', count(*) filter (where abc),
            'abc_value',  coalesce(sum(order_value) filter (where abc), 0)
        ) from r),
        'by_type', (select coalesce(jsonb_agg(t order by t->>'payment_type'), '[]'::jsonb) from (
            select jsonb_build_object('payment_type', payment_type, 'charged', charged,
                'orders', count(*), 'gross', coalesce(sum(order_value),0),
                'fee_percent', max(fee_percent), 'fee', coalesce(sum(fee),0),
                'gst', coalesce(sum(gst),0), 'charge', coalesce(sum(total_charge),0)) as t
            from r group by payment_type, charged) x),
        'by_gateway', (select coalesce(jsonb_agg(g order by (g->>'charge')::numeric desc), '[]'::jsonb) from (
            select jsonb_build_object('gateway', coalesce(gateway,'(by tag — no gateway label)'),
                'orders', count(*), 'gross', coalesce(sum(order_value),0),
                'charge', coalesce(sum(total_charge) filter (where charged),0)) as g
            from r group by gateway) y),
        'monthly', (select coalesce(jsonb_agg(m order by m->>'month'), '[]'::jsonb) from (
            select jsonb_build_object('month', to_char(date_trunc('month', created_at),'YYYY-MM'),
                'orders', count(*), 'gross', coalesce(sum(order_value),0),
                'fee', coalesce(sum(fee) filter (where charged),0),
                'gst', coalesce(sum(gst) filter (where charged),0),
                'charge', coalesce(sum(total_charge) filter (where charged),0)) as m
            from r group by date_trunc('month', created_at)) z)
    );
$function$;
