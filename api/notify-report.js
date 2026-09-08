// /api/notify-report — SMS customer that their inspection report is ready.
// Anti-replay: report must exist, status='submitted', <10 min since submitted_at.
// Skipped if sms_settings.inspection_report is disabled.
const https = require('https');

const RELAY_HOST = '206.189.42.165';
const RELAY_PORT = 443;
const RELAY_TIMEOUT_MS = 30_000;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PORTAL_URL = 'https://sada-water-booking.vercel.app/customer/portal.html';

async function sb(method, path) {
  if (!SERVICE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY env missing');
  const r = await fetch(SUPABASE_URL + '/rest/v1' + path, {
    method, headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`Supabase ${method} ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

function relaySend(to, body) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({ to, body });
    const req = https.request({
      hostname: RELAY_HOST, port: RELAY_PORT, path: '/', method: 'POST',
      rejectUnauthorized: false, timeout: RELAY_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (r) => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => resolve({ status: r.statusCode, body: d }));
    });
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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { reportId } = req.body || {};
  if (!reportId) return res.status(400).json({ error: 'reportId required' });

  try {
    const settings = await sb('GET', `/sms_settings?key=eq.inspection_report&select=enabled`);
    if (!settings?.length || settings[0].enabled !== true) return res.status(200).json({ ok: true, skipped: 'setting disabled' });

    const rows = await sb('GET', `/inspection_reports?id=eq.${encodeURIComponent(reportId)}&select=id,customer_name,customer_phone,status,submitted_at`);
    if (!rows?.length) return res.status(404).json({ error: 'Report not found' });
    const r = rows[0];
    if (r.status !== 'submitted') return res.status(200).json({ ok: true, skipped: 'not submitted' });
    if (!r.submitted_at) return res.status(200).json({ ok: true, skipped: 'no submitted_at' });
    if (Date.now() - new Date(r.submitted_at).getTime() > 10 * 60 * 1000) return res.status(200).json({ ok: true, skipped: 'too old' });

    const phone = formatSaudi(r.customer_phone);
    if (!phone) return res.status(200).json({ ok: true, skipped: 'no phone' });

    const msg = `SA'DA H2O — Your inspection report is ready.\nView it here: ${PORTAL_URL}\nThank you for choosing SA'DA H2O!`;
    const result = await relaySend(phone, msg);
    return res.status(200).json({ ok: true, sent: result.status < 300 ? 1 : 0, relay: result.status });
  } catch (e) {
    console.error('notify-report:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
