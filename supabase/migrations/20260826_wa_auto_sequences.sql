-- Automatic + gated-manual WhatsApp sequences (COD lifecycle + NDR), 2026-08-26 plan. APPLIED.
-- mode: 'auto' = sent by the system (webhook/cron), never a popup button; 'manual' = popup button.
-- gate: 'call' = next version unlocks after a no-answer call (original ladder);
--       'seq'  = next version unlocks when the previous one was sent.
-- requires_hold: the sequence's buttons only appear while the order is held on Shopify.
ALTER TABLE wa_template_sequences_msg91
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS gate text NOT NULL DEFAULT 'call',
  ADD COLUMN IF NOT EXISTS requires_hold boolean NOT NULL DEFAULT false;

INSERT INTO wa_template_sequences_msg91
  (sequence_key, label, version, template_name, language, namespace, variables, body_text, active, mode, gate, requires_hold)
SELECT v.seq, v.label, v.ver, v.tpl, v.lang, '76ec8535_ee9d_416e_b89d_8c2362647b62',
       v.vars::jsonb, c.body_text, true, v.mode, 'seq', v.req_hold
FROM (VALUES
  ('cod_auto', 'COD auto-confirm',   1, 'cod_confirmation_v2',                'en_GB', '["customer_name","product","order_name","amount"]', 'auto',   false),
  ('cod_auto', 'COD auto-confirm',   2, 'cod_confirm_reminder_v1',            'en_GB', '["customer_name","product","order_name","amount"]', 'auto',   false),
  ('cod_hold', 'COD hold follow-up', 1, 'cod_confirm_missed_call_v1',         'en_GB', '["customer_name","product","order_name","amount"]', 'manual', true),
  -- cancelled template has THREE placeholders (no amount) — a 4-variable send is accepted by
  -- WhatsApp and then silently never delivered (lesson learned live)
  ('cod_hold', 'COD hold follow-up', 2, 'cod_order_cancelled_unconfirmed_v1', 'en_GB', '["customer_name","product","order_name"]',          'manual', true),
  ('ndr_auto', 'NDR follow-up',      1, 'ndr_msg',                            'en',    '["customer_name","order_name","product","ndr_reason"]', 'auto', false),
  ('ndr_auto', 'NDR follow-up',      2, 'ndr_final_attempt_v1',               'en',    '["customer_name","order_name","product","ndr_reason"]', 'auto', false),
  ('ndr_auto', 'NDR follow-up',      3, 'order_rto_v1',                       'en',    '["customer_name","order_name","product"]',           'auto',   false)
) AS v(seq, label, ver, tpl, lang, vars, mode, req_hold)
LEFT JOIN msg91_template_catalog c ON c.template_name = v.tpl
ON CONFLICT (sequence_key, version) DO NOTHING;
