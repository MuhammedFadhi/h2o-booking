// Netlify mirror of api/admin/user-ops
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ykgtrloptgazeqjgxney.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function requireAdmin(headers) {
  const auth = headers.authorization || headers.Authorization || '';
  const m = /^Bearer (.+)$/i.exec(auth);
  if (!m) { const e = new Error('Missing Bearer token'); e.status = 401; throw e; }
  const token = m[1];
  const ur = await fetch(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + token } });
  if (!ur.ok) { const e = new Error('Invalid session'); e.status = 401; throw e; }
  const user = await ur.json();
  if (!user.email) { const e = new Error('No email'); e.status = 401; throw e; }
  const arr = await fetch(SUPABASE_URL + `/rest/v1/admin_emails?email=eq.${encodeURIComponent(user.email)}&select=email`, {
    headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY }
  });
  const rows = await arr.json();
  if (!rows?.length) { const e = new Error('Not an admin'); e.status = 403; throw e; }
  return user;
}

async function svc(method, path, body) {
  const r = await fetch(SUPABASE_URL + path, {
    method, headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const t = await r.text();
  if (!r.ok) { const e = new Error(t); e.status = r.status; throw e; }
  return t ? JSON.parse(t) : null;
}

// GoTrue's admin API has no exact "get user by email" endpoint — ?email= is
// ignored, so we page through /admin/users and match client-side.
async function findAuthUserByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const result = await svc('GET', `/auth/v1/admin/users?page=${page}&per_page=200`);
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
  const rows = await svc('GET', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}&select=user_id`);
  let userId = rows?.[0]?.user_id;
  if (!userId) {
    const user = await findAuthUserByEmail(email);
    if (!user) { const e = new Error('No login found for this email.'); e.status = 404; throw e; }
    userId = user.id;
    await svc('PATCH', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`, { user_id: userId });
  }
  await svc('PUT', `/auth/v1/admin/users/${userId}`, { password });
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const caller = await requireAdmin(event.headers || {});
    const body = JSON.parse(event.body || '{}');
    const { action, email, password, userId, name, phone } = body;
    if (action === 'create-installer') {
      if (!email || !password || !name) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email, password, name required' }) };
      const authUser = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      const rows = await svc('POST', '/rest/v1/installers', { id: authUser.id, name, email, phone: phone || null });
      return { statusCode: 201, headers: cors, body: JSON.stringify({ id: authUser.id, installer: rows }) };
    }
    if (action === 'delete-installer') {
      if (!userId) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'userId required' }) };
      await svc('DELETE', `/auth/v1/admin/users/${userId}`);
      await svc('DELETE', `/rest/v1/installers?id=eq.${userId}`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }
    if (action === 'reset-installer-password') {
      if (!userId || !password) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'userId and password required' }) };
      await svc('PUT', `/auth/v1/admin/users/${userId}`, { password });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }
    if (action === 'create-admin') {
      if (!email || !password) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email and password required' }) };
      const authUser = await svc('POST', '/auth/v1/admin/users', { email, password, email_confirm: true });
      await svc('POST', '/rest/v1/admin_emails', { email, name: name || null, user_id: authUser.id });
      return { statusCode: 201, headers: cors, body: JSON.stringify({ id: authUser.id, email }) };
    }
    if (action === 'grant-admin') {
      if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email required' }) };
      const user = await findAuthUserByEmail(email);
      if (!user) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No existing login found for that email. Set a password to create one.' }) };
      await svc('POST', '/rest/v1/admin_emails', { email, name: name || null, user_id: user.id });
      return { statusCode: 201, headers: cors, body: JSON.stringify({ email }) };
    }
    if (action === 'edit-admin') {
      if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email required' }) };
      await svc('PATCH', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`, { name: name || null });
      if (password) await resetAdminPassword(email, password);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }
    if (action === 'list-admins') {
      const rows = await svc('GET', '/rest/v1/admin_emails?select=email,name,created_at&order=created_at.asc');
      return { statusCode: 200, headers: cors, body: JSON.stringify({ admins: rows }) };
    }
    if (action === 'delete-admin') {
      if (!email) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'email required' }) };
      if (email.toLowerCase() === (caller.email || '').toLowerCase()) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'You cannot remove your own admin access.' }) };
      }
      await svc('DELETE', `/rest/v1/admin_emails?email=eq.${encodeURIComponent(email)}`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: e.status || 500, headers: cors, body: JSON.stringify({ error: e.message || 'Server error' }) };
  }
};
