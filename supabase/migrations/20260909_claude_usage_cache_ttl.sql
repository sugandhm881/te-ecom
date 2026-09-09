-- ─────────────────────────────────────────────────────────────────────────────
-- THE CACHE TTL DECIDES THE CACHE-WRITE PRICE, AND WE WERE ASSUMING THE CHEAP ONE.
--
-- Anthropic bills a prompt-cache WRITE as a multiple of the input rate, and the
-- multiple depends on how long the cache lives:
--     5-minute cache  →  1.25x input
--     1-hour cache    →  2.00x input     (beta: extended-cache-ttl-2025-04-11)
--
-- The call brain has always asked for the 1-hour cache (`CLAUDE_CACHE_TTL`
-- defaults to '1h' in vobiz_bridge.js), but both price tables charged 1.25x. On
-- 08-Sep-2026 that put the statement at $1.83 against a console figure of $2.55;
-- re-priced at 2x the same tokens come to $2.536 — a 0.6% residual, i.e. right.
-- Across the ledger's whole life so far (02→08 Sep) it under-reported $4.64 of
-- $16.08, or 29%.
--
-- Storing the TTL rather than inferring it: `CLAUDE_CACHE_TTL` is an env var, so
-- a future '5m' would silently make every stored row mispriced in the other
-- direction. The row now carries what it was actually charged under.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.claude_usage_ecom
    add column if not exists cache_ttl text;

comment on column public.claude_usage_ecom.cache_ttl is
    'Prompt-cache TTL this call requested (''1h'' / ''5m''); decides the cache-write multiplier (2.00x / 1.25x of input). NULL when the call wrote no cache.';

-- Backfill is unambiguous: every cache write in this table came from `call_brain`
-- (verified — 1,181 rows, no other source has ever written one), and the bridge
-- has requested '1h' since the ledger was created on 02-Sep-2026.
update public.claude_usage_ecom
   set cache_ttl = '1h'
 where cache_write > 0
   and cache_ttl is null;
