-- 2026-08-27 — the repeat-COD hold EVALUATION LEDGER.
-- "No order should be skipped from the rule" (user). A hold decision that leaves no trace cannot be
-- audited, and a miss (webhook not delivered, cron window, restart) is invisible. Every evaluation —
-- from the orders/create webhook, the */2 cron, the 10-minute reconciler or a manual call — writes one
-- row here: what identity was resolved, which reasons fired, and what was done about it. The
-- reconciler then guarantees coverage by construction: any COD order with NO row is evaluated.
-- APPLIED to the live project on 2026-08-27 via the Supabase MCP.
create table if not exists hold_evaluations_ecom (
  id                 bigserial primary key,
  order_name         text        not null,               -- bare, no '#'
  path               text        not null,               -- webhook | cron | reconcile | manual
  verdict            text        not null,               -- hold | no_reason | prepaid | not_holdable
  reasons            jsonb       not null default '[]'::jsonb,
  identity           jsonb,                              -- { phones[], emails[], overflow }
  history_count      int,
  shopify_repeat_tag boolean,                            -- Shopify tagged it "Repeat" (a signal we may be missing history)
  action             jsonb,                              -- holdOrderSmart() result, when a hold was attempted
  created_at         timestamptz not null default now()
);
create index if not exists idx_hold_eval_order   on hold_evaluations_ecom(order_name);
create index if not exists idx_hold_eval_created on hold_evaluations_ecom(created_at desc);
alter table hold_evaluations_ecom enable row level security;   -- service-role only, like every *_ecom table
