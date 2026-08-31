-- 2026-08-31 · per-attempt history for the AI caller. An unanswered dial opens no bridge session, so
-- agent_call_logs has nothing to show — the order modal displayed only answered calls ("all attempts
-- should show on call log history", user). Every claim() appends {n, at}; the outcome/sweep stamps
-- {result} on the last entry. Applied via MCP.
alter table vobiz_auto_calls_ecom add column if not exists attempt_log jsonb not null default '[]'::jsonb;
