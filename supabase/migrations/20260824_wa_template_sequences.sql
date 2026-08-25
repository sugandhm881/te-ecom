-- Manual WhatsApp sends from the Call Queue popup — templates as DATA, sequences as rows.
--
-- The plan changed (2026-08-24): messages do NOT go automatically. The team calls the customer; when a
-- call goes unanswered they press ONE button in the order popup which sends the NEXT version of a
-- template sequence (V1 → V2 → V3 → done). Adding a template or a whole new sequence is an INSERT
-- here — never a code change. The variable list is a jsonb array naming which order fields fill
-- body_1..body_N, in order, from a fixed vocabulary the server resolves.
create table if not exists public.wa_template_sequences_msg91 (
    id            bigint generated always as identity primary key,
    sequence_key  text    not null,                    -- e.g. 'cod_confirmation', 'cod_no_pick'
    label         text    not null,                    -- what the button says: 'COD confirmation'
    version       int     not null check (version >= 1),
    template_name text    not null,                    -- MSG91 template name, exactly as registered
    language      text    not null default 'en_GB',    -- must match the template's registration EXACTLY
    namespace     text,                                -- MSG91 namespace when their curl shows one
    variables     jsonb   not null default '[]',       -- ["customer_name","product","order_name","amount"] → body_1..N
    body_text     text,                                -- the template's body with {{1}}..{{N}} — the PREVIEW the agent sees before sending
    active        boolean not null default true,
    created_at    timestamptz not null default now(),
    unique (sequence_key, version)
);

-- One row per (order, sequence, version) actually sent — the progression state the button reads, and
-- the dedupe that makes "V1 disables after V1 is sent" a database fact rather than a UI hope.
create table if not exists public.wa_sends_msg91 (
    id            bigint generated always as identity primary key,
    order_name    text not null,
    sequence_key  text not null,
    version       int  not null,
    template_name text,
    phone         text,
    status        text not null default 'sending',     -- sending | sent | failed
    payload       jsonb,
    response      jsonb,
    sent_by       text,
    created_at    timestamptz not null default now(),
    unique (order_name, sequence_key, version)
);
create index if not exists idx_wa_sends_order on public.wa_sends_msg91 (order_name);

alter table public.wa_template_sequences_msg91 enable row level security;
alter table public.wa_sends_msg91 enable row level security;

-- Seed: the proven COD confirmation template (tested live to 7289804108 on 2026-08-24).
insert into public.wa_template_sequences_msg91 (sequence_key, label, version, template_name, language, namespace, variables)
-- body_text for the seed row is set by 20260824 alter (kept in Supabase migration history)
values ('cod_confirmation', 'COD confirmation', 1, 'cod_confirmation_v1', 'en_GB',
        '76ec8535_ee9d_416e_b89d_8c2362647b62',
        '["customer_name","product","order_name","amount"]'::jsonb)
on conflict (sequence_key, version) do nothing;
