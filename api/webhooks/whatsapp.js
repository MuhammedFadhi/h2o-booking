// SA'DA H2O — WhatsApp Business (Meta Cloud API) direct webhook
// ============================================================================
// Meta calls this directly now — WhatsApp no longer relays through the
// external CRM. Configure at Meta App Dashboard → WhatsApp → Configuration
// → Webhook:
//   Callback URL:  https://<worker-domain>/api/webhooks/whatsapp
//   Verify token:  WHATSAPP_VERIFY_TOKEN (set as a Worker secret)
//   Subscribe to:  messages
//
// GET  = Meta's one-time verification handshake (hub.mode/hub.verify_token/
//        hub.challenge). POST = the actual message/status webhook, signed
//        with X-Hub-Signature-256 over the raw body using WHATSAPP_APP_SECRET.
//
// No AI auto-reply here — this is receive/store/manual-reply only, per the
// explicit scope this was built to.
// ============================================================================

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const GRAPH_VERSION = 'v21.0';

// Raw-body route (see worker/index.js) — the signature is computed over the
// exact bytes Meta sent; re-serializing parsed JSON would never match.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    if (typeof req.body === 'string') return resolve(req.body);
    if (Buffer.isBuffer(req.body)) return resolve(req.body.toString('utf8'));
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function verifySignature(raw, header, secret) {
  if (!header) return false;
  const m = /^sha256=([0-9a-f]+)$/i.exec(String(header).trim());
  if (!m) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'hex');
  const gotBuf = Buffer.from(m[1], 'hex');
  return expBuf.length === gotBuf.length && crypto.timingSafeEqual(expBuf, gotBuf);
}

async function sb(method, path, body, extraHeaders) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      ...(extraHeaders || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

async function uploadToStorage(path, buffer, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/whatsapp-media/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'true'
    },
    body: buffer
  });
  if (!r.ok) { const e = new Error(await r.text()); e.status = r.status; throw e; }
  return `${SUPABASE_URL}/storage/v1/object/public/whatsapp-media/${path}`;
}

// Meta's media URLs expire within minutes, so every inbound attachment is
// downloaded and re-hosted in our own storage immediately — anything we
// deferred would be a broken link by the time someone opens the inbox.
// niceFilename (WhatsApp's own document.filename, when the message carries
// one) gets folded into the storage path so the UI can show a real
// filename instead of just the opaque media id — see renderWhatsappMessages.
async function fetchAndStoreMedia(mediaId, messageType, niceFilename) {
  const info = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` }
  })).json();
  if (!info?.url) throw new Error('Meta returned no media URL for ' + mediaId);

  const fileRes = await fetch(info.url, { headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` } });
  if (!fileRes.ok) throw new Error(`Could not download media ${mediaId}: ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const ext = (info.mime_type || '').split('/')[1]?.split(';')[0] || messageType;
  const safeName = niceFilename ? String(niceFilename).replace(/[^a-zA-Z0-9._-]/g, '_') : null;
  const path = safeName ? `${mediaId}_${safeName}` : `${mediaId}.${ext}`;
  return uploadToStorage(path, buffer, info.mime_type);
}

// Saudi-leaning normalizer like the rest of this app, but accepts any
// plausible international number — WhatsApp contacts aren't Saudi-only.
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s()-]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('966')) p = '+' + p;
  else if (p.startsWith('05')) p = '+966' + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = '+966' + p;
  else if (!p.startsWith('+')) p = '+' + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

async function findOrCreateConversation(phone, contactName) {
  const existing = await sb('GET', `/rest/v1/whatsapp_conversations?phone=eq.${encodeURIComponent(phone)}&select=id`);
  if (existing?.length) {
    if (contactName) {
      await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${existing[0].id}`, { contact_name: contactName });
    }
    return existing[0].id;
  }
  const created = await sb('POST', '/rest/v1/whatsapp_conversations', { phone, contact_name: contactName || null }, { Prefer: 'return=representation' });
  return created[0].id;
}

function messageBodyAndType(message) {
  const type = message.type || 'text';
  if (type === 'text') return { type, body: message.text?.body || null, mediaId: null, filename: null };
  const media = message[type]; // image/audio/video/document all carry { id, mime_type, caption?, ... }
  return { type, body: media?.caption || null, mediaId: media?.id || null, filename: media?.filename || null };
}

async function handleInboundMessage(message, contact) {
  const phone = normalizePhone(message.from);
  if (!phone) return; // can't file it anywhere sensible without a phone
  const conversationId = await findOrCreateConversation(phone, contact?.profile?.name);

  const { type, body, mediaId, filename } = messageBodyAndType(message);
  let mediaUrl = null;
  if (mediaId) {
    try { mediaUrl = await fetchAndStoreMedia(mediaId, type, filename); }
    catch (err) { console.error('whatsapp media fetch failed:', mediaId, err.message); }
  }

  const sentAt = message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString();
  await sb('POST', '/rest/v1/whatsapp_messages?on_conflict=wa_message_id', {
    conversation_id: conversationId,
    wa_message_id: message.id || null,
    direction: 'inbound',
    message_type: type,
    body,
    media_id: mediaId,
    media_url: mediaUrl,
    status: 'sent',
    sent_at: sentAt
  }, { Prefer: 'resolution=ignore-duplicates' });

  // PostgREST's JSON PATCH body can't express `unread_count = unread_count
  // + 1` directly, so read-modify-write instead — acceptable here since
  // Meta serializes webhook deliveries per conversation rather than firing
  // genuinely concurrent ones.
  const preview = body || (mediaId ? `[${type}]` : '');
  const rows = await sb('GET', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}&select=unread_count`);
  const current = rows?.[0]?.unread_count || 0;
  await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, {
    last_message_at: sentAt,
    last_message_preview: preview.slice(0, 200),
    unread_count: current + 1
  });
}

async function handleStatusUpdate(status) {
  if (!status?.id || !status?.status) return;
  const allowed = new Set(['sent', 'delivered', 'read', 'failed']);
  if (!allowed.has(status.status)) return;
  const errorMsg = status.errors?.[0]?.title || null;
  await sb('PATCH', `/rest/v1/whatsapp_messages?wa_message_id=eq.${encodeURIComponent(status.id)}`, {
    status: status.status,
    status_error: errorMsg
  }).catch((err) => console.error('whatsapp status update failed:', status.id, err.message));
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query || {};
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === WHATSAPP_VERIFY_TOKEN) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).end(String(q['hub.challenge'] || ''));
    }
    return res.status(403).end('Forbidden');
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SERVICE_KEY || !WHATSAPP_APP_SECRET || !WHATSAPP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers['x-hub-signature-256'], WHATSAPP_APP_SECRET)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  try {
    const entries = payload?.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const contact = (value.contacts || [])[0];
        for (const message of value.messages || []) {
          await handleInboundMessage(message, contact);
        }
        for (const status of value.statuses || []) {
          await handleStatusUpdate(status);
        }
      }
    }
  } catch (err) {
    // Meta retries aggressively on non-2xx and can eventually disable the
    // webhook — log and still ack, rather than risk that over one bad event.
    console.error('whatsapp webhook processing error:', err);
  }

  return res.status(200).json({ ok: true });
};
