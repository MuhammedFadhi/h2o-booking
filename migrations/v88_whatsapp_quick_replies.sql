-- v88: Quick-reply templates for the direct WhatsApp page.
--
-- The CRM chat's "/" templates pulled from the CRM's own reply-templates
-- API — not available anymore now that WhatsApp is taken over directly, so
-- this is our own table instead, managed from a small admin UI on the
-- WhatsApp page (not the CRM's).

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
