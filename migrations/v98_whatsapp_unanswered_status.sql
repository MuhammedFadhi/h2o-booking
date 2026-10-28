-- v98: Add "Unanswered" to the WhatsApp conversation status pipeline.
--
-- Same lightweight tag as the rest of the v89 pipeline (new/not_interested/
-- lead/follow_up/converted) — this one is manually settable like
-- new/not_interested/lead/converted (not auto-managed like follow_up).

ALTER TABLE whatsapp_conversations DROP CONSTRAINT IF EXISTS whatsapp_conversations_status_check;
ALTER TABLE whatsapp_conversations ADD CONSTRAINT whatsapp_conversations_status_check
  CHECK (status IN ('new', 'unanswered', 'not_interested', 'lead', 'follow_up', 'converted'));
