-- A FAST, EXACT PHONE SEARCH FOR THE WHATSAPP CHAT (2026-09-11).
--
-- The order popup's WhatsApp card loads the customer's thread with
--     msg91_messages.phone ILIKE '%<last 10 digits>'
-- (app/api/msg91_wa.js, GET /support/wa/chat). A leading wildcard cannot use an ordinary index, so every
-- open read the whole table: 1.1–2.0 s when it was cached, and — measured on TE25-46873 — past the 8-second
-- statement timeout when it was not, at which point the error was swallowed and the chat quietly showed
-- only replies and manual sends, with every outbound message missing.
--
-- A trigram index serves exactly that ILIKE — same query, same rows, same order — without the full scan.
-- Nothing in the application changes; the planner starts using the index as soon as it exists.
-- (An exact-format lookup was also measured — 99 ms — but ~0.35% of stored phones use other formats, so
-- it could not be proven to return the same messages. This index keeps the wildcard's exact meaning.)
--
-- Safe while the app is live. The build takes seconds on a table this size and briefly blocks writes to
-- msg91_messages only (the mirror sync retries). To avoid even that, run the two statements separately and
-- use CREATE INDEX CONCURRENTLY for the second (it cannot run inside a transaction block).

create extension if not exists pg_trgm;

create index if not exists msg91_messages_phone_trgm
    on public.msg91_messages using gin (phone gin_trgm_ops);
