-- Send log for the direct MSG91 COD-confirmation sender (replaces the n8n + Google-Sheet workflow).
--
-- The UNIQUE index on order_name IS the double-send guard: the sender inserts BEFORE calling MSG91,
-- so a crash between the two can at worst lose one message, never send it twice. A customer
-- double-messaged about the same order reads it as spam — and rejects.
create table if not exists public.cod_confirm_sends_msg91 (
    id          bigint generated always as identity primary key,
    order_name  text        not null unique,
    phone       text,
    status      text        not null default 'sending',   -- sending | sent | failed | dry
    payload     jsonb,                                    -- what we filled the template with
    response    jsonb,                                    -- MSG91's answer (or the error)
    created_at  timestamptz not null default now()
);

create index if not exists idx_cod_sends_created on public.cod_confirm_sends_msg91 (created_at desc);

alter table public.cod_confirm_sends_msg91 enable row level security;

comment on table public.cod_confirm_sends_msg91 is
  'One row per COD-confirmation WhatsApp send via MSG91 (direct from the dashboard server). '
  'RLS on, service-role only. UNIQUE(order_name) is the double-send guard.';
