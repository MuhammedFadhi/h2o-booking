-- v78: WhatsApp conversation ownership + pipeline status, and follow-ups.
--
-- assigned_admin_name: set once, the first time any admin replies in a
-- conversation (see sendWhatsappMessage/sendWaMediaFile in dashboard.html) —
-- permanent, no reassignment UI, "first responder owns it".
--
-- status: a lightweight pipeline tag on top of the conversation itself.
-- 'follow_up' is never set directly by an admin — it's set automatically
-- when a whatsapp_followups row is added (mirrors "add a follow-up" on a
-- lead), and reverts to 'lead' once that follow-up is marked done. 'lead'
-- also inserts a real row into the leads table, deduped via
-- leads.whatsapp_conversation_id — this branch never had that column (it
-- belonged to an older, retired CRM-relay chat feature on another branch),
-- so it's added fresh here rather than reused.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_conversation_id text;

ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS assigned_admin_name text;
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE whatsapp_conversations ALTER COLUMN status SET DEFAULT 'new';
UPDATE whatsapp_conversations SET status = 'new' WHERE status IS NULL;
ALTER TABLE whatsapp_conversations ALTER COLUMN status SET NOT NULL;

ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_status_check;
ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_status_check
  CHECK (status IN ('new', 'not_interested', 'lead', 'follow_up', 'converted'));

-- ── Follow-ups, scoped to a WhatsApp conversation ──────────────────────────
-- Same shape as lead_followups (v57) on purpose — same list+add UI pattern,
-- just a different parent table.
CREATE TABLE IF NOT EXISTS whatsapp_followups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
  followup_date   date NOT NULL,
  note            text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done')),
  created_by      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_followups_conversation_id ON whatsapp_followups (conversation_id);

ALTER TABLE whatsapp_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_followups FROM anon;
DROP POLICY IF EXISTS whatsapp_followups_admin_all ON whatsapp_followups;
CREATE POLICY whatsapp_followups_admin_all ON whatsapp_followups FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
