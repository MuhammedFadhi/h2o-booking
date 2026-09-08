// Verifies the caller is a Supabase-authenticated user whose email is in admin_emails.
// Returns { userId, email, admin } on success; throws with .status on failure.
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(method, path, body, token) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + (token || SERVICE_KEY),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

async function requireAdmin(req) {
  if (!SERVICE_KEY) { const e = new Error('Server not configured (SUPABASE_SERVICE_ROLE_KEY missing)'); e.status = 500; throw e; }
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer (.+)$/i.exec(auth);
  if (!m) { const e = new Error('Missing Bearer token'); e.status = 401; throw e; }
  const token = m[1];

  // Ask Supabase Auth who this token belongs to.
  const user = await sb('GET', '/auth/v1/user', null, token);
  if (!user || !user.email) { const e = new Error('Invalid session'); e.status = 401; throw e; }

  // Check email against allowlist (service-role query bypasses RLS)
  const rows = await sb('GET', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(user.email)}&select=email`);
  if (!rows || !rows.length) { const e = new Error('Not an admin'); e.status = 403; throw e; }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  return { userId: user.id, email: user.email, token, admin };
}

module.exports = { requireAdmin, SUPABASE_URL, SERVICE_KEY };
