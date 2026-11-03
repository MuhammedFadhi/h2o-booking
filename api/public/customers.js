// GET /api/public/customers — read-only, API-key gated (see ./_auth).
// Query params: limit, offset, phone, city.
const { requireApiKey, pagination } = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { db } = requireApiKey(req);
    const { limit, offset } = pagination(req);
    const { phone, city } = req.query;

    let q = db.from('customers').select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (phone) q = q.eq('phone', phone);
    if (city) q = q.eq('city', city);

    const { data, error, count } = await q;
    if (error) throw error;
    return res.status(200).json({ data, limit, offset, count });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
