// SA'DA H2O — external CRM inbound webhook
// ============================================================================
// The CRM POSTs here whenever it creates a lead or a message. Body shape:
//   { event: 'lead.created'|'message.created', table, timestamp, data }
//
// Auth: optional HMAC-SHA256 signature, same pattern as GitHub/Stripe —
//   X-Webhook-Signature: hex( HMAC-SHA256(rawBody, CRM_WEBHOOK_SECRET) )
// Verification only runs once CRM_WEBHOOK_SECRET is set in this Worker's
// env; until then the endpoint accepts unsigned requests so it can be wired
// up before a shared secret exists on both sides.
//
// Uses the service-role REST client directly (duplicated from
// api/sales/_auth.js's `sb` on purpose — see auth-sms-hook.js for why
// webhook handlers in this project don't share modules with the rest of
// the app: editing a shared module to fit a new webhook risks the working
// paths that already depend on it).
// ============================================================================

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const WEBHOOK_SECRET = process.env.CRM_WEBHOOK_SECRET || '';

// Raw-body routes (see worker/index.js) hand us the exact bytes as a string.
module.exports.config = { api: { bodyParser: false } };

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
  const expected = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  const expBuf = Buffer.from(expected, 'utf8');
  const gotBuf = Buffer.from(String(header).trim(), 'utf8');
  return expBuf.length === gotBuf.length && crypto.timingSafeEqual(expBuf, gotBuf);
}

// Unlike api/sales/ops.js's normalizePhone (Saudi-only, since the sales
// portal only ever deals with Saudi customers), a lead synced from the CRM
// can come from a WhatsApp/Instagram contact in any country — so this
// accepts any plausible E.164 number, keeping the same Saudi-specific
// shortcuts (bare 05.../5......... /00966.../966...) as convenience cases
// rather than the only accepted format.
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s()-]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  else if (p.startsWith('966')) p = '+' + p;
  else if (p.startsWith('05')) p = '+966' + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = '+966' + p;
  else if (!p.startsWith('+')) p = '+' + p;
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
}

const CHANNEL_BY_TABLE = {
  whatsapp_messages: 'whatsapp',
  instagram_dm_messages: 'instagram',
  messenger_messages: 'messenger'
};

async function handleLeadCreated(data) {
  const name = String(data.client_name || '').trim().slice(0, 80);
  const phone = normalizePhone(data.client_phone);
  if (!name) {
    const e = new Error('lead.created payload missing client_name');
    e.status = 400;
    throw e;
  }
  if (!phone) {
    const e = new Error(`lead.created payload has an invalid client_phone: "${data.client_phone}"`);
    e.status = 400;
    throw e;
  }

  const noteParts = [];
  if (data.remarks) noteParts.push(String(data.remarks).trim());
  if (data.status) noteParts.push(`CRM status: ${data.status}`);
  if (data.call_status) noteParts.push(`Call status: ${data.call_status}`);

  const row = {
    name,
    phone,
    email: data.client_email ? String(data.client_email).trim().slice(0, 120) : null,
    city_name: data.city ? String(data.city).trim().slice(0, 80) : null,
    source: data.source ? String(data.source).trim().slice(0, 40) : 'CRM',
    notes: noteParts.join(' | ').slice(0, 500) || null,
    status: 'open',
    created_by_name: 'CRM Sync',
    external_system: 'crm',
    external_id: data.id != null ? String(data.id) : null,
    whatsapp_conversation_id: data.whatsapp_conversation_id != null ? String(data.whatsapp_conversation_id) : null
  };

  // Upsert on (external_system, external_id) so a retried/duplicate delivery
  // updates the same lead instead of creating a second one. Rows without an
  // external id (the CRM sent no `data.id`) just insert plainly each time —
  // there's nothing to de-duplicate against.
  const path = row.external_id
    ? '/rest/v1/leads?on_conflict=external_system,external_id'
    : '/rest/v1/leads';
  const prefer = row.external_id
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';

  const rows = await sb('POST', path, row, { Prefer: prefer });
  return rows && rows[0];
}

async function handleMessageCreated(data, table) {
  const channel = CHANNEL_BY_TABLE[table];
  if (!channel) {
    const e = new Error(`message.created with unknown table "${table}"`);
    e.status = 400;
    throw e;
  }
  if (!data.direction || !['inbound', 'outbound'].includes(data.direction)) {
    const e = new Error('message.created payload missing a valid direction');
    e.status = 400;
    throw e;
  }

  const row = {
    channel,
    conversation_id: data.conversation_id != null ? String(data.conversation_id) : null,
    direction: data.direction,
    message_type: data.message_type ? String(data.message_type).slice(0, 40) : null,
    body: data.body != null ? String(data.body).slice(0, 4000) : null,
    media_url: data.media_url ? String(data.media_url).slice(0, 1000) : null,
    sent_at: data.sent_at || null,
    external_id: data.id != null ? String(data.id) : null,
    raw_payload: data
  };

  const path = row.external_id
    ? '/rest/v1/crm_messages?on_conflict=channel,external_id'
    : '/rest/v1/crm_messages';
  const prefer = row.external_id
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';

  const rows = await sb('POST', path, row, { Prefer: prefer });
  return rows && rows[0];
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Webhook-Signature');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SERVICE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const raw = await readRawBody(req);

  if (WEBHOOK_SECRET) {
    const sigHeader = req.headers['x-webhook-signature'];
    if (!verifySignature(raw, sigHeader, WEBHOOK_SECRET)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let payload;
  try { payload = JSON.parse(raw); }
  catch { return res.status(400).json({ error: 'Invalid JSON body' }); }

  const { event, table, data } = payload || {};
  if (!event || !data) return res.status(400).json({ error: 'Missing event or data' });

  try {
    if (event === 'lead.created') {
      const row = await handleLeadCreated(data);
      return res.status(200).json({ ok: true, lead: row });
    }
    if (event === 'message.created') {
      const row = await handleMessageCreated(data, table);
      return res.status(200).json({ ok: true, message: row });
    }
    return res.status(400).json({ error: `Unknown event "${event}"` });
  } catch (err) {
    console.error('crm webhook error:', err);
    const status = err.status && err.status < 500 ? err.status : 500;
    return res.status(status).json({ error: err.status ? err.message : 'Server error' });
  }
};
