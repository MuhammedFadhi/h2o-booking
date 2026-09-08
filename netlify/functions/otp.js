// Netlify mirror of /api/otp
const crypto = require('crypto');
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RELAY_HOST = '206.189.42.165';
const RELAY_PATH = '/send';
const OTP_TTL_MS = 2 * 60 * 1000;
const MAX_ATTEMPTS = 4;
const SIGNING_SECRET = process.env.CUSTOMER_TOKEN_SECRET || 'change-me-in-env';

const hashCode = (p, c) => crypto.createHash('sha256').update(p + '|' + c).digest('hex');
const isSaudi = (p) => /^9665\d{8}$/.test(String(p));
const formatSaudi = (p) => {
  let s = String(p || '').replace(/\D/g, '');
  if (s.startsWith('00966')) s = s.slice(2);
  else if (s.startsWith('0')) s = '966' + s.slice(1);
  else if (!s.startsWith('966')) s = '966' + s;
  return s;
};
function issueToken(phone, ttlSec = 60 * 60 * 24 * 7) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = Buffer.from(JSON.stringify({ phone, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', SIGNING_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
async function sendSms(to, body) {
  const data = JSON.stringify({ to, body });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: RELAY_HOST, port: 443, path: RELAY_PATH, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      rejectUnauthorized: false
    }, (resp) => {
      let chunks = '';
      resp.on('data', c => chunks += c);
      resp.on('end', () => (resp.statusCode || 502) >= 400 ? reject(new Error(chunks)) : resolve(chunks));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const sendBucket = new Map();
function tooManySends(ip) {
  const now = Date.now();
  const e = sendBucket.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60_000; }
  e.n++; sendBucket.set(ip, e);
  return e.n > 5;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };
  const admin = createClient(SUPABASE_URL, SRK, { auth: { persistSession: false } });
  const ip = (event.headers['x-forwarded-for'] || event.headers['client-ip'] || '').split(',')[0].trim() || 'unknown';
  let body; try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Bad JSON' }) }; }
  const { action, phone: rawPhone, code } = body;
  const phone = formatSaudi(rawPhone);
  if (!isSaudi(phone)) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid Saudi mobile' }) };

  try {
    if (action === 'send') {
      if (tooManySends(ip)) return { statusCode: 429, headers: cors, body: JSON.stringify({ error: 'Too many attempts, wait a minute' }) };
      const codeGen = String(Math.floor(100000 + Math.random() * 900000));
      const hash = hashCode(phone, codeGen);
      const expires = new Date(Date.now() + OTP_TTL_MS).toISOString();
      await admin.from('customer_otps').upsert({ phone, code_hash: hash, expires_at: expires, attempts: 0, created_at: new Date().toISOString() });
      await sendSms(phone, `SA'DA H2O: Your login code is ${codeGen}. Expires in 2 minutes.`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }
    if (action === 'verify') {
      if (!code || !/^\d{6}$/.test(String(code))) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Code must be 6 digits' }) };
      const { data: rec } = await admin.from('customer_otps').select('*').eq('phone', phone).maybeSingle();
      if (!rec) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'No code issued — send again' }) };
      if (new Date(rec.expires_at) < new Date()) {
        await admin.from('customer_otps').delete().eq('phone', phone);
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Code expired — send again' }) };
      }
      if (rec.attempts >= MAX_ATTEMPTS) {
        await admin.from('customer_otps').delete().eq('phone', phone);
        return { statusCode: 429, headers: cors, body: JSON.stringify({ error: 'Too many attempts — send again' }) };
      }
      if (hashCode(phone, String(code)) !== rec.code_hash) {
        await admin.from('customer_otps').update({ attempts: rec.attempts + 1 }).eq('phone', phone);
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Wrong code' }) };
      }
      await admin.from('customer_otps').delete().eq('phone', phone);
      const { data: existing } = await admin.from('customers').select('*').eq('phone', phone).maybeSingle();
      let customer;
      if (existing) customer = existing;
      else {
        const { data: created, error } = await admin.from('customers').insert({ phone, name: '', updated_at: new Date().toISOString() }).select('*').single();
        if (error) throw error;
        customer = created;
      }
      const token = issueToken(phone);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ token, customer }) };
    }
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
