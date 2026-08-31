-- 2026-08-31 (same day, addition): the 3-attempt retry ladder for the AI COD-confirmation call.
-- User spec: "if the customer is busy and confirmation not received, try 3 calls in 30 —
-- 1st instant, 2nd after 10 minutes, 3rd after 20 minutes of the 2nd; if all 3 unanswered,
-- highlight the order and then no auto calls."
-- attempts counts dials made; next_attempt_at arms the redial; status gains 'retry' (due for
-- another dial) and 'exhausted' (3 unanswered calls — highlighted in the queue, never dialed again).
alter table vobiz_auto_calls_ecom
  add column if not exists attempts        int not null default 1,
  add column if not exists last_attempt_at timestamptz,
  add column if not exists next_attempt_at timestamptz;
