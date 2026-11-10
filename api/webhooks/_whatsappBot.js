// WhatsApp AI auto-reply pipeline — triggered once per inbound message from
// handleInboundMessage() in whatsapp.js, AFTER that message is already
// persisted. Every state-changing decision (lead creation) stays in this
// deterministic code; the LLM's JSON output only ever decides the reply
// text and intent classification — never anything that mutates a record
// directly.
//
// Doesn't share a module with whatsapp.js's own sb() (same reasoning as
// that file's header comment re: uploadToStorage/pdfFirstPageThumbnail —
// these files intentionally don't share state or helpers).

const { callLLM } = require('./_llmGateway');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GRAPH_VERSION = 'v21.0';

async function sb(method, path, body, extraHeaders) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', ...(extraHeaders || {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

// Appended to whatever the admin wrote in Settings — the bot's actual
// business rules live in system_prompt; this part is fixed and never
// editable, since the pipeline below trusts this exact shape.
const JSON_CONTRACT = `

You MUST respond with ONLY a single JSON object, no other text, no markdown code fences, matching exactly this shape:
{"should_reply": boolean, "reply": "string or null", "intent": "greeting|inquiry|support|pricing|complaint|spam|other or null", "lead_ready": boolean, "lead_data": {"name": "string or null", "product_interest": "string or null", "notes": "string or null"} or null}
should_reply is false for spam, threats, or legal/emergency issues (those get flagged for a human instead) — in that case reply may be null.`;

// Sent when the pipeline throws before any real reply went out (e.g. the
// LLM provider timed out on both retries) — otherwise a customer's message
// just vanishes with no reply and no sign anything was wrong.
const FALLBACK_ERROR_MESSAGE = "Sorry, I'm having trouble responding right now. Our team will get back to you shortly. 🙏";

async function getConfig() {
  const rows = await sb('GET', '/rest/v1/whatsapp_automation_configs?select=*&limit=1');
  return rows?.[0] || null;
}

// business_hours_start/end are 'HH:MM' in business_hours_timezone. Uses
// Intl to resolve "now" in that timezone without pulling in a date library.
function isWithinBusinessHours(config) {
  if (!config.business_hours_enabled) return true;
  if (!config.business_hours_start || !config.business_hours_end) return true;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: config.business_hours_timezone || 'Asia/Riyadh',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date());
    const hh = parts.find((p) => p.type === 'hour').value;
    const mm = parts.find((p) => p.type === 'minute').value;
    const nowMinutes = Number(hh) * 60 + Number(mm);
    const [sh, sm] = config.business_hours_start.split(':').map(Number);
    const [eh, em] = config.business_hours_end.split(':').map(Number);
    const startMinutes = sh * 60 + sm, endMinutes = eh * 60 + em;
    return startMinutes <= endMinutes
      ? nowMinutes >= startMinutes && nowMinutes < endMinutes
      : nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps past midnight
  } catch {
    return true; // never block replies over a malformed timezone/time string
  }
}

async function sendOutboundText(conversationId, phone, text) {
  const sendRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: phone.replace('+', ''), type: 'text', text: { body: text } })
  });
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) throw new Error(sendJson?.error?.message || `WhatsApp send failed (${sendRes.status})`);

  const waMessageId = sendJson?.messages?.[0]?.id || null;
  const sentAt = new Date().toISOString();
  await sb('POST', '/rest/v1/whatsapp_messages', {
    conversation_id: conversationId, wa_message_id: waMessageId, direction: 'outbound',
    message_type: 'text', body: text, status: 'sent', sent_at: sentAt
  });
  await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, {
    last_message_at: sentAt, last_message_preview: text.slice(0, 200),
    last_message_direction: 'outbound', last_message_status: 'sent',
    unread_count: 0 // we're replying right now — nothing left unread
  });
}

// WhatsApp's own blue-tick read receipt — deliberately only ever called
// from here, in the same breath as actually sending a reply, never on
// plain arrival. Marking read with no reply to follow would show the
// customer their message was seen and then silently ignored.
async function markRead(waMessageId) {
  if (!waMessageId) return;
  try {
    await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: waMessageId })
    });
  } catch (err) { console.error('[wa bot] mark-read failed:', err.message); }
}

// Fills in the lead row findOrCreateConversation() already auto-created for
// this conversation — never inserts a second one. Only touches fields the
// model actually returned a value for.
async function applyLeadData(conversationId, leadData) {
  if (!leadData) return;
  const patch = {};
  if (leadData.product_interest) patch.product_interest = String(leadData.product_interest);
  if (leadData.notes) patch.notes = String(leadData.notes);
  if (leadData.name) patch.name = String(leadData.name);
  if (!Object.keys(patch).length) return;
  try {
    await sb('PATCH', `/rest/v1/leads?whatsapp_conversation_id=eq.${conversationId}`, patch);
  } catch (err) { console.error('[wa bot] lead update failed:', conversationId, err.message); }
}

function buildHistoryMessages(rows) {
  return rows
    .filter((m) => m.body) // skip media-only rows with no text to feed the model
    .map((m) => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: m.body }));
}

function parseModelJson(raw) {
  // Strip a markdown code fence if the model wrapped its JSON in one
  // despite being told not to — cheap robustness, not a trust boundary.
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const parsed = JSON.parse(cleaned);
  if (typeof parsed.should_reply !== 'boolean') throw new Error('Model response missing should_reply boolean');
  return parsed;
}

// Entry point — called from handleInboundMessage() after that message is
// already persisted. Never throws past the caller: a bot failure should
// never fail the webhook itself (Meta would just retry and re-run this).
async function maybeAutoReply({ conversationId, phone, waMessageId, aiPaused }) {
  const t0 = Date.now();
  const mark = (label) => console.log(`[wa bot timing] ${label} at +${Date.now() - t0}ms (conversation ${conversationId})`);
  let replied = false;
  try {
    mark('pipeline start');
    if (aiPaused) return; // a human already took this conversation over

    const config = await getConfig();
    mark('config fetched');
    if (!config || !config.enabled || !config.auto_reply) return;
    if (!config.llm_api_key) { console.error('[wa bot] enabled but no llm_api_key configured'); return; }

    if (!isWithinBusinessHours(config)) {
      if (config.out_of_hours_message) await sendOutboundText(conversationId, phone, config.out_of_hours_message);
      return;
    }

    // Burst-message coalescing: a customer typing "Hi" then "2" a second
    // apart would otherwise get two separate bot replies racing each
    // other. Wait briefly, then check whether a NEWER inbound message has
    // landed on this same conversation since — if so, that message's own
    // handler will see the full picture and reply once; this one backs off.
    await new Promise((r) => setTimeout(r, 1500));
    const latest = await sb('GET', `/rest/v1/whatsapp_messages?conversation_id=eq.${conversationId}&direction=eq.inbound&select=wa_message_id&order=sent_at.desc&limit=1`);
    mark('coalesce check done');
    if (latest?.[0]?.wa_message_id && waMessageId && latest[0].wa_message_id !== waMessageId) return;

    const history = await sb('GET', `/rest/v1/whatsapp_messages?conversation_id=eq.${conversationId}&select=direction,body&order=sent_at.desc&limit=15`);
    const messages = buildHistoryMessages((history || []).reverse());
    mark('history fetched');
    if (!messages.length) return; // nothing text-based to react to (e.g. a lone sticker)

    const systemPrompt = (config.system_prompt || '') + JSON_CONTRACT;
    let raw;
    try {
      raw = await callLLM({ apiKey: config.llm_api_key, systemPrompt, messages });
    } catch (primaryErr) {
      if (!config.llm_api_key_fallback) throw primaryErr;
      console.error('[wa bot] primary LLM failed, trying fallback key:', primaryErr.message);
      raw = await callLLM({ apiKey: config.llm_api_key_fallback, systemPrompt, messages });
    }
    mark('llm call done');
    const decision = parseModelJson(raw);

    if (decision.should_reply && decision.reply) {
      const text = config.signature_suffix ? `${decision.reply}\n\n${config.signature_suffix}` : decision.reply;
      await markRead(waMessageId);
      await sendOutboundText(conversationId, phone, text);
      replied = true;
      mark('reply sent');
    }
    if (decision.lead_ready) await applyLeadData(conversationId, decision.lead_data);
    mark('pipeline end');
  } catch (err) {
    mark('pipeline failed: ' + err.message);
    console.error('[wa bot] pipeline failed for conversation', conversationId, err.message);
    if (!replied) {
      try {
        await sendOutboundText(conversationId, phone, FALLBACK_ERROR_MESSAGE);
      } catch (fallbackErr) {
        console.error('[wa bot] fallback message also failed for conversation', conversationId, fallbackErr.message);
      }
    }
  }
}

module.exports = { maybeAutoReply };
