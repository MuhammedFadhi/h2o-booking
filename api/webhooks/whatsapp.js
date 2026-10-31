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
const CLOUDCONVERT_API_KEY = process.env.CLOUDCONVERT_API_KEY || '';
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

// A small JPG of a PDF's first page, for the chat bubble thumbnail (see
// v96) — mirrors api/admin/whatsapp.js's own copy (these two files don't
// share a module, same as sb()/uploadToStorage() above). A shorter poll
// budget than the admin-send path's (8x1.2s vs 20x1.5s): this runs inside
// the inbound webhook handler, which Meta expects a prompt response from,
// so a thumbnail is worth trying but never worth risking a webhook timeout
// (and a retried delivery) over. Never throws — a failure/timeout just
// means no thumbnail, same as a failed media re-host already does.
async function pdfFirstPageThumbnail(buffer, filename) {
  if (!CLOUDCONVERT_API_KEY) { console.error('[wa pdf thumb] CLOUDCONVERT_API_KEY missing'); return null; }
  try {
    const jobRes = await fetch('https://api.cloudconvert.com/v2/jobs', {
      method: 'POST',
      headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: {
          'import-1': { operation: 'import/base64', file: buffer.toString('base64'), filename: filename || 'document.pdf' },
          'convert-1': { operation: 'convert', input: 'import-1', output_format: 'jpg', pages: '1', filename: 'page-1.jpg' },
          'export-1': { operation: 'export/url', input: 'convert-1' }
        }
      })
    });
    const jobJson = await jobRes.json().catch(() => ({}));
    if (!jobRes.ok) { console.error('[wa pdf thumb] job creation failed:', jobRes.status, JSON.stringify(jobJson)); return null; }
    let job = jobJson?.data;
    if (!job?.id) { console.error('[wa pdf thumb] no job id in response:', JSON.stringify(jobJson)); return null; }

    for (let i = 0; i < 8 && job.status !== 'finished' && job.status !== 'error'; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const pollRes = await fetch(`https://api.cloudconvert.com/v2/jobs/${job.id}`, {
        headers: { Authorization: `Bearer ${CLOUDCONVERT_API_KEY}` }
      });
      const pollJson = await pollRes.json().catch(() => ({}));
      job = pollJson?.data || job;
    }
    if (job.status !== 'finished') {
      const failedTasks = (job.tasks || []).filter((t) => t.status === 'error');
      console.error('[wa pdf thumb] job did not finish, status:', job.status, 'failed tasks:', JSON.stringify(failedTasks));
      return null;
    }

    const exportTask = (job.tasks || []).find((t) => t.operation === 'export/url' && t.status === 'finished');
    const fileInfo = exportTask?.result?.files?.[0];
    if (!fileInfo?.url) { console.error('[wa pdf thumb] no exported file url, tasks:', JSON.stringify(job.tasks)); return null; }

    const imgRes = await fetch(fileInfo.url);
    if (!imgRes.ok) { console.error('[wa pdf thumb] download of converted image failed:', imgRes.status); return null; }
    return Buffer.from(await imgRes.arrayBuffer());
  } catch (err) {
    console.error('[wa pdf thumb] threw:', err.message);
    return null;
  }
}

// Meta's media URLs expire within minutes, so every inbound attachment is
// downloaded and re-hosted in our own storage immediately — anything we
// deferred would be a broken link by the time someone opens the inbox.
// niceFilename (WhatsApp's own document.filename, when the message carries
// one) gets folded into the storage path so the UI can show a real
// filename instead of just the opaque media id — see renderWhatsappMessages.
// Returns { url, thumbnailUrl } — thumbnailUrl is only ever set for a PDF.
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
  const url = await uploadToStorage(path, buffer, info.mime_type);

  let thumbnailUrl = null;
  if ((info.mime_type || '').split(';')[0].trim().toLowerCase() === 'application/pdf') {
    const thumbBuffer = await pdfFirstPageThumbnail(buffer, niceFilename);
    if (thumbBuffer) {
      try { thumbnailUrl = await uploadToStorage(`${mediaId}_thumb.jpg`, thumbBuffer, 'image/jpeg'); }
      catch (err) { console.error('whatsapp inbound PDF thumbnail upload failed:', err.message); }
    }
  }
  return { url, thumbnailUrl };
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
  const conversationId = created[0].id;
  // Every brand-new conversation becomes a lead automatically (admin
  // request — a manual "Lead" status pick in the dashboard used to be the
  // only trigger, see admin/dashboard.html's ensureWaLead, which this
  // mirrors). Starts 'unassigned', same as the conversation itself (v104) —
  // nobody's engaged with it yet. created_by_name is a fixed label, not an
  // admin's name — no admin is involved in an inbound webhook — so Sales
  // Report's per-agent stats bucket these separately instead of crediting
  // whichever admin happens to open the chat later.
  await sb('POST', '/rest/v1/leads', {
    name: contactName || phone,
    phone,
    source: 'WhatsApp',
    status: 'unassigned',
    priority: 'warm',
    created_by_name: 'WhatsApp (auto)',
    whatsapp_conversation_id: conversationId
  }).catch((err) => console.error('whatsapp auto-lead creation failed:', conversationId, err.message));
  return conversationId;
}

function messageBodyAndType(message) {
  const type = message.type || 'text';
  if (type === 'text') return { type, body: message.text?.body || null, mediaId: null, filename: null };

  // These types carry no { id, caption } media object, so without a summary
  // here they'd store with body=null and media_url=null — an empty bubble
  // with nothing to show, even though the customer did send something.
  if (type === 'reaction') {
    const emoji = message.reaction?.emoji;
    return { type, body: emoji ? `Reacted ${emoji}` : 'Reacted', mediaId: null, filename: null };
  }
  if (type === 'location') {
    const loc = message.location || {};
    const label = loc.name || loc.address || (loc.latitude && loc.longitude ? `${loc.latitude}, ${loc.longitude}` : null);
    // No media to download here — the "media" IS the coordinates, so the
    // Google Maps link goes straight into mediaUrl (via directUrl below)
    // instead of going through fetchAndStoreMedia, letting the dashboard
    // render a tappable map-pin card the same way it does for a file link.
    const mapsUrl = (loc.latitude != null && loc.longitude != null) ? `https://www.google.com/maps?q=${loc.latitude},${loc.longitude}` : null;
    return { type, body: label ? `📍 ${label}` : '📍 Shared a location', mediaId: null, filename: null, directUrl: mapsUrl };
  }
  if (type === 'contacts') {
    const names = (message.contacts || []).map((c) => c.name?.formatted_name).filter(Boolean).join(', ');
    return { type, body: names ? `👤 ${names}` : 'Shared a contact', mediaId: null, filename: null };
  }
  if (type === 'interactive') {
    const reply = message.interactive?.button_reply || message.interactive?.list_reply;
    return { type, body: reply?.title || 'Interactive reply', mediaId: null, filename: null };
  }
  if (type === 'button') {
    return { type, body: message.button?.text || 'Button reply', mediaId: null, filename: null };
  }
  if (type === 'order') {
    const items = message.order?.product_items?.length || 0;
    return { type, body: items ? `🛒 Order (${items} item${items === 1 ? '' : 's'})` : '🛒 Order', mediaId: null, filename: null };
  }
  if (type === 'system') {
    return { type, body: message.system?.body || 'System message', mediaId: null, filename: null };
  }
  if (type === 'unsupported') {
    return { type, body: 'Unsupported message type', mediaId: null, filename: null };
  }

  const media = message[type]; // image/audio/video/document/sticker all carry { id, mime_type, caption?, ... }
  return { type, body: media?.caption || null, mediaId: media?.id || null, filename: media?.filename || null };
}

async function handleInboundMessage(message, contact) {
  const phone = normalizePhone(message.from);
  if (!phone) return; // can't file it anywhere sensible without a phone
  const conversationId = await findOrCreateConversation(phone, contact?.profile?.name);

  const { type, body, mediaId, filename, directUrl } = messageBodyAndType(message);
  let mediaUrl = directUrl || null;
  let thumbnailUrl = null;
  if (mediaId) {
    try {
      const stored = await fetchAndStoreMedia(mediaId, type, filename);
      mediaUrl = stored.url;
      thumbnailUrl = stored.thumbnailUrl;
    } catch (err) { console.error('whatsapp media fetch failed:', mediaId, err.message); }
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
    thumbnail_url: thumbnailUrl,
    // Present when the customer swiped-to-reply on a specific message in
    // their own app — Meta echoes that message's wamid back here. A
    // reaction instead names its target via message.reaction.message_id
    // (no context field) — reusing this same column lets the dashboard
    // attach the reaction to that message as a badge instead of a quoted
    // block, same as WhatsApp's own UI.
    reply_to_wa_message_id: type === 'reaction' ? (message.reaction?.message_id || null) : (message.context?.id || null),
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
    unread_count: current + 1,
    // WhatsApp's own chat list never shows ticks on a message THEY sent —
    // only clearing last_message_status (rather than leaving a stale
    // outbound one behind) matters here; last_message_direction is what the
    // list actually keys its tick display off of.
    last_message_direction: 'inbound',
    last_message_status: null
  });
}

async function handleStatusUpdate(status) {
  if (!status?.id || !status?.status) return;
  const allowed = new Set(['sent', 'delivered', 'read', 'failed']);
  if (!allowed.has(status.status)) return;
  const errorMsg = status.errors?.[0]?.title || null;
  const updated = await sb('PATCH', `/rest/v1/whatsapp_messages?wa_message_id=eq.${encodeURIComponent(status.id)}`, {
    status: status.status,
    status_error: errorMsg
  }, { Prefer: 'return=representation' }).catch((err) => { console.error('whatsapp status update failed:', status.id, err.message); return null; });

  // Only reflects onto the conversation list's tick when this status
  // belongs to that conversation's most recent outbound message — a status
  // arriving late for an older message shouldn't override what's already
  // shown for a newer one sent since.
  const msg = updated?.[0];
  if (!msg) return;
  try {
    const latest = await sb('GET', `/rest/v1/whatsapp_messages?conversation_id=eq.${msg.conversation_id}&direction=eq.outbound&select=wa_message_id&order=sent_at.desc&limit=1`);
    if (latest?.[0]?.wa_message_id === status.id) {
      await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${msg.conversation_id}`, { last_message_status: status.status });
    }
  } catch (err) {
    console.error('whatsapp conversation status sync failed:', msg.conversation_id, err.message);
  }
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
