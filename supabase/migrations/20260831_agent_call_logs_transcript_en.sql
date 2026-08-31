-- 2026-08-31 · cached English translation of an AI call transcript (dashboard "Translate to English"
-- button — POST /api/support/ai-call-translate/:id). One AI pass per call ever. Applied via MCP.
alter table agent_call_logs add column if not exists transcript_en text;
