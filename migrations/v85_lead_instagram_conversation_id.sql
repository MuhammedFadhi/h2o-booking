-- v85: Instagram's counterpart to v83's whatsapp_conversation_id.
--
-- Mirrors the CRM's own per-channel naming (whatsapp_messages vs
-- instagram_dm_messages as table names in message.created) — betting the
-- lead.created payload will carry instagram_conversation_id the same way
-- it's meant to carry whatsapp_conversation_id. NEEDS CONFIRMATION from
-- whoever maintains crm.a3sixty.com: the exact field name, and the
-- equivalent messages API path (assumed to be
-- /api/v1/instagram/conversations/{id}/messages, mirroring the documented
-- WhatsApp one — see api/admin/crm-chat.js).

ALTER TABLE leads ADD COLUMN IF NOT EXISTS instagram_conversation_id text;
