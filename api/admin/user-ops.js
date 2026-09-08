// /api/admin/user-ops — server-side proxy for auth.admin operations
// Actions: create-installer, delete-installer, reset-installer-password
// Auth: caller must present a Bearer token whose email is in admin_emails.
const { requireAdmin, SUPABASE_URL, SERVICE_KEY } = require('./_auth');

async function admin(method, path, body) {
  const r = await fetch(SUPABASE_URL + path, {
    method,
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) { const e = new Error(txt || r.statusText); e.status = r.status; throw e; }
  return txt ? JSON.parse(txt) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    await requireAdmin(req);
    const { action, email, password, userId, name, phone } = req.body || {};

    if (action === 'create-installer') {
      if (!email || !password || !name) return res.status(400).json({ error: 'email, password, name required' });
      // 1) Create auth user
      const authUser = await admin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      if (!authUser?.id) return res.status(500).json({ error: 'Auth user creation failed' });
      // 2) Insert installer row
      const installerRows = await admin('POST', '/rest/v1/installers', { id: authUser.id, name, email, phone: phone || null });
      return res.status(201).json({ id: authUser.id, installer: installerRows });
    }

    if (action === 'delete-installer') {
      if (!userId) return res.status(400).json({ error: 'userId required' });
      // Delete auth user (cascades? no — need to delete row too)
      await admin('DELETE', `/auth/v1/admin/users/${userId}`, null);
      await admin('DELETE', `/rest/v1/installers?id=eq.${userId}`, null);
      return res.status(200).json({ ok: true });
    }

    if (action === 'reset-installer-password') {
      if (!userId || !password) return res.status(400).json({ error: 'userId and password required' });
      await admin('PUT', `/auth/v1/admin/users/${userId}`, { password });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error: e.message || 'Server error' });
  }
};
