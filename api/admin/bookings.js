// /api/admin/bookings — list / update / delete bookings
const { requireAdmin } = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { admin } = await requireAdmin(req);

    if (req.method === 'GET') {
      const { data, error } = await admin.from('bookings')
        .select('*').order('slot_date', { ascending: false }).order('slot_hour', { ascending: false });
      if (error) throw error;
      return res.status(200).json({ bookings: data });
    }

    const id = req.query.id || (req.body && req.body.id);
    if (!id) return res.status(400).json({ error: 'id required' });

    if (req.method === 'PATCH') {
      const patch = { ...req.body }; delete patch.id;
      const { data, error } = await admin.from('bookings').update(patch).eq('id', id).select('*').single();
      if (error) throw error;
      return res.status(200).json({ booking: data });
    }

    if (req.method === 'DELETE') {
      const { error } = await admin.from('bookings').delete().eq('id', id);
      if (error) throw error;
      return res.status(204).end();
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
