// /api/admin/whatsapp — backs the admin "WhatsApp" sidebar page.
// Actions: list-conversations | get-messages | send-message | mark-read
// A multipart/form-data POST (not JSON) is a media/voice-note send instead
// — see handleSendMedia().
// Auth: caller must present a Bearer token whose email is in admin_emails
// (same as every other /api/admin/* route — see ./_auth).
const { requireAdmin, SUPABASE_URL, SERVICE_KEY } = require('./_auth');
const { remuxOpusWebmToOgg } = require('./_webmToOgg.js');

const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const GRAPH_VERSION = 'v21.0';

// Meta's send-message API only accepts these exact audio mime types.
// Chrome's MediaRecorder can only produce audio/webm — not in this list —
// so every browser-recorded voice note needs converting first.
const META_ACCEPTED_AUDIO_TYPES = new Set(['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg', 'audio/opus']);

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

async function uploadToStorage(path, buffer, contentType) {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/whatsapp-media/${path}`, {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': contentType || 'application/octet-stream', 'x-upsert': 'true' },
    body: buffer
  });
  if (!r.ok) throw bad(r.status, await r.text());
  return `${SUPABASE_URL}/storage/v1/object/public/whatsapp-media/${path}`;
}

// WhatsApp message "type" buckets — audio/image/video get their own object
// kind on the send; anything else (PDFs, etc.) is sent as "document".
function waTypeForMime(mime) {
  if (/^image\//.test(mime)) return 'image';
  if (/^audio\//.test(mime)) return 'audio';
  if (/^video\//.test(mime)) return 'video';
  return 'document';
}

// Converts an unsupported audio file (webm from browser recording, almost
// always) to ogg — a pure container remux (see _webmToOgg.js), not a
// re-encode: WebM and Ogg can both hold the same compressed Opus data, so
// this is just extracting and re-wrapping it. No external service, no
// network round-trip, no conversion-service account to maintain.
function convertAudioToOgg(buffer, filename) {
  try {
    return { buffer: remuxOpusWebmToOgg(buffer), mimeType: 'audio/ogg', filename: (filename || 'voice-note').replace(/\.[^.]+$/, '') + '.ogg' };
  } catch (err) {
    throw bad(422, 'Could not convert this audio recording: ' + err.message);
  }
}

// Shared by the file-attach/voice-note path and the quick-reply-with-image
// path: upload to Meta's media endpoint (the message-send API takes a
// media id, not an inline file), send referencing that id, then re-host
// our own permanent copy (nothing guarantees Meta's media stays fetchable
// by id indefinitely — same reasoning as the webhook's inbound handling).
async function sendMediaMessage({ conversationId, buffer, mimeType, filename, caption }) {
  const convo = (await sb('GET', `/rest/v1/whatsapp_conversations?id=eq.${encodeURIComponent(conversationId)}&select=phone`))?.[0];
  if (!convo) throw bad(404, 'Conversation not found.');

  const baseMime = mimeType.split(';')[0].trim().toLowerCase();
  if (baseMime.startsWith('audio/') && !META_ACCEPTED_AUDIO_TYPES.has(baseMime)) {
    const converted = await convertAudioToOgg(buffer, filename);
    buffer = converted.buffer;
    mimeType = converted.mimeType;
    filename = converted.filename;
  }

  const waType = waTypeForMime(mimeType);

  const uploadForm = new FormData();
  uploadForm.append('messaging_product', 'whatsapp');
  uploadForm.append('file', new Blob([buffer], { type: mimeType }), filename || 'upload');
  const uploadRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}` },
    body: uploadForm
  });
  const uploadJson = await uploadRes.json().catch(() => ({}));
  if (!uploadRes.ok || !uploadJson?.id) throw bad(uploadRes.status || 502, uploadJson?.error?.message || 'WhatsApp media upload failed.');
  const metaMediaId = uploadJson.id;

  const mediaObject = { id: metaMediaId };
  if (caption && waType !== 'audio') mediaObject.caption = String(caption); // audio has no caption field in the API

  const sendRes = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: convo.phone.replace('+', ''), type: waType, [waType]: mediaObject })
  });
  const sendJson = await sendRes.json().catch(() => ({}));
  if (!sendRes.ok) throw bad(sendRes.status, sendJson?.error?.message || 'WhatsApp send failed.');

  const ext = (mimeType.split('/')[1] || '').split(';')[0] || waType;
  let mediaUrl = null;
  try { mediaUrl = await uploadToStorage(`${metaMediaId}.${ext}`, buffer, mimeType); }
  catch (err) { console.error('whatsapp outbound media re-host failed:', err.message); }

  const waMessageId = sendJson?.messages?.[0]?.id || null;
  const sentAt = new Date().toISOString();
  const inserted = await sb('POST', '/rest/v1/whatsapp_messages', {
    conversation_id: conversationId,
    wa_message_id: waMessageId,
    direction: 'outbound',
    message_type: waType,
    body: caption ? String(caption) : null,
    media_id: metaMediaId,
    media_url: mediaUrl,
    status: 'sent',
    sent_at: sentAt
  }, { Prefer: 'return=representation' });
  await sb('PATCH', `/rest/v1/whatsapp_conversations?id=eq.${conversationId}`, {
    last_message_at: sentAt,
    last_message_preview: caption ? String(caption).slice(0, 200) : `[${waType}]`
  });
  return inserted?.[0];
}

// A multipart/form-data POST is always a media/voice-note send — distinct
// from the JSON actions below. Fields: conversationId, file, caption
// (optional; WhatsApp's audio type doesn't support one, silently ignored).
async function handleSendMedia(req, res) {
  await requireAdmin(req);
  const form = req.body; // FormData, parsed by worker/index.js's MULTIPART_ROUTES branch
  const conversationId = form.get('conversationId');
  const file = form.get('file');
  const caption = form.get('caption');
  if (!conversationId) return res.status(400).json({ error: 'conversationId required' });
  if (!file || typeof file === 'string') return res.status(400).json({ error: 'file required' });

  const buffer = Buffer.from(await file.arrayBuffer());
  const message = await sendMediaMessage({
    conversationId, buffer, mimeType: file.type || 'application/octet-stream', filename: file.name, caption
  });
  return res.status(200).json({ ok: true, message });
}

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
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      return await handleSendMedia(req, res);
    }

    await requireAdmin(req);
    const { action, conversationId, body, limit, mediaUrl, quickReply } = req.body || {};

    if (action === 'list-conversations') {
      const rows = await sb('GET', `/rest/v1/whatsapp_conversations?select=*&order=last_message_at.desc.nullslast&limit=${Number(limit) || 200}`);
      return res.status(200).json({ conversations: rows || [] });
    }

    // Quick-reply templates are global, not tied to any one conversation —
    // handled before the conversationId requirement below.
    if (action === 'list-quick-replies') {
      const rows = await sb('GET', '/rest/v1/whatsapp_quick_replies?select=*&order=shortcut.asc');
      return res.status(200).json({ quickReplies: rows || [] });
    }

    if (action === 'save-quick-reply') {
      const shortcut = String(quickReply?.shortcut || '').trim().toLowerCase();
      const message = String(quickReply?.message || '').trim();
      const qrMediaUrl = quickReply?.mediaUrl ? String(quickReply.mediaUrl).trim() : null;
      if (!shortcut) return res.status(400).json({ error: 'Shortcut required' });
      if (!message) return res.status(400).json({ error: 'Message required' });
      const row = { shortcut, message, media_url: qrMediaUrl, updated_at: new Date().toISOString() };
      const saved = quickReply?.id
        ? await sb('PATCH', `/rest/v1/whatsapp_quick_replies?id=eq.${encodeURIComponent(quickReply.id)}`, row, { Prefer: 'return=representation' })
        : await sb('POST', '/rest/v1/whatsapp_quick_replies', row, { Prefer: 'return=representation' });
      return res.status(200).json({ ok: true, quickReply: saved?.[0] });
    }

    if (action === 'delete-quick-reply') {
      if (!quickReply?.id) return res.status(400).json({ error: 'quickReply.id required' });
      await sb('DELETE', `/rest/v1/whatsapp_quick_replies?id=eq.${encodeURIComponent(quickReply.id)}`);
      return res.status(200).json({ ok: true });
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

    // A quick-reply template with its own media_url: fetched server-side
    // and sent through the same path as a manual attach.
    if (action === 'send-quick-reply-media') {
      const url = String(mediaUrl || '').trim();
      if (!url) return res.status(400).json({ error: 'mediaUrl required' });
      const fileRes = await fetch(url);
      if (!fileRes.ok) throw bad(502, "Could not fetch the template's attachment.");
      const buffer = Buffer.from(await fileRes.arrayBuffer());
      const mimeType = fileRes.headers.get('content-type') || 'application/octet-stream';
      const filename = new URL(url).pathname.split('/').pop() || 'attachment';
      const message = await sendMediaMessage({ conversationId, buffer, mimeType, filename, caption: body });
      return res.status(200).json({ ok: true, message });
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: err.status ? err.message : 'Server error' });
  }
};
