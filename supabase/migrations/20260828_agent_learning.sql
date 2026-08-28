-- 2026-08-28 — Voice agent SELF-LEARNING loop (user: "make a self-learning model using saved transcripts").
-- Every saved call (agent_call_logs) is reviewed once by the AI: scored, its outcome classified, and its
-- generalisable LESSONS extracted. Lessons are merged across calls (reinforced, never duplicated), the
-- well-evidenced ones are ACTIVATED and injected into both voice agents' prompts, and every step is
-- recorded so the Customer Support → Agent Learning dashboard can show what improved and what was learnt.
-- APPLIED to the live project on 2026-08-28 via the Supabase MCP.

create table if not exists agent_call_reviews_ecom (
  id               bigserial primary key,
  call_id          uuid not null unique,                 -- agent_call_logs.id — one review per call, ever
  call_type        text,
  language         text,                                 -- normalised name: Hindi / English / Punjabi …
  called_at        timestamptz,
  outcome          text,                                 -- confirmed | cancelled | reattempt | no_answer | unclear | other
  scores           jsonb not null default '{}'::jsonb,   -- { clarity, empathy, brevity, correctness, language_fit, overall } 0-10
  strengths        jsonb not null default '[]'::jsonb,
  issues           jsonb not null default '[]'::jsonb,
  customer_signals jsonb not null default '[]'::jsonb,   -- objections / language asks / screener etc.
  lesson_candidates jsonb not null default '[]'::jsonb,  -- raw candidates before merge
  lesson_ids       bigint[] not null default '{}',       -- lessons this call reinforced / created
  model            text,
  reviewed_at      timestamptz not null default now(),
  error            text
);
create index if not exists idx_agent_reviews_called on agent_call_reviews_ecom(called_at desc);

create table if not exists agent_lessons_ecom (
  id               bigserial primary key,
  title            text not null,
  rule             text not null,                        -- the instruction injected into the prompt (English, ≤ 240 chars)
  category         text not null default 'other',       -- opening | screening | confirmation | language | tone | objection | closing | other
  call_type        text not null default 'all',
  language         text not null default 'all',
  status           text not null default 'proposed',     -- proposed | active | retired
  source           text not null default 'auto',         -- auto | human
  confidence       numeric not null default 0.5,
  times_reinforced int  not null default 1,
  evidence         jsonb not null default '[]'::jsonb,   -- [{ call_id, called_at, quote }]
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  activated_at     timestamptz,
  retired_at       timestamptz,
  decided_by       text,
  note             text
);
create index if not exists idx_agent_lessons_status on agent_lessons_ecom(status);

create table if not exists agent_learning_runs_ecom (
  id                bigserial primary key,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  trigger           text,                                -- cron | manual
  calls_reviewed    int not null default 0,
  calls_failed      int not null default 0,
  lessons_new       int not null default 0,
  lessons_reinforced int not null default 0,
  lessons_activated int not null default 0,
  error             text
);

alter table agent_call_reviews_ecom  enable row level security;
alter table agent_lessons_ecom       enable row level security;
alter table agent_learning_runs_ecom enable row level security;
