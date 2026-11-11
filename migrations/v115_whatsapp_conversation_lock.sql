-- v115: a per-conversation processing lock for the WhatsApp bot pipeline -
-- see api/webhooks/_whatsappBot.js's acquireLock()/releaseLock(). Prevents
-- two webhook events for the same conversation from running the LLM
-- pipeline concurrently (observed: a slow/retried reply landing mid-flight
-- of a second message's run corrupted the history sent to the next LLM
-- call - see v113's migration note on "Requests ending with a model turn").
--
-- A timestamp (not a plain boolean) so a crashed/killed Worker invocation
-- that never reached its release still self-heals once the TTL passes,
-- instead of leaving the conversation locked forever.

ALTER TABLE whatsapp_conversations
  ADD COLUMN IF NOT EXISTS processing_until timestamptz;
