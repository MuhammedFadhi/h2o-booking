// /api/admin/user-ops — server-side proxy for auth.admin operations
// Actions: create-installer, delete-installer, reset-installer-password,
//          create-admin, grant-admin, edit-admin, list-admins, delete-admin
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

// GoTrue's admin API has no exact "get user by email" endpoint — ?email= is
// ignored, so we page through /admin/users and match client-side.
async function findAuthUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const result = await admin('GET', `/auth/v1/admin/users?page=${page}&per_page=200`, null);
    const users = result?.users || [];
    const match = users.find(u => (u.email || '').toLowerCase() === target);
    if (match) return match;
    if (users.length < 200) break;
  }
  return null;
}

// Resolves an admin's auth user id (using the cached admin_emails.user_id
// when present) and sets their password, backfilling the cache on lookup.
async function resetAdminPassword(email, password) {
  const rows = await admin('GET', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}&select=user_id`, null);
  let userId = rows?.[0]?.user_id;
  if (!userId) {
    const user = await findAuthUserByEmail(email);
    if (!user) { const e = new Error('No login found for this email.'); e.status = 404; throw e; }
    userId = user.id;
    await admin('PATCH', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`, { user_id: userId });
  }
  await admin('PUT', `/auth/v1/admin/users/${userId}`, { password });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email: callerEmail } = await requireAdmin(req);
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

    if (action === 'create-admin') {
      if (!email || !password) return res.status(400).json({ error: 'email and password required' });
      const authUser = await admin('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      if (!authUser?.id) return res.status(500).json({ error: 'Auth user creation failed' });
      await admin('POST', '/rest/v1/admin_emails', { email, name: name || null, user_id: authUser.id });
      return res.status(201).json({ id: authUser.id, email });
    }

    if (action === 'grant-admin') {
      if (!email) return res.status(400).json({ error: 'email required' });
      const user = await findAuthUserByEmail(email);
      if (!user) return res.status(404).json({ error: 'No existing login found for that email. Set a password to create one.' });
      await admin('POST', '/rest/v1/admin_emails', { email, name: name || null, user_id: user.id });
      return res.status(201).json({ email });
    }

    if (action === 'edit-admin') {
      if (!email) return res.status(400).json({ error: 'email required' });
      await admin('PATCH', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`, { name: name || null });
      if (password) await resetAdminPassword(email, password);
      return res.status(200).json({ ok: true });
    }

    if (action === 'list-admins') {
      const rows = await admin('GET', '/rest/v1/admin_emails?select=email,name,created_at&order=created_at.asc', null);
      return res.status(200).json({ admins: rows });
    }

    if (action === 'delete-admin') {
      if (!email) return res.status(400).json({ error: 'email required' });
      if (email.toLowerCase() === (callerEmail || '').toLowerCase()) {
        return res.status(400).json({ error: 'You cannot remove your own admin access.' });
      }
      await admin('DELETE', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`, null);
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    const code = e.status || 500;
    return res.status(code).json({ error: e.message || 'Server error' });
  }
};
