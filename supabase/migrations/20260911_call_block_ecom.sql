-- DO NOT CALL LIST (2026-09-11). User: "make a only permission base dashboard where if i put the order that
-- order should not go any call" — first entry TE25-48244.
--
-- One row per blocked order. While a row exists, NO call of any kind is placed for that order:
--   · automatic COD confirmation calls      (vobiz_auto_calls.js — skipped before dialling, no attempt used)
--   · automatic NDR 1/2/3 and RTO calls     (same, even when a new courier NDR arrives)
--   · the manual 🤖 AI Call button           (vobiz_bridge.js placeOrderCall — refused with a reason)
--   · the manual 📞 human call button        (vobiz_manual_call.js — refused with a reason)
-- WhatsApp is deliberately NOT affected (user: "Calls only").
-- Removing the row lifts the block. The page is gated by the support-dnc permission (admins always).

create table if not exists call_block_ecom (
  order_name  text primary key,            -- bare, no '#', same key as vobiz_auto_calls_ecom
  note        text,
  added_by    text,
  created_at  timestamptz not null default now()
);
alter table call_block_ecom enable row level security;   -- service-role only, like every *_ecom table
