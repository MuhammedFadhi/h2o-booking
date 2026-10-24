-- v87: Fix the same bug class as v82, this time in whatsapp_messages.
--
-- v86's wa_message_id unique index was partial (WHERE wa_message_id IS NOT
-- NULL), which Postgres refuses to match against PostgREST's plain
-- ON CONFLICT (wa_message_id) upsert target — error 42P10, "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification".
-- Confirmed live: a real inbound WhatsApp message created its conversation
-- row but the message insert silently failed, caught by the webhook's
-- top-level try/catch (which still acks 200 to Meta, so nothing retried).
--
-- A plain (non-partial) unique index has the same practical effect — NULL
-- never collides with NULL for uniqueness purposes in Postgres — while
-- also being a valid ON CONFLICT target.

DROP INDEX IF EXISTS idx_whatsapp_messages_wa_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_wa_message_id
  ON whatsapp_messages (wa_message_id);
