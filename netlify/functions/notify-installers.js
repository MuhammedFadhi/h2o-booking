// Netlify mirror of api/notify-installers.js
const https = require('https');
const RELAY_HOST = '206.189.42.165', RELAY_PORT = 443, RELAY_PATH = '/', RELAY_TIMEOUT_MS = 30_000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PORTAL_URL = 'https://sada-water-booking.vercel.app/installer/login.html';

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
    const req = https.request({
      hostname: RELAY_HOST, port: RELAY_PORT, path: RELAY_PATH, method: 'POST',
      rejectUnauthorized: false, timeout: RELAY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (r) => { let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, body: d })); });
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
function ddmmyyyy(dateStr) { const d = new Date(dateStr + 'T00:00:00'); return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`; }
function formatHour(h) { const n = h % 12 === 0 ? 12 : h % 12; const p = h >= 12 && h < 24 ? 'PM' : 'AM'; return `${n}:00 ${p}`; }

exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  let body = {}; try { body = JSON.parse(event.body || '{}'); } catch {}
  const { bookingId } = body;
  if (!bookingId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'bookingId required' }) };
  try {
    const settings = await sb('GET', `/sms_settings?key=eq.new_booking_available&select=enabled`);
    if (!settings?.length || settings[0].enabled !== true) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'setting disabled' }) };
    const rows = await sb('GET', `/bookings?id=eq.${encodeURIComponent(bookingId)}&select=id,customer_name,city_name,slot_date,slot_hour,status,created_at`);
    if (!rows?.length) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Booking not found' }) };
    const b = rows[0];
    if (b.status !== 'upcoming') return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'not upcoming' }) };
    if (Date.now() - new Date(b.created_at).getTime() > 5 * 60 * 1000) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, skipped: 'too old' }) };
    const installers = await sb('GET', `/installers?is_active=eq.true&select=name,phone`);
    if (!installers?.length) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, sent: 0 }) };
    const msg = `SA'DA H2O — New job available!\n${b.customer_name} · ${b.city_name}\n${ddmmyyyy(b.slot_date)} at ${formatHour(b.slot_hour)}\nClaim it in the installer portal: ${PORTAL_URL}`;
    let sent = 0;
    for (const inst of installers) {
      const phone = formatSaudi(inst.phone);
      if (!phone) continue;
      const r = await relaySend(phone, msg);
      if (r.status >= 200 && r.status < 300) sent++;
      await new Promise(res => setTimeout(res, 200));
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true, sent, total: installers.length }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
