// /api/admin/whatsapp — backs the admin "WhatsApp" sidebar page.
// Actions: list-conversations | get-messages | send-message | mark-read
// Auth: caller must present a Bearer token whose email is in admin_emails
// (same as every other /api/admin/* route — see ./_auth).
const { requireAdmin, SUPABASE_URL, SERVICE_KEY } = require('./_auth');

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

function bad(status, message) { const e = new Error(message); e.status = status; return e; }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID) {
    return res.status(500).json({ error: 'Server not configured (WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID missing)' });
  }

  try {
    await requireAdmin(req);
    const { action, conversationId, body, limit } = req.body || {};

    if (action === 'list-conversations') {
      const rows = await sb('GET', `/rest/v1/whatsapp_conversations?select=*&order=last_message_at.desc.nullslast&limit=${Number(limit) || 200}`);
      return res.status(200).json({ conversations: rows || [] });
    }

    if (!conversationId) return res.status(400).json({ error: 'conversationId required' });

    if (action === 'get-messages') {
      const rows = await sb('GET', `/rest/v1/whatsapp_messages?conversation_id=eq.${encodeURIComponent(conversationId)}&select=*&order=sent_at.asc&limit=${Number(limit) || 200}`);
      return res.status(200).json({ messages: rows || [] });
    }

    if (action === 'send-message') {
      const text = String(body || '').trim();
      if (!text) return res.status(400).json({ error: 'Message body required' });

      const convo = (await sb('GET', `/rest/v1/whatsapp_conversations?id=eq.${encodeURIComponent(conversationId)}&select=phone`))?.[0];
      if (!convo) throw bad(404, 'Conversation not found.');

      const sendRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: convo.phone.replace('+', ''),
          type: 'text',
          text: { body: text }
        })
      });
      const sendJson = await sendRes.json().catch(() => ({}));
      if (!sendRes.ok) throw bad(sendRes.status, sendJson?.error?.message || 'WhatsApp send failed.');

      const waMessageId = sendJson?.messages?.[0]?.id || null;
      const sentAt = new Date().toISOString();
      const inserted = await sb('POST', '/rest/v1/whatsapp_messages', {
        conversation_id: conversationId,
        wa_message_id: waMessageId,
        direction: 'outbound',
        message_type: 'text',
        body: text,
        status: 'sent',
        sent_at: sentAt
      }, { Prefer: 'return=representation' });
      await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, {
        last_message_at: sentAt,
        last_message_preview: text.slice(0, 200)
      });
      return res.status(200).json({ ok: true, message: inserted?.[0] });
    }

    if (action === 'mark-read') {
      await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, { unread_count: 0 });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: err.status ? err.message : 'Server error' });
  }
};
