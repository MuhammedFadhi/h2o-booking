// /api/admin/crm-chat — server-side proxy to the external CRM's chat API
// (WhatsApp and, assumed to follow the same URL shape, Instagram), so the
// CRM's bearer token never reaches the browser.
// Actions: get-messages | send-message | set-ai-paused | send-template-media
//          | get-templates (the only action that doesn't need a leadId —
//          reply templates are global, not per-conversation)
// A multipart/form-data POST (not JSON) is handled as a media upload
// instead — see handleSendMedia().
// Auth: caller must present a Bearer token whose email is in admin_emails
// (same as every other /api/admin/* route — see ./_auth).
//
// The browser only ever sends us a leadId, never a raw conversation id —
// we look the right conversation id up ourselves from OUR OWN leads table,
// and resolve which channel's API path to call from WHICH id column is
// populated (not from the lead's free-text `source`, which is looser).
// That's a deliberate narrowing: it means an admin session can only ever
// reach a conversation that's actually attached to one of our leads, not
// any arbitrary conversation id on the CRM's side.
//
// NOTE: the Instagram path (/api/v1/instagram/conversations/{id}/messages)
// is an assumption mirroring the documented WhatsApp one
// (/api/v1/whatsapp/conversations/{id}/messages) — unconfirmed with
// whoever maintains crm.a3sixty.com. If it 404s, that's why.
const { requireAdmin, SUPABASE_URL, SERVICE_KEY } = require('./_auth');

const CRM_BASE_URL = process.env.CRM_API_BASE_URL || 'https://crm.a3sixty.com';
const CRM_API_TOKEN = process.env.CRM_API_TOKEN || '';

// channel name here doubles as the CRM's URL path segment
// (/api/v1/{channel}/conversations/...).
const CONVERSATION_COLUMN_BY_CHANNEL = {
  whatsapp: 'whatsapp_conversation_id',
  instagram: 'instagram_conversation_id'
};

async function sbService(method, path) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' }
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

async function conversationForLead(leadId) {
  const rows = await sbService('GET', `/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}&select=whatsapp_conversation_id,instagram_conversation_id`);
  const lead = rows?.[0];
  for (const [channel, column] of Object.entries(CONVERSATION_COLUMN_BY_CHANNEL)) {
    if (lead?.[column]) return { channel, convoId: lead[column] };
  }
  const e = new Error('This lead has no linked chat conversation.');
  e.status = 404;
  throw e;
}

async function crmFetch(path, options) {
  const r = await fetch(CRM_BASE_URL + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${CRM_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options?.headers || {})
    }
  });
  const txt = await r.text();
  let json;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
  if (!r.ok) {
    const e = new Error((json && json.message) || txt || r.statusText);
    e.status = r.status;
    throw e;
  }
  return json;
}

// Media upload: deliberately NOT using crmFetch — a multipart body must not
// get a manually-set Content-Type, or the request loses its boundary and
// the CRM can't parse the form fields. Letting fetch derive it from the
// FormData body is the only correct way to send this.
async function crmFetchMultipart(path, formData) {
  const r = await fetch(CRM_BASE_URL + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${CRM_API_TOKEN}` },
    body: formData
  });
  const txt = await r.text();
  let json;
  try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
  if (!r.ok) {
    const e = new Error((json && json.message) || txt || r.statusText);
    e.status = r.status;
    throw e;
  }
  return json;
}

// A multipart/form-data POST is always a media upload — distinct from the
// JSON actions below, since FormData can't carry an `action` field the way
// the other actions expect. Fields: leadId, file, caption (optional).
async function handleSendMedia(req, res) {
  await requireAdmin(req);
  const form = req.body; // FormData, parsed by worker/index.js's MULTIPART_ROUTES branch
  const leadId = form.get('leadId');
  const file = form.get('file');
  const caption = form.get('caption');
  if (!leadId) return res.status(400).json({ error: 'leadId required' });
  if (!file || typeof file === 'string') return res.status(400).json({ error: 'file required' });

  const { channel, convoId } = await conversationForLead(leadId);
  const outForm = new FormData();
  outForm.append('file', file, file.name);
  if (caption) outForm.append('caption', String(caption));

  const result = await crmFetchMultipart(`/api/v1/${channel}/conversations/${encodeURIComponent(convoId)}/media`, outForm);
  return res.status(200).json(result);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!CRM_API_TOKEN) return res.status(500).json({ error: 'Server not configured (CRM_API_TOKEN missing)' });

  try {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      return await handleSendMedia(req, res);
    }

    await requireAdmin(req);
    const { action, leadId, body, aiPaused, mediaUrl } = req.body || {};

    // Reply templates are the CRM's own global list, not tied to any one
    // lead/conversation — handled before the leadId requirement below.
    if (action === 'get-templates') {
      const result = await crmFetch('/api/v1/reply-templates', { method: 'GET' });
      return res.status(200).json(result);
    }

    if (!leadId) return res.status(400).json({ error: 'leadId required' });

    const { channel, convoId } = await conversationForLead(leadId);
    const conversationPath = `/api/v1/${channel}/conversations/${encodeURIComponent(convoId)}`;

    if (action === 'get-messages') {
      const result = await crmFetch(`${conversationPath}/messages`, { method: 'GET' });
      return res.status(200).json(result);
    }

    if (action === 'send-message') {
      const text = String(body || '').trim();
      if (!text) return res.status(400).json({ error: 'Message body required' });
      const result = await crmFetch(`${conversationPath}/messages`, { method: 'POST', body: JSON.stringify({ body: text }) });
      return res.status(200).json(result);
    }

    if (action === 'set-ai-paused') {
      const result = await crmFetch(conversationPath, { method: 'PATCH', body: JSON.stringify({ ai_paused: !!aiPaused }) });
      return res.status(200).json(result);
    }

    // A reply template with its own media_url: fetched server-side and
    // re-uploaded as the actual file, since the CRM's media endpoint only
    // documented accepting a multipart file, not a remote URL to repost.
    if (action === 'send-template-media') {
      const url = String(mediaUrl || '').trim();
      if (!url) return res.status(400).json({ error: 'mediaUrl required' });
      const fileRes = await fetch(url);
      if (!fileRes.ok) { const e = new Error("Could not fetch the template's attachment."); e.status = 502; throw e; }
      const fileBlob = await fileRes.blob();
      const filename = new URL(url).pathname.split('/').pop() || 'attachment';
      const outForm = new FormData();
      outForm.append('file', fileBlob, filename);
      if (body) outForm.append('caption', String(body));
      const result = await crmFetchMultipart(`${conversationPath}/media`, outForm);
      return res.status(200).json(result);
    }

    return res.status(400).json({ error: `Unknown action "${action}"` });
  } catch (err) {
    const status = err.status && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: err.status ? err.message : 'Server error' });
  }
};
