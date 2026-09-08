// SA'DA H2O — SMS relay
// Preserves v21 droplet integration exactly (POST https://206.189.42.165:443/ with {to, body}).
// Adds: per-phone throttle (3 free / 15-min window, then 1 send per 2 min).
// Still enforces: shared X-Secret-Key header from client, IP-level flood cap, Saudi phone regex.

const https = require('https');

const RELAY_HOST = '206.189.42.165';
const RELAY_PORT = 443;
const RELAY_PATH = '/';
const RELAY_TIMEOUT_MS = 30_000;
const CLIENT_SECRET_KEY = 'sada-h2o-relay-2026-secure';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PHONE_RE = /^9665\d{8}$/;
const IP_LIMIT = 8;              // per IP per 60s (was 5 in v21; bumped since portal + book both send)
const IP_WINDOW_MS = 60_000;
const WINDOW_MS = 15 * 60 * 1000; // per-phone rolling window
const FREE_SENDS = 3;             // free sends in window
const MIN_GAP_MS = 2 * 60 * 1000; // 2 min gap after burst

const ipHits = new Map();

function ipOf(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

async function sb(method, path, body) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY env missing');
  const r = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + SERVICE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function checkPhoneThrottle(phone) {
  const rows = await sb('GET', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}&select=*`);
  const now = Date.now();
  if (!rows || !rows.length) {
    await sb('POST', '/sms_throttle', {
      phone, send_count: 1,
      last_send_at: new Date(now).toISOString(),
      window_start: new Date(now).toISOString()
    });
    return { allowed: true };
  }
  const row = rows[0];
  const lastMs = new Date(row.last_send_at).getTime();

  if (now - lastMs > WINDOW_MS) {
    await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, {
      send_count: 1,
      last_send_at: new Date(now).toISOString(),
      window_start: new Date(now).toISOString()
    });
    return { allowed: true };
  }

  if (row.send_count < FREE_SENDS) {
    await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, {
      send_count: row.send_count + 1,
      last_send_at: new Date(now).toISOString()
    });
    return { allowed: true };
  }

  if (now - lastMs < MIN_GAP_MS) {
    return { allowed: false, retryIn: Math.ceil((MIN_GAP_MS - (now - lastMs)) / 1000) };
  }
  await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, {
    send_count: row.send_count + 1,
    last_send_at: new Date(now).toISOString()
  });
  return { allowed: true };
}

function forwardToDroplet(to, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ to, body });
    const req = https.request({
      hostname: RELAY_HOST, port: RELAY_PORT, path: RELAY_PATH, method: 'POST',
      rejectUnauthorized: false,
      timeout: RELAY_TIMEOUT_MS,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (r) => {
      let data = '';
      r.on('data', c => (data += c));
      r.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Relay timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Secret-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (req.headers['x-secret-key'] !== CLIENT_SECRET_KEY)
    return res.status(401).json({ error: 'Unauthorized' });

  const ip = ipOf(req);
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  hits.push(now); ipHits.set(ip, hits);

  const { to, body } = req.body || {};
  if (!to || !body) return res.status(400).json({ error: 'Missing to or body' });
  const phone = String(to).replace(/[^\d]/g, '');
  if (!PHONE_RE.test(phone)) return res.status(400).json({ error: 'Invalid phone number (must be 9665XXXXXXXX)' });
  if (body.length > 480) return res.status(400).json({ error: 'Body too long (max 480 chars)' });

  try {
    const t = await checkPhoneThrottle(phone);
    if (!t.allowed) return res.status(429).json({ error: `Please wait ${t.retryIn}s before requesting another SMS.` });
  } catch (e) {
    console.error('throttle check failed (fail-open):', e.message);
  }

  try {
    const result = await forwardToDroplet(phone, body);
    return res.status(200).json(result);
  } catch (err) {
    console.error('SMS relay error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
