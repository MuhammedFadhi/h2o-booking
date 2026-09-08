// /api/admin/installers — list / create / update / delete + password reset
const { requireAdmin } = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { admin } = await requireAdmin(req);

    if (req.method === 'GET') {
      const { data, error } = await admin.from('installers').select('*').order('name');
      if (error) throw error;
      return res.status(200).json({ installers: data });
    }

    if (req.method === 'POST') {
      const { email, password, name, phone } = req.body || {};
      if (!email || !password || !name) return res.status(400).json({ error: 'name/email/password required' });
      const { data: user, error: e1 } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (e1) throw e1;
      const { error: e2 } = await admin.from('installers').insert({ id: user.user.id, name, email, phone: phone || null, is_active: true });
      if (e2) throw e2;
      return res.status(201).json({ id: user.user.id });
    }

    const id = req.query.id || (req.body && req.body.id);
    if (!id) return res.status(400).json({ error: 'id required' });

    if (req.method === 'PATCH') {
      const { password, ...rest } = req.body;
      if (password) {
        const { error } = await admin.auth.admin.updateUserById(id, { password });
        if (error) throw error;
      }
      if (Object.keys(rest).length) {
        delete rest.id;
        const { error } = await admin.from('installers').update(rest).eq('id', id);
        if (error) throw error;
      }
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      await admin.from('bookings').update({ installer_id: null }).eq('installer_id', id);
      await admin.auth.admin.deleteUser(id).catch(() => {});
      const { error } = await admin.from('installers').delete().eq('id', id);
      if (error) throw error;
      return res.status(204).end();
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
