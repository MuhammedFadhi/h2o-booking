-- v92: Store the CRM's WhatsApp conversation id on each synced lead.
--
-- Needed to read/send messages via the CRM's own chat API
-- (GET/POST https://crm.a3sixty.com/api/v1/whatsapp/conversations/{id}/messages)
-- from the admin Leads page. Only leads synced via /api/webhooks/crm going
-- forward will have this populated — older leads (and ones added manually
-- in the sales portal) simply have no chat available, which the UI treats
-- as "no conversation to show" rather than an error.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS whatsapp_conversation_id text;
