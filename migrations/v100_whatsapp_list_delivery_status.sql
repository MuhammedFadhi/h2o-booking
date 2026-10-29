-- v100: Delivery-status ticks on the WhatsApp conversation list (like
-- WhatsApp's own chat list), not just inside an open thread.
--
-- The list only ever stored last_message_at/last_message_preview — no way
-- to know whether the last message was outbound (so a tick even applies)
-- or what its status was, without opening the thread. Mirrors the per-
-- message status column already on whatsapp_messages.

ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_message_direction text; -- 'inbound' | 'outbound'
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS last_message_status    text; -- 'sent' | 'delivered' | 'read' | 'failed' — outbound only

-- verification:
-- SELECT phone, last_message_direction, last_message_status, last_message_preview FROM whatsapp_conversations ORDER BY last_message_at DESC LIMIT 10;
