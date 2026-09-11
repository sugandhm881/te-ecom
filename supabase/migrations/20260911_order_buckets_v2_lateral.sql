-- ORDER_BUCKETS, REWRITTEN TO LOOK UP EACH ORDER — STEP 1 OF 2: BUILT BESIDE THE LIVE VIEW (2026-09-11).
--
-- Nothing live changes in this step. It adds five indexes and a SECOND view, `order_buckets_v2`, so the two
-- can be compared column-for-column on every order before anything is switched. Step 2 (a separate file,
-- written only once the comparison is clean) replaces `order_buckets` with this definition.
--
-- WHY THE LIVE VIEW IS SLOW. Each CTE builds "the latest row per key" over an ENTIRE table — all tracking
-- rows, all RapidShyp scans, all journeys, all customer tags, every WhatsApp message. Postgres can narrow the
-- two keyed on order_id to the order being asked for, but the four joined on awb / phone / email / order name
-- are rebuilt in full on EVERY query, even one that reads a single order. Measured on one order: courier and
-- partner (order_id-keyed only) 0.17 s; bucket (needs RapidShyp + journey) 1.1-1.3 s; msg91_confirmed 1.5 s —
-- for a column that is always false, since msg91_messages holds outbound messages only and the CTE filters on
-- direction = 'incoming'. The Status-changed tab's `in (300 ids)` reads of this view are what hit the 8 s
-- statement timeout.
--
-- THE REWRITE. Each DISTINCT ON CTE becomes a LEFT JOIN LATERAL ... ORDER BY <the same keys> LIMIT 1 on the
-- same key, with the same WHERE and the same ORDER BY, so every order gets the same "latest" row. The SELECT
-- list is copied verbatim: the same 23 columns, same names, same order, same expressions. `dispatch_times`
-- becomes a lateral min() — which returns NULL where the old GROUP BY returned no row, the same value either way.
-- The one place old and new may legitimately differ is an exact tie on the ORDER BY keys, where both versions
-- pick an arbitrary row; the comparison script reports it if it happens at all.

-- ── indexes the per-order lookups use ────────────────────────────────────────────────────────────────
create index if not exists order_tracking_order_latest_idx
    on public.order_tracking (order_id, last_tracked_at desc nulls last, updated_at desc);
create index if not exists rapidshyp_tracking_ecom_awb_latest_idx
    on public.rapidshyp_tracking_ecom (awb, updated_at desc nulls last);
create index if not exists msg91_messages_incoming_phone_idx
    on public.msg91_messages (phone, sent_at desc nulls last)
    where direction = 'incoming' and content is not null;
create index if not exists order_customers_lower_email_idx
    on public.order_customers (lower(email));
create index if not exists shipment_journey_ecom_order_key_idx
    on public.shipment_journey_ecom ((replace(order_name, '#', '')), updated_at desc nulls last);

-- ── the rewritten view, beside the live one ─────────────────────────────────────────────────────────
create or replace view public.order_buckets_v2 as
 SELECT o.id AS order_id,
    o.name AS order_name,
    o.phone,
    o.email,
    o.total_price,
    o.created_at,
    o.cancelled_at,
    o.fulfillment_status,
    COALESCE(lr.raw_status, lt.tracking_status, o.tracking_status) AS tracking_status,
    COALESCE(lt.partner_source, lower(o.courier_name)) AS partner,
    COALESCE(lt.tracking_courier, o.courier_name) AS courier,
    o.awb_number,
    lt.delivered_date,
    GREATEST(lt.last_tracked_at, lr.updated_at) AS last_tracked_at,
    dt.dispatch_at,
    lt.edd,
    COALESCE(lt.tracking_details::text ~~* '%"rapidshyp_status_code": "UND"%'::text, false) AS has_und_scan,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'cancelled'::text
            WHEN lj.outcome = 'delivered'::text THEN 'delivered'::text
            WHEN lj.outcome = 'rto'::text THEN 'rto'::text
            WHEN regexp_replace(lower(COALESCE(lr.raw_status, ''::text)), '[_\-\s]+'::text, ' '::text, 'g'::text) ~ '(^| )rto( |$)'::text THEN 'rto'::text
            WHEN regexp_replace(lower(COALESCE(lt.tracking_status, o.tracking_status, ''::text)), '[_\-\s]+'::text, ' '::text, 'g'::text) ~ '(^| )rto( |$)'::text THEN 'rto'::text
            WHEN lower(COALESCE(lr.raw_status, ''::text)) = 'delivered'::text THEN 'delivered'::text
            WHEN lower(COALESCE(lt.tracking_status, o.tracking_status, ''::text)) = 'delivered'::text THEN 'delivered'::text
            WHEN dt.dispatch_at IS NOT NULL AND ((regexp_replace(lower(COALESCE(lt.tracking_status, o.tracking_status, ''::text)), '[_\-\s]+'::text, ' '::text, 'g'::text) = ANY (ARRAY['exception'::text, 'ndr'::text, 'undelivered'::text, 'lost'::text, 'damaged'::text, 'failed delivery'::text, 'out for delivery failed'::text, 'delivery delayed'::text, 'misrouted'::text, 'disposed off'::text, 'partially delivered'::text])) OR lt.tracking_details::text ~~* '%"rapidshyp_status_code": "UND"%'::text OR lt.tracking_details::text ~~* '%"latest_ndr_reason_code": "UND%'::text) THEN 'undelivered'::text
            WHEN (lj.outcome = ANY (ARRAY['ndr_pending'::text, 'ndr'::text, 'undelivered'::text, 'exception'::text])) AND COALESCE(lj.out_for_delivery_at, lj.dispatched_at) IS NOT NULL AND COALESCE(lj.is_final, false) = false THEN 'undelivered'::text
            WHEN dt.dispatch_at IS NULL THEN 'order_to_dispatch'::text
            WHEN (EXTRACT(epoch FROM now() - o.created_at) / 86400::numeric) <= 2::numeric THEN 'dispatch_plus_2'::text
            WHEN (EXTRACT(epoch FROM now() - o.created_at) / 86400::numeric) <= 5::numeric THEN 'two_to_five_days'::text
            ELSE 'five_days_plus'::text
        END AS bucket,
    COALESCE(lower(TRIM(BOTH FROM lm.content)) = 'yes, i want it.'::text OR lower(TRIM(BOTH FROM lm.content)) ~~ 'yes, i want it%'::text, false) AS msg91_confirmed,
    lm.content AS msg91_response_text,
    lm.sent_at AS msg91_response_at,
    COALESCE(lt.tracking_details::text ~~* '%"latest_ndr_reason_code": "UND%'::text, false) AS is_und_ndr,
    COALESCE(rc.email IS NOT NULL, false) AS is_repeat_customer
   FROM orders o
     -- latest_tracking: DISTINCT ON (order_id) ... ORDER BY order_id, last_tracked_at DESC NULLS LAST, updated_at DESC
     LEFT JOIN LATERAL (
         SELECT ot.tracking_status, ot.source AS partner_source, ot.courier_name AS tracking_courier,
                ot.delivered_date, ot.last_tracked_at, ot.status_updated_at, ot.edd, ot.tracking_details
           FROM order_tracking ot
          WHERE ot.order_id = o.id
          ORDER BY ot.last_tracked_at DESC NULLS LAST, ot.updated_at DESC
          LIMIT 1) lt ON true
     -- latest_rapidshyp: DISTINCT ON (awb) ... ORDER BY awb, updated_at DESC NULLS LAST
     LEFT JOIN LATERAL (
         SELECT rt.raw_status, rt.updated_at
           FROM rapidshyp_tracking_ecom rt
          WHERE rt.awb = o.awb_number
          ORDER BY rt.updated_at DESC NULLS LAST
          LIMIT 1) lr ON true
     -- dispatch_times: min(status_updated_at) over the same filtered rows, for this order
     LEFT JOIN LATERAL (
         SELECT min(ot.status_updated_at) AS dispatch_at
           FROM order_tracking ot
          WHERE ot.order_id = o.id
            AND ot.tracking_status IS NOT NULL
            AND (regexp_replace(lower(ot.tracking_status), '[_\-\s]+'::text, ' '::text, 'g'::text) <> ALL (ARRAY['pickup pending'::text, 'pickup exception'::text, 'pick up exception'::text, 'manifested'::text, 'pending'::text, 'awb assigned'::text, 'pickup scheduled'::text, 'out for pickup'::text, 'pickup completed'::text, 'untracked'::text, 'in progress'::text, ''::text]))) dt ON true
     -- latest_msg91: DISTINCT ON (phone) ... WHERE direction = 'incoming' AND content IS NOT NULL ORDER BY phone, sent_at DESC NULLS LAST
     LEFT JOIN LATERAL (
         SELECT m.content, m.sent_at
           FROM msg91_messages m
          WHERE m.phone = o.phone
            AND m.direction = 'incoming'::text AND m.content IS NOT NULL
          ORDER BY m.sent_at DESC NULLS LAST
          LIMIT 1) lm ON true
     -- repeat_customers: DISTINCT lower(email) ... WHERE email IS NOT NULL AND tags ~* '(^|,\s*)Repeat(\s*,|$)'
     LEFT JOIN LATERAL (
         SELECT lower(oc.email) AS email
           FROM order_customers oc
          WHERE lower(oc.email) = lower(o.email)
            AND oc.email IS NOT NULL
            AND oc.tags ~* '(^|,\s*)Repeat(\s*,|$)'::text
          LIMIT 1) rc ON true
     -- latest_journey: DISTINCT ON (replace(order_name,'#','')) ... ORDER BY that, updated_at DESC NULLS LAST
     LEFT JOIN LATERAL (
         SELECT j.outcome, j.out_for_delivery_at, j.dispatched_at, j.is_final
           FROM shipment_journey_ecom j
          WHERE replace(j.order_name, '#'::text, ''::text) = replace(o.name, '#'::text, ''::text)
          ORDER BY j.updated_at DESC NULLS LAST
          LIMIT 1) lj ON true;

-- The comparison view is for the backend only while it exists — nothing wider than the service role.
revoke all on public.order_buckets_v2 from anon, authenticated;
grant select on public.order_buckets_v2 to service_role;
