-- ─────────────────────────────────────────────────────────────────────────────
-- HOW LONG THE CUSTOMER'S EAR WAITED FOR EACH REPLY — one row per exchange.
-- Run this in the Supabase SQL editor. Until it exists the code degrades quietly: the insert fails,
-- the failure is logged, and the call is unaffected.
--
-- WHY. The bridge has always measured the gap and split it into its parts, but only ever printed it:
--     reply gap 1966ms = endpoint 390ms + think 1308ms + voice 268ms
-- So the evidence died with the log rotation, and "the reply is slow" could only ever be answered
-- with an impression instead of a number. The first real measurements (08 Sep) showed the BRAIN is
-- 65-70% of the wait, while endpointing and the voice — the two legs every piece of tuning advice
-- aims at — are the smallest. That is worth being able to prove, and to watch over time.
--
-- THIS IS VOICE TIME, NOT TRANSCRIPT TIME. The clock starts at `vad.speech_end` — the moment the
-- customer's VOICE stopped, not when a transcript for it arrived — and ends when the agent's audio
-- reaches them.
--
--   endpoint_ms  their voice stopped → the model was asked (the VAD hold plus the STT's own final)
--   think_ms     the model's time to a first usable sentence
--   voice_ms     synthesis of that sentence until the first audio frame goes out
--   total_ms     the three above: silence → first frame SENT
--   queued_ms    ⚠️ the honest extra. Vobiz plays our audio in order, so when her previous line is
--                still draining this reply waits behind it. Sent is not heard.
--   audible_ms   total_ms + queued_ms — what the ear actually sat through, and the number to judge
--                the conversation by. (PSTN transport, ~100-250ms, nobody here can measure.)
--
-- turn_at is when the CUSTOMER STOPPED SPEAKING, so a row reads as "at this moment they finished,
-- and then they waited this long".
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.call_turn_timings_ecom (
    id           bigserial primary key,
    call_log_id  uuid,                       -- agent_call_logs.id (the same row the transcript is on)
    order_id     text,
    call_type    text,
    language     text,
    turn_no      int,
    turn_at      timestamptz,                -- when their voice stopped
    total_ms     int,                        -- silence → first frame sent
    endpoint_ms  int,
    think_ms     int,
    voice_ms     int,
    queued_ms    int,                        -- extra wait behind her own still-playing audio
    audible_ms   int,                        -- total + queued: what the customer actually experienced
    model        text,
    created_at   timestamptz not null default now()
);

create index if not exists call_turn_timings_ecom_call_idx  on public.call_turn_timings_ecom (call_log_id);
create index if not exists call_turn_timings_ecom_order_idx on public.call_turn_timings_ecom (order_id);
create index if not exists call_turn_timings_ecom_at_idx    on public.call_turn_timings_ecom (turn_at desc);

-- Verify (expect 0 rows until the next call completes):
select count(*) as rows_so_far from public.call_turn_timings_ecom;

-- Once calls have run, this is the question it exists to answer — where the wait actually goes.
-- Judge by audible_ms; total_ms flatters us by ignoring the queue.
-- select date_trunc('day', turn_at) as day, count(*) as turns,
--        round(avg(audible_ms))  as avg_heard,
--        round(avg(endpoint_ms)) as avg_endpoint,
--        round(avg(think_ms))    as avg_think,
--        round(avg(voice_ms))    as avg_voice,
--        round(avg(queued_ms))   as avg_queued,
--        round(percentile_cont(0.9) within group (order by audible_ms)) as p90_heard
--   from public.call_turn_timings_ecom
--  where turn_at > now() - interval '7 days'
--  group by 1 order by 1 desc;

-- The turns worth listening to: everything past the ~800ms where a person assumes the line is dead.
-- select order_id, turn_no, audible_ms, endpoint_ms, think_ms, voice_ms, queued_ms, model, turn_at
--   from public.call_turn_timings_ecom
--  where audible_ms > 2500 order by turn_at desc limit 50;
