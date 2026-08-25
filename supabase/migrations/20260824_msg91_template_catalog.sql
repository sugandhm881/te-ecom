-- The REAL template bodies, synced from MSG91's get-template-client API (control.msg91.com).
-- One row per template+language; body/footer are the registered text with {{n}} placeholders.
-- Kept fresh by refreshTemplateCatalog() in app/api/msg91_wa.js (lazy, at most every 6h).
CREATE TABLE IF NOT EXISTS msg91_template_catalog (
    template_name text NOT NULL,
    language      text NOT NULL,
    status        text,
    body_text     text,
    footer_text   text,
    synced_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (template_name, language)
);
ALTER TABLE msg91_template_catalog ENABLE ROW LEVEL SECURITY;

-- cod_confirmation_v2's registry body was a placeholder; this is the template as registered on MSG91.
UPDATE wa_template_sequences_msg91
SET body_text = E'Hi {{1}},\n\nWe are trying to reach you regarding your order  *{{2}}*, *{{3}}* for *{{4}}*.\n\nPlease drop a message of order confirmation or reach out to us on this number +91-8826382299\n\nBalance the Element, Balance your Skin! - The Element'
WHERE sequence_key = 'cod_confirmation' AND version = 2;
