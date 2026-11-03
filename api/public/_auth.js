// Shared auth for the read-only public API (/api/public/*). Unlike the admin
// API (Supabase Auth session) or the sales API (its own session), this is a
// single pre-shared secret an external app sends in the X-API-Key header —
// checked against PUBLIC_API_KEYS (comma-separated, so keys can be issued or
// revoked per partner without redeploying code).
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

function requireApiKey(req) {
  if (!SUPABASE_URL) { const e = new Error('Server not configured (SUPABASE_URL missing)'); e.status = 500; throw e; }
  if (!SERVICE_KEY) { const e = new Error('Server not configured (SUPABASE_SERVICE_ROLE_KEY missing)'); e.status = 500; throw e; }
  const configured = (process.env.PUBLIC_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  if (!configured.length) { const e = new Error('Public API not configured (PUBLIC_API_KEYS missing)'); e.status = 500; throw e; }

  const key = req.headers['x-api-key'] || '';
  if (!key || !configured.includes(key)) { const e = new Error('Invalid or missing API key'); e.status = 401; throw e; }

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  return { db };
}

// ?limit=&offset=, capped so one call can't pull an entire table.
function pagination(req, { defaultLimit = 50, maxLimit = 200 } = {}) {
  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = defaultLimit;
  limit = Math.min(limit, maxLimit);

  let offset = parseInt(req.query.offset, 10);
  if (!Number.isFinite(offset) || offset < 0) offset = 0;

  return { limit, offset };
}

module.exports = { requireApiKey, pagination };
