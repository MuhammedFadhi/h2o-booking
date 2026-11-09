-- v108: WhatsApp AI auto-reply bot.
--
-- Prompt-engineered LLM call with injected conversation history and a
-- forced JSON output contract (see api/webhooks/_whatsappBot.js) — NOT a
-- fine-tuned model. Every state-changing decision (lead creation) still
-- goes through deterministic backend code; the LLM only ever decides
-- whether/what to reply and classifies intent.
--
-- Singleton config table — one row, read via order+limit 1 rather than a
-- fixed id, so the app never has to special-case "no row yet" beyond this
-- migration's own seed insert. Starts enabled=false so the bot can't go
-- live before an admin has reviewed the prompt and turned it on.

CREATE TABLE IF NOT EXISTS whatsapp_automation_configs (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enabled                 boolean NOT NULL DEFAULT false,
  auto_reply              boolean NOT NULL DEFAULT true,
  system_prompt           text,
  signature_suffix        text,
  business_hours_enabled  boolean NOT NULL DEFAULT false,
  business_hours_start    text,                 -- 'HH:MM', 24h, in business_hours_timezone
  business_hours_end      text,
  business_hours_timezone text NOT NULL DEFAULT 'Asia/Riyadh',
  out_of_hours_message    text,
  llm_api_key             text,                 -- masked in Settings UI after save, never re-displayed
  updated_at              timestamptz NOT NULL DEFAULT now()
);

INSERT INTO whatsapp_automation_configs (enabled, auto_reply, system_prompt, business_hours_timezone)
SELECT false, true,
$PROMPT$You are the WhatsApp assistant for SA'DA H2O, a water purifier installation and service company in Saudi Arabia.

WHEN TO REPLY:
- Reply to greetings, questions, inquiries about products/services, and general support requests.
- Do NOT reply (set should_reply: false) to spam, threats, or anything describing a legal or medical emergency — these should be flagged for a human instead.

REPLY STYLE:
- 1-3 sentences. Use the customer's first name once if you know it, not every message.
- Never say "As an AI" or similar disclaimers.
- End with a clear next step (e.g. "Would you like me to book a visit?").
- Match the customer's tone and language (Arabic or English, formal or casual).

NEVER DO:
- Never invent prices, availability, or facts that weren't given to you in this prompt or the conversation.
- Never share another customer's information.

INTENT CLASSIFICATION:
Classify every message as one of: greeting, inquiry, support, pricing, complaint, spam, other.$PROMPT$,
  'Asia/Riyadh'
WHERE NOT EXISTS (SELECT 1 FROM whatsapp_automation_configs);

-- ── Per-conversation human takeover ─────────────────────────────────────────
-- A switch in the chat UI itself (see admin/dashboard.html) — lets an admin
-- take over one conversation without disabling the bot globally. Checked
-- first thing on every inbound message; true means store-and-skip-AI.
ALTER TABLE whatsapp_conversations ADD COLUMN IF NOT EXISTS ai_paused boolean NOT NULL DEFAULT false;

ALTER TABLE whatsapp_automation_configs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON whatsapp_automation_configs FROM anon;
DROP POLICY IF EXISTS whatsapp_automation_configs_admin_all ON whatsapp_automation_configs;
CREATE POLICY whatsapp_automation_configs_admin_all ON whatsapp_automation_configs FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- verification:
-- SELECT id, enabled, auto_reply, business_hours_enabled, business_hours_timezone FROM whatsapp_automation_configs;
-- SELECT phone, ai_paused FROM whatsapp_conversations LIMIT 5;
