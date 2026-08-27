-- 2026-08-27 — COD auto-confirmation V1 goes back to the original template.
-- User spec: "cod_confirmation_v1 (when order created, after 3 minutes send this)" — the 3-minute
-- delay lives in Node (msg91_wa.js: autoCodOnCreate + codInitialTick backstop); this row swap is the
-- data half. cod_confirmation_v1 is the approved en_GB template with the same four placeholders in
-- the same order (customer_name, product, order_name, amount), so `variables` is unchanged.
-- APPLIED to the live project on 2026-08-27 via the Supabase MCP.
update wa_template_sequences_msg91 s
   set template_name = 'cod_confirmation_v1',
       body_text     = c.body_text
  from msg91_template_catalog c
 where c.template_name = 'cod_confirmation_v1' and c.language = 'en_GB'
   and s.sequence_key = 'cod_auto' and s.version = 1;
