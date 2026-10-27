-- v90: Inbound webhook support for an external CRM pushing leads + messages.
--
-- Backs /api/webhooks/crm. The CRM POSTs:
--   { event: 'lead.created'|'message.created', table, timestamp, data }
--
-- lead.created rows land in `leads` (same table the Sales Portal uses), so
-- they show up in the Sales Portal / Sales Report exactly like a manually
-- entered lead. Two columns are added to support this:
--   email              — the CRM sends client_email; leads had no email column.
--   external_system/id — the CRM's own row id, so a retried/duplicate webhook
--                         delivery updates the same lead instead of creating
--                         a second one (PostgREST upsert on this pair).
-- Our own `status` (open/converted/lost) is a different, simpler vocabulary
-- than the CRM's own status/call_status — those are preserved as plain text
-- inside `notes` instead of forced into our enum.
--
-- message.created rows land in a new `crm_messages` table. The CRM's `table`
-- field (whatsapp_messages/instagram_dm_messages/messenger_messages) is
-- normalized into one `channel` column rather than three separate physical
-- tables, so all channels can be queried/displayed as one inbox later.
-- There is no phone/lead reference in the message payload the CRM described,
-- so messages are NOT auto-linked to a lead yet — lead_id stays null until
-- that's added on the CRM side or we match by conversation_id manually.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_system text;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS external_id text;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_unique
  ON leads (external_system, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS crm_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'messenger')),
  conversation_id text,
  direction       text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type    text,
  body            text,
  media_url       text,
  sent_at         timestamptz,
  lead_id         uuid REFERENCES leads(id) ON DELETE SET NULL,
  external_id     text,                      -- CRM's own message id — dedupes retried deliveries
  raw_payload     jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_messages_external_unique
  ON crm_messages (channel, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_crm_messages_conversation_id ON crm_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_crm_messages_lead_id         ON crm_messages (lead_id);

ALTER TABLE crm_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON crm_messages FROM anon;
DROP POLICY IF EXISTS crm_messages_admin_all ON crm_messages;
CREATE POLICY crm_messages_admin_all ON crm_messages FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
-- No anon/plain-authenticated policy — same reasoning as leads (v52): the
-- only write path is the webhook handler (service role).
