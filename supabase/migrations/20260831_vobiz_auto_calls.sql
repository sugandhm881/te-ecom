-- 2026-08-31 — the AI-call turnstile for automatic outbound calls.
-- Spec (user): "For 1500 and above order (this ONLY reason) which is in hold list, initiate an AI call
-- for COD order confirmation" — test on VOBIZ_CALL_ALLOWLIST first, everyone after cut-over.
-- One row per (order, purpose): UNIQUE makes "call once" a database fact, read BEFORE written
-- (the 2026-08-30 lesson — never use the 23505 rejection as the normal already-done path).
-- status: calling | placed | failed | skipped | gated. 'gated' = the test allowlist refused the number;
-- those rows are RETRYABLE — after cut-over the same order can still get its call.
create table if not exists vobiz_auto_calls_ecom (
  id          bigserial primary key,
  order_name  text not null,               -- bare, no '#'
  purpose     text not null default 'cod_confirm',
  phone       text,
  status      text not null default 'calling',
  sid         text,                        -- vobiz_bridge session id, joins agent_call_logs via order
  detail      jsonb,
  created_at  timestamptz not null default now(),
  unique (order_name, purpose)
);
create index if not exists idx_vobiz_auto_calls_created on vobiz_auto_calls_ecom(created_at desc);
alter table vobiz_auto_calls_ecom enable row level security;   -- service-role only, like every *_ecom table
