-- v76: WhatsApp direct integration via the Meta Cloud API.
--
-- Backs /api/webhooks/whatsapp (Meta's inbound webhook) and the admin
-- "WhatsApp" sidebar page (/api/admin/whatsapp). A phone-number-identified
-- conversation/message model — nothing to do with the leads table beyond
-- an optional link added in a later migration (v78).
--
-- Same security shape as every other admin-only table in this app: RLS
-- restricts the `authenticated` role to admins; the webhook/admin API
-- write with the service-role key, which bypasses RLS entirely.
--
-- The unique index on wa_message_id is a plain (non-partial) index from
-- the start — a partial index (WHERE wa_message_id IS NOT NULL) can't be
-- used as a PostgREST ON CONFLICT target (error 42P10), which bit this
-- exact table on the dev branch; NULL never collides with NULL for
-- uniqueness purposes anyway, so a plain index has the same practical
-- effect without that trap.

-- ── Storage bucket for inbound media (images/audio/video/documents) ──────
-- Meta's own media URLs expire quickly (minutes), so the webhook downloads
-- and re-hosts each attachment here immediately on receipt — same public-
-- bucket, upload()+getPublicUrl() convention as installation-proofs.
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-media', 'whatsapp-media', true, 20971520) -- 20MB
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "whatsapp-media read"  ON storage.objects;
DROP POLICY IF EXISTS "whatsapp-media write" ON storage.objects;
CREATE POLICY "whatsapp-media read"  ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'whatsapp-media');
CREATE POLICY "whatsapp-media write" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'whatsapp-media');

-- ── Conversations: one row per customer phone number ──────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                text NOT NULL UNIQUE,  -- normalized +9665XXXXXXXX (or other country)
  contact_name         text,                  -- from Meta's contacts[].profile.name, latest wins
  last_message_at      timestamptz,
  last_message_preview text,
  unread_count         int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  wa_message_id   text,                        -- Meta's wamid — dedupes retried webhook deliveries,
                                                -- and is the target a later status update looks up
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type    text NOT NULL DEFAULT 'text',
  body            text,
  media_id        text,                        -- Meta's media id (kept for reference/debugging)
  media_url       text,                        -- our own permanent whatsapp-media URL, once fetched
  status          text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
  status_error    text,
  sent_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_message_id ON whatsapp_messages (wa_message_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_id ON whatsapp_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_last_message_at ON whatsapp_conversations (last_message_at DESC NULLS LAST);

ALTER TABLE whatsapp_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_conversations FROM anon;
REVOKE ALL ON whatsapp_messages FROM anon;
DROP POLICY IF EXISTS whatsapp_conversations_admin_all ON whatsapp_conversations;
DROP POLICY IF EXISTS whatsapp_messages_admin_all ON whatsapp_messages;
CREATE POLICY whatsapp_conversations_admin_all ON whatsapp_conversations FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY whatsapp_messages_admin_all ON whatsapp_messages FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
