-- v113: a second, independent LLM provider key the WhatsApp bot falls back
-- to when the primary one fails (e.g. Gemini returning 503 "high demand") -
-- see api/webhooks/_whatsappBot.js's maybeAutoReply.

ALTER TABLE whatsapp_automation_configs
  ADD COLUMN IF NOT EXISTS llm_api_key_fallback text; -- masked in Settings UI after save, never re-displayed
