// /api/sales/ops — the ONLY way a sales user reads or writes data.
// Actions: me | my-bookings | create-booking
// Auth: caller must present a Bearer token for an ACTIVE row in sales_users.
//
// All database access here uses the service key but is scoped to the caller:
//   - my-bookings only returns rows where bookings.created_by_user = caller.
//   - create-booking stamps created_by_user = caller, validates the slot, and
//     re-prices the basket from product_models (the browser's prices are ignored).
// Sales users therefore need no database permissions of their own.

const { requireSales, sb } = require('./_auth');

const ALLOWED_SOURCES = new Set([
  'Phone Call', 'WhatsApp', 'Instagram', 'Snapchat', 'TikTok', 'Google Search',
  'Friend / Family', 'Existing Customer', 'Dammam Showroom', 'Khobar Showroom',
  'Exhibition / Event', 'Flyer / Billboard', 'Other'
]);
const DISPENSER_COLORS = ['Black', 'White'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// expose=true marks a message written for the salesperson (safe to show as-is).
// Anything without it — raw database/upstream errors — is replaced by a generic one.
function bad(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }
const clean = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s()-]/g, '');
  if (p.startsWith('00966')) p = '+' + p.slice(2);
  else if (p.startsWith('966')) p = '+' + p;
  else if (p.startsWith('05')) p = '+966' + p.slice(1);
  else if (/^5\d{8}$/.test(p)) p = '+966' + p;
  return /^\+9665\d{8}$/.test(p) ? p : null;
}

// Slots are Saudi wall-clock times; "already started?" must be judged in Riyadh time.
function slotHasStarted(slotDate, slotHour) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  const today = `${g('year')}-${g('month')}-${g('day')}`;
  const minutes = Number(g('hour')) * 60 + Number(g('minute'));
  if (slotDate > today) return false;
  if (slotDate < today) return true;
  return Number(slotHour) * 60 <= minutes;
}

// ── my-bookings ────────────────────────────────────────────────────────────
async function myBookings(user) {
  const cols = [
    'id', 'booking_reference', 'status', 'booking_type', 'customer_name', 'customer_phone',
    'city_name', 'location_address', 'floor_no', 'flat_no', 'slot_date', 'slot_hour',
    'product_model', 'product_qty', 'order_total', 'referral_source', 'created_at',
    'installers(name)', 'booking_items(product_model,qty,unit_price)'
  ].join(',');
  const rows = await sb('GET',
    `/rest/v1/bookings?created_by_user=eq.${user.userId}&select=${encodeURIComponent(cols)}` +
    '&order=slot_date.desc,slot_hour.desc&limit=500');
  return { bookings: rows || [] };
}

// ── create-booking ─────────────────────────────────────────────────────────
async function createBooking(user, body) {
  const name = clean(body.name, 80);
  const phone = normalizePhone(body.phone);
  const cityName = clean(body.cityName, 80);
  const address = clean(body.address, 300);
  const floorNo = clean(body.floorNo, 20) || null;
  const flatNo = clean(body.flatNo, 20) || null;
  const source = clean(body.source, 40) || null;
  const regionId = String(body.regionId || '');
  const slotId = String(body.slotId || '');
  const items = Array.isArray(body.items) ? body.items : [];

  if (!name) throw bad(400, 'Enter the customer name.');
  if (!phone) throw bad(400, 'That mobile number doesn\'t look right. Use a 10-digit Saudi mobile, e.g. 0558233001.');
  if (!UUID_RE.test(regionId)) throw bad(400, 'Choose a region.');
  if (!cityName) throw bad(400, 'Choose a city.');
  if (!address) throw bad(400, 'Enter the address the customer gave.');
  if (!UUID_RE.test(slotId)) throw bad(400, 'Pick an available date and time slot.');
  if (source && !ALLOWED_SOURCES.has(source)) throw bad(400, 'Unknown source.');
  if (!items.length || items.length > 12) throw bad(400, 'Add at least one product.');

  // ── price the basket from the catalogue (never trust browser prices) ──
  const catalogue = await sb('GET', '/rest/v1/product_models?select=model_name,price_sar,is_catalogue,is_serialized,in_stock');
  const byName = new Map((catalogue || []).map((p) => [p.model_name, p]));
  const lines = items.map((it) => {
    const p = byName.get(String(it.model || ''));
    if (!p || p.is_catalogue === false) throw bad(400, `Unknown product: ${clean(it.model, 60)}`);
    if (p.in_stock === false) throw bad(400, `${p.model_name} is out of stock.`);
    const qty = Math.floor(Number(it.qty));
    if (!(qty >= 1 && qty <= 20)) throw bad(400, 'Quantity must be between 1 and 20.');
    const isDisp = p.model_name.toLowerCase().includes('dispenser');
    const color = isDisp ? (DISPENSER_COLORS.includes(it.color) ? it.color : 'Black') : null;
    return {
      model: p.model_name, qty, color,
      unit_price: p.price_sar == null ? 0 : Number(p.price_sar),
      is_serialized: p.is_serialized !== false,
      label: color ? `${p.model_name} — ${color}` : p.model_name
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.unit_price * l.qty, 0);
  const primary = lines.slice().sort((a, b) => (b.unit_price * b.qty) - (a.unit_price * a.qty))[0];

  // ── validate the slot before reserving it ──
  const slots = await sb('GET',
    `/rest/v1/availability_slots?id=eq.${slotId}&select=id,slot_date,slot_hour,is_booked,is_available,service_region_id`);
  const slot = slots && slots[0];
  if (!slot || !slot.is_available) throw bad(409, 'That time slot is not available. Please pick another.');
  if (slot.is_booked) throw bad(409, 'That slot was just taken. Please pick another.');
  if (slot.service_region_id !== regionId) throw bad(400, 'That slot doesn\'t belong to the chosen region.');
  if (slotHasStarted(slot.slot_date, slot.slot_hour)) throw bad(409, 'That time has already started. Please pick a later slot.');

  // ── atomic reserve + insert (same RPC the customer and admin flows use) ──
  let created;
  try {
    const rpc = await sb('POST', '/rest/v1/rpc/create_booking', {
      p_slot_id: slotId, p_name: name, p_phone: phone, p_city_name: cityName,
      p_region_id: regionId, p_address: address, p_latitude: null, p_longitude: null
    });
    created = Array.isArray(rpc) ? rpc[0] : rpc;
  } catch (e) {
    const msg = String(e.message || '');
    if (/slot_already_booked|slot_not_available/.test(msg)) throw bad(409, 'That slot was just taken. Please pick another.');
    if (/slot_region_mismatch/.test(msg)) throw bad(400, 'That slot doesn\'t belong to the chosen region.');
    throw e;
  }
  if (!created) throw bad(500, 'Could not create the booking.');
  const bookingId = created.booking_id || created.id;

  // ── stamp ownership + details. If THIS fails, undo the booking so we never
  //    leave an orphan that the salesperson can't see and the slot stays locked. ──
  try {
    await sb('PATCH', `/rest/v1/bookings?id=eq.${bookingId}`, {
      booking_type: 'installation',
      created_by: 'admin',                 // office-created: installer still confirms the GPS pin
      created_by_name: user.name,
      created_by_user: user.userId,
      sales_agent: user.name,
      referral_source: source,
      product_model: primary.label,
      product_qty: primary.qty,
      order_total: subtotal,
      floor_no: floorNo,
      flat_no: flatNo
    });
  } catch (e) {
    await sb('DELETE', `/rest/v1/bookings?id=eq.${bookingId}`).catch(() => {});
    await sb('PATCH', `/rest/v1/availability_slots?id=eq.${slotId}`, { is_booked: false }).catch(() => {});
    throw bad(500, 'Could not save the booking details. Nothing was booked — please try again.');
  }

  // ── best-effort extras: a failure here must not lose the booking ──
  const warnings = [];
  await sb('POST', '/rest/v1/booking_items', lines.map((l) => ({
    booking_id: bookingId, product_model: l.label, qty: l.qty,
    unit_price: l.unit_price, is_serialized: l.is_serialized
  }))).catch((e) => warnings.push('items: ' + e.message));
  await sb('POST', '/rest/v1/customers?on_conflict=phone', {
    phone, name, city: cityName, address, updated_at: new Date().toISOString()
  }, null, { Prefer: 'resolution=merge-duplicates,return=minimal' }).catch((e) => warnings.push('customer: ' + e.message));
  await sb('POST', '/rest/v1/activity_log', {
    actor: user.email, action: 'booking.sales_create',
    summary: `Sales (${user.name}) booked for ${name} (${phone}) — ${lines.length} product line(s), ${lines.reduce((s, l) => s + l.qty, 0)} unit(s)`,
    entity_type: 'booking', entity_id: String(bookingId)
  }).catch((e) => warnings.push('log: ' + e.message));

  return {
    ok: true,
    booking: {
      id: bookingId, reference: created.booking_reference,
      slot_date: created.slot_date, slot_hour: created.slot_hour,
      customer_name: name, customer_phone: phone, city_name: cityName, total: subtotal
    },
    warnings
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const user = await requireSales(req);
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    switch (body.action) {
      case 'me': return res.status(200).json({ name: user.name, email: user.email });
      case 'my-bookings': return res.status(200).json(await myBookings(user));
      case 'create-booking': return res.status(201).json(await createBooking(user, body));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (!e.expose) console.error('sales/ops:', e.message);
    return res.status(code).json({ error: e.expose ? e.message : 'Something went wrong. Please try again.' });
  }
};
