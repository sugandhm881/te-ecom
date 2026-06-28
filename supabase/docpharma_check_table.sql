-- DocPharma check cache — remembers the result of each DocPharma lookup so the
-- warehouse/DP report doesn't re-hit DocPharma for the same orders every run.
--   found = false → DocPharma doesn't have this order (a non-DocPharma order); it is
--                   skipped on future runs (re-verified weekly via the app's TTL).
--   found = true  → DocPharma has it; re-checked each run for status changes.
-- Degrades gracefully if absent (the app just falls back to checking every run).

create table if not exists public.docpharma_check_ecom (
    order_name text primary key,
    found      boolean,
    status     text,
    checked_at timestamptz default now(),
    updated_at timestamptz default now()
);

create index if not exists idx_docpharma_check_found_checked
    on public.docpharma_check_ecom (found, checked_at);
