// Netlify function mirror of api/send-sms.js
const https = require('https');
const RELAY_HOST = '206.189.42.165', RELAY_PORT = 443, RELAY_PATH = '/', RELAY_TIMEOUT_MS = 30_000;
const CLIENT_SECRET_KEY = 'sada-h2o-relay-2026-secure';
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PHONE_RE = /^9665\d{8}$/;
const IP_LIMIT = 8, IP_WINDOW_MS = 60_000, WINDOW_MS = 15*60*1000, FREE_SENDS = 3, MIN_GAP_MS = 2*60*1000;
const ipHits = new Map();

async function sb(method, path, body) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY env missing');
  const r = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json', Prefer: 'return=representation' },
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
    await sb('POST', '/sms_throttle', { phone, send_count: 1, last_send_at: new Date(now).toISOString(), window_start: new Date(now).toISOString() });
    return { allowed: true };
  }
  const row = rows[0]; const lastMs = new Date(row.last_send_at).getTime();
  if (now - lastMs > WINDOW_MS) {
    await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, { send_count: 1, last_send_at: new Date(now).toISOString(), window_start: new Date(now).toISOString() });
    return { allowed: true };
  }
  if (row.send_count < FREE_SENDS) {
    await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, { send_count: row.send_count + 1, last_send_at: new Date(now).toISOString() });
    return { allowed: true };
  }
  if (now - lastMs < MIN_GAP_MS) return { allowed: false, retryIn: Math.ceil((MIN_GAP_MS - (now - lastMs)) / 1000) };
  await sb('PATCH', `/sms_throttle?phone=eq.${encodeURIComponent(phone)}`, { send_count: row.send_count + 1, last_send_at: new Date(now).toISOString() });
  return { allowed: true };
}
function forwardToDroplet(to, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ to, body });
    const req = https.request({ hostname: RELAY_HOST, port: RELAY_PORT, path: RELAY_PATH, method: 'POST', rejectUnauthorized: false, timeout: RELAY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (r) => {
      let data = ''; r.on('data', c => (data += c));
      r.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('Relay timeout')); });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Secret-Key'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  const h = event.headers || {};
  if ((h['x-secret-key'] || h['X-Secret-Key']) !== CLIENT_SECRET_KEY)
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: 'Unauthorized' }) };

  const ip = (h['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter(t => now - t < IP_WINDOW_MS);
  if (hits.length >= IP_LIMIT) return { statusCode: 429, headers: cors, body: JSON.stringify({ error: 'Too many requests.' }) };
  hits.push(now); ipHits.set(ip, hits);

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch {}
  const { to, body: msg } = body;
  if (!to || !msg) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing to or body' }) };
  const phone = String(to).replace(/[^\d]/g, '');
  if (!PHONE_RE.test(phone)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid phone' }) };
  if (msg.length > 480) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Body too long' }) };

  try {
    const t = await checkPhoneThrottle(phone);
    if (!t.allowed) return { statusCode: 429, headers: cors, body: JSON.stringify({ error: `Please wait ${t.retryIn}s before requesting another SMS.` }) };
  } catch (e) { console.error('throttle:', e.message); }

  try {
    const result = await forwardToDroplet(phone, msg);
    return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
