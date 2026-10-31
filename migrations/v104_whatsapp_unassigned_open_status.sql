-- v104: Replace WhatsApp conversation status's 'new'/'lead' with
-- 'unassigned'/'open'. 'unassigned' is the true default (nobody's touched
-- it yet); 'open' means an admin has actually started the conversation (see
-- admin/dashboard.html's assignWaConversationIfUnassigned, which flips it on
-- a first reply). 'lead' is dropped — every new conversation already
-- auto-creates a Leads row on arrival (api/webhooks/whatsapp.js's
-- findOrCreateConversation), so a separate "Lead" status stopped meaning
-- anything distinct from "open".

ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_status_check;

UPDATE whatsapp_conversations SET status = 'unassigned' WHERE status = 'new' OR status IS NULL;
UPDATE whatsapp_conversations SET status = 'open' WHERE status = 'lead';

ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_status_check
  CHECK (status IN ('unassigned', 'open', 'unanswered', 'not_interested', 'follow_up', 'converted'));

ALTER TABLE whatsapp_conversations ALTER COLUMN status SET DEFAULT 'unassigned';

-- verification:
-- SELECT status, count(*) FROM whatsapp_conversations GROUP BY status ORDER BY status;
