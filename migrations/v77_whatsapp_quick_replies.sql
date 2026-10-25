-- v77: Quick-reply templates for the direct WhatsApp page.
--
-- Own table, managed from a small admin UI on the WhatsApp page itself —
-- the slash-command "/" autocomplete in the composer reads from this.

CREATE TABLE IF NOT EXISTS whatsapp_quick_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shortcut   text NOT NULL UNIQUE,
  message    text NOT NULL,
  media_url  text,  -- optional image/file URL attached alongside the message
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_quick_replies ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_quick_replies FROM anon;
DROP POLICY IF EXISTS whatsapp_quick_replies_admin_all ON whatsapp_quick_replies;
CREATE POLICY whatsapp_quick_replies_admin_all ON whatsapp_quick_replies FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
