// /api/otp — send + verify customer OTP server-side.
// Uses the SAME send-sms relay (rate-limited on IP for send).
// Never returns the code; stores only bcrypt-style hash.

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

// hash(code + phone) so per-phone hashes differ
function hashCode(phone, code) {
  return crypto.createHash('sha256').update(phone + '|' + code).digest('hex');
}
function isSaudi(p) { return /^9665\d{8}$/.test(String(p)); }
function formatSaudi(p) {
  let s = String(p || '').replace(/\D/g, '');
  if (s.startsWith('00966')) s = s.slice(2);
  else if (s.startsWith('0')) s = '966' + s.slice(1);
  else if (!s.startsWith('966')) s = '966' + s;
  return s;
}

// Simple HMAC-signed session token (no external JWT lib)
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
      resp.on('data', (c) => chunks += c);
      resp.on('end', () => (resp.statusCode || 502) >= 400 ? reject(new Error(chunks)) : resolve(chunks));
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

const sendBucket = new Map(); // simple IP send rate limit
function tooManySends(ip) {
  const now = Date.now();
  const e = sendBucket.get(ip) || { n: 0, reset: now + 60_000 };
  if (now > e.reset) { e.n = 0; e.reset = now + 60_000; }
  e.n++; sendBucket.set(ip, e);
  return e.n > 5;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const admin = createClient(SUPABASE_URL, SRK, { auth: { persistSession: false } });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim() || 'unknown';
  const { action, phone: rawPhone, code } = req.body || {};
  const phone = formatSaudi(rawPhone);
  if (!isSaudi(phone)) return res.status(400).json({ error: 'Invalid Saudi mobile' });

  try {
    if (action === 'send') {
      if (tooManySends(ip)) return res.status(429).json({ error: 'Too many attempts, wait a minute' });
      const codeGen = String(Math.floor(100000 + Math.random() * 900000));
      const hash = hashCode(phone, codeGen);
      const expires = new Date(Date.now() + OTP_TTL_MS).toISOString();
      await admin.from('customer_otps').upsert({ phone, code_hash: hash, expires_at: expires, attempts: 0, created_at: new Date().toISOString() });
      await sendSms(phone, `SA'DA H2O: Your login code is ${codeGen}. Expires in 2 minutes.`);
      return res.status(200).json({ ok: true });
    }

    if (action === 'verify') {
      if (!code || !/^\d{6}$/.test(String(code))) return res.status(400).json({ error: 'Code must be 6 digits' });
      const { data: rec } = await admin.from('customer_otps').select('*').eq('phone', phone).maybeSingle();
      if (!rec) return res.status(400).json({ error: 'No code issued — send again' });
      if (new Date(rec.expires_at) < new Date()) {
        await admin.from('customer_otps').delete().eq('phone', phone);
        return res.status(400).json({ error: 'Code expired — send again' });
      }
      if (rec.attempts >= MAX_ATTEMPTS) {
        await admin.from('customer_otps').delete().eq('phone', phone);
        return res.status(429).json({ error: 'Too many attempts — send again' });
      }
      if (hashCode(phone, String(code)) !== rec.code_hash) {
        await admin.from('customer_otps').update({ attempts: rec.attempts + 1 }).eq('phone', phone);
        return res.status(400).json({ error: 'Wrong code' });
      }
      // Success: consume + upsert customer + issue session token
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
      return res.status(200).json({ token, customer });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
