// Netlify mirror of /api/notify-report
const https = require('https');
const RELAY_HOST = '206.189.42.165', RELAY_PORT = 443, RELAY_TIMEOUT_MS = 30_000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PORTAL_URL = 'https://sada-water-booking.vercel.app/customer/portal.html';

async function sb(method, path) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY env missing');
  const r = await fetch(SUPABASE_URL + '/rest/v1' + path, { method, headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
}
function relaySend(to, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ to, body });
    const req = https.request({ hostname: RELAY_HOST, port: RELAY_PORT, path: '/', method: 'POST', rejectUnauthorized: false, timeout: RELAY_TIMEOUT_MS, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
    req.on('timeout', () => { req.destroy(); resolve({ status: 504, body: 'timeout' }); });
    req.on('error', (e) => resolve({ status: 500, body: e.message }));
    req.write(payload); req.end();
  });
}
function formatSaudi(phone) {
  const d = String(phone || '').replace(/[^\d]/g, '');
  if (/^9665\d{8}$/.test(d)) return d;
  if (/^05\d{8}$/.test(d))   return '966' + d.slice(1);
  if (/^5\d{8}$/.test(d))    return '966' + d;
  return null;
}
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
  const { reportId } = body;
  if (!reportId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'reportId required' }) };
  try {
    const settings = await sb('GET', `/sms_settings?key=eq.inspection_report&select=enabled`);
    if (!settings?.length || settings[0].enabled !== true) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'setting disabled' }) };
    const rows = await sb('GET', `/inspection_reports?id=eq.${encodeURIComponent(reportId)}&select=id,customer_name,customer_phone,status,submitted_at`);
    if (!rows?.length) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Report not found' }) };
    const r = rows[0];
    if (r.status !== 'submitted') return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'not submitted' }) };
    if (!r.submitted_at) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'no submitted_at' }) };
    if (Date.now() - new Date(r.submitted_at).getTime() > 10 * 60 * 1000) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'too old' }) };
    const phone = formatSaudi(r.customer_phone);
    if (!phone) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'no phone' }) };
    const msg = `SA'DA H2O — Your inspection report is ready.\nView it here: ${PORTAL_URL}\nThank you for choosing SA'DA H2O!`;
    const result = await relaySend(phone, msg);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, sent: result.status < 300 ? 1 : 0, relay: result.status }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
