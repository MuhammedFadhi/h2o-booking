// GET /api/public/bookings — read-only, API-key gated (see ./_auth).
// Query params: limit, offset, status, booking_type, phone, from, to (slot_date range).
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
    const { status, booking_type, phone, from, to } = req.query;

    let q = db.from('bookings').select('*', { count: 'exact' })
      .order('slot_date', { ascending: false }).order('slot_hour', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) q = q.eq('status', status);
    if (booking_type) q = q.eq('booking_type', booking_type);
    if (phone) q = q.eq('customer_phone', phone);
    if (from) q = q.gte('slot_date', from);
    if (to) q = q.lte('slot_date', to);

    const { data, error, count } = await q;
    if (error) throw error;
    return res.status(200).json({ data, limit, offset, count });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
