// /api/admin/slots — bulk create/remove availability slots (constraint-agnostic)
const { requireAdmin } = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { admin } = await requireAdmin(req);
    const { from, to, hours } = req.body || {};
    if (!from || !to || !Array.isArray(hours) || !hours.length)
      return res.status(400).json({ error: 'from/to/hours required' });

    const dates = [];
    const dFrom = new Date(from), dTo = new Date(to);
    for (let d = new Date(dFrom); d <= dTo; d.setDate(d.getDate() + 1)) {
      dates.push(new Date(d).toISOString().split('T')[0]);
    }

    if (req.method === 'POST') {
      const { data: existing, error: e1 } = await admin.from('availability_slots')
        .select('id, slot_date, slot_hour')
        .in('slot_date', dates).in('slot_hour', hours);
      if (e1) throw e1;
      const existingKeys = new Set((existing || []).map(s => `${s.slot_date}|${s.slot_hour}`));
      const toInsert = [];
      for (const d of dates) for (const h of hours) {
        if (!existingKeys.has(`${d}|${h}`)) toInsert.push({ slot_date: d, slot_hour: h, is_available: true });
      }
      if (toInsert.length) {
        const { error } = await admin.from('availability_slots').insert(toInsert);
        if (error) throw error;
      }
      if (existing && existing.length) {
        const { error } = await admin.from('availability_slots')
          .update({ is_available: true })
          .in('slot_date', dates).in('slot_hour', hours);
        if (error) throw error;
      }
      return res.status(201).json({ inserted: toInsert.length, updated: (existing || []).length });
    }

    if (req.method === 'DELETE') {
      const { error } = await admin.from('availability_slots')
        .delete().in('slot_date', dates).in('slot_hour', hours).eq('is_booked', false);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
};
