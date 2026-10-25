-- v90: quoted replies for WhatsApp messages.
--
-- Meta's Cloud API supports real reply-threading (unlike editing, which it
-- doesn't support at all): a send can include context.message_id (Meta's
-- own wamid, not our row's uuid) to make it show as a quoted reply on the
-- recipient's phone, and an inbound message that was sent as a reply
-- carries that same wamid back in its own `context.id` field. This column
-- stores that wamid for both directions; the quoted snippet itself is
-- resolved client-side from the already-loaded thread (see
-- renderWhatsappMessages in dashboard.html) rather than duplicated here.

ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS reply_to_wa_message_id text;
