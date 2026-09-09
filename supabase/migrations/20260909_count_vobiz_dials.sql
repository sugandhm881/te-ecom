-- ─────────────────────────────────────────────────────────────────────────────
-- HOW MANY NUMBERS DID WE ACTUALLY RING? (user, 2026-09-09: "total attempt call
-- before total call with transcript").
--
-- Every figure on Call Insights starts from a transcript, so the page could never
-- show the dialling that produced nothing: a day where the agent rang 54 numbers
-- and recorded 29 conversations looked identical to a day of 29 dials that all
-- connected. The turnstile's `attempt_log` is the record of the dialling itself —
-- one JSON entry per attempt, each with its own `at` — so a dial is counted in the
-- same window as the calls, not by the row's own date.
--
-- Done in SQL rather than Node because the alternative is pulling every order's
-- whole attempt_log across the wire on each page load, to count array elements.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.count_vobiz_dials(from_ts timestamptz, to_ts timestamptz)
returns integer
language sql
stable
as $$
    select count(*)::int
      from public.vobiz_auto_calls_ecom v,
           lateral jsonb_array_elements(v.attempt_log) a
     where v.attempt_log is not null
       and jsonb_typeof(v.attempt_log) = 'array'
       and (a->>'at') is not null
       and (a->>'at')::timestamptz >= from_ts
       and (a->>'at')::timestamptz <= to_ts;
$$;

comment on function public.count_vobiz_dials(timestamptz, timestamptz) is
    'Dials actually placed in a window, counted from vobiz_auto_calls_ecom.attempt_log entries by their own timestamp. Feeds the "dials placed" tile on Call Insights.';
