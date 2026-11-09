-- v109: WhatsApp message templates — the only way to message a customer
-- once the 24-hour free-form window has closed (see the "Re-engagement
-- message" send failure). A template is created here, submitted to Meta
-- for review via api/admin/whatsapp.js's create-template action, and can
-- only actually be SENT once Meta marks it APPROVED (sync-templates
-- re-checks status, since approval happens asynchronously on Meta's side,
-- anywhere from minutes to a day or two later).
--
-- One row per template name+language, mirroring how Meta itself scopes
-- uniqueness (two templates can share a name in different languages).

CREATE TABLE IF NOT EXISTS whatsapp_message_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meta_template_id text,                 -- Meta's own id, once created there
  name             text NOT NULL,        -- lowercase_snake_case, Meta's own naming rule
  category         text NOT NULL CHECK (category IN ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  language         text NOT NULL DEFAULT 'en_US',
  body             text NOT NULL,        -- may contain {{1}}, {{2}}, ... placeholders
  variable_count   int NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
  rejected_reason  text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_message_templates_name_lang
  ON whatsapp_message_templates (name, language);

ALTER TABLE whatsapp_message_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_message_templates FROM anon;
DROP POLICY IF EXISTS whatsapp_message_templates_admin_all ON whatsapp_message_templates;
CREATE POLICY whatsapp_message_templates_admin_all ON whatsapp_message_templates FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- verification:
-- SELECT name, category, language, status, variable_count FROM whatsapp_message_templates ORDER BY created_at DESC;
