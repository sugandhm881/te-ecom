-- WHO ENDED EACH CALL, from Vobiz's own call record (2026-09-11).
--
-- The call log's reason ("stream closed" / "hangup webhook") is whichever of two events reached the server
-- first, and since 5 Sep the media stream has closed first almost every time — "hangup webhook" went from
-- 10-12 calls a day to 0 on 10 Sep, so a customer hanging up became indistinguishable from anything else.
-- The bridge now reads the carrier's CDR a few seconds after each call and stamps it here.
--
--   hangup_by    — Vobiz `hangup_source`: 'Callee' = the customer, 'Carrier' = the network, 'Vobiz' = us
--   hangup_cause — Vobiz `hangup_cause_name`: 'Normal Hangup', 'Rejected', 'No Answer', 'Busy Line', …
--   answered     — did the call ever connect? false = whatever was transcribed was the network's own
--                  announcement, so Call Insights files it as no answer
--
-- Nullable, no default: calls before this migration simply have no stamp, and every reader treats a
-- missing value as "unknown", never as "no". Safe to run while calls are live.

alter table public.agent_call_logs
    add column if not exists hangup_by    text,
    add column if not exists hangup_cause text,
    add column if not exists answered     boolean;
