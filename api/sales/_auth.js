// Verifies the caller is an ACTIVE sales user.
// Returns { userId, email, name } on success; throws with .status on failure.
// Mirrors api/admin/_auth.js — sales users are Supabase Auth users whose id has
// a row in sales_users (which only the service role can read).

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function sb(method, path, body, token, extraHeaders) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: 'Bearer ' + (token || SERVICE_KEY),
      'Content-Type': 'application/json',
      ...(extraHeaders || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

// expose=true: the message is written for the user and safe to show as-is.
function authError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }

async function requireSales(req) {
  if (!SERVICE_KEY) { const e = new Error('Server not configured (SUPABASE_SERVICE_ROLE_KEY missing)'); e.status = 500; throw e; }
  const auth = req.headers['authorization'] || req.headers['Authorization'] || '';
  const m = /^Bearer (.+)$/i.exec(auth);
  if (!m) throw authError(401, 'Please sign in.');

  // Ask Supabase Auth who this token belongs to.
  let user;
  try { user = await sb('GET', '/auth/v1/user', null, m[1]); }
  catch (err) { throw authError(401, 'Your session has expired. Please sign in again.'); }
  if (!user || !user.id) throw authError(401, 'Your session has expired. Please sign in again.');

  const rows = await sb('GET', `/rest/v1/sales_users?id=eq.${encodeURIComponent(user.id)}&select=id,name,email,is_active`);
  if (!rows || !rows.length) throw authError(403, 'This account is not a sales account.');
  if (!rows[0].is_active) throw authError(403, 'This sales account has been deactivated. Please contact the office.');
  return { userId: user.id, email: user.email, name: rows[0].name };
}

module.exports = { requireSales, sb, SUPABASE_URL, SERVICE_KEY };
