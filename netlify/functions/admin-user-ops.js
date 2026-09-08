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

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    await requireAdmin(event.headers || {});
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
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    return { statusCode: e.status || 500, headers: cors, body: JSON.stringify({ error: e.message || 'Server error' }) };
  }
};
