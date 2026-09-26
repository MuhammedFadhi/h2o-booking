// /api/sales/ops — the ONLY way a sales user reads or writes data.
// Actions: me | my-bookings | check-promo | create-booking |
//          my-leads | create-lead | mark-lead-lost
// Auth: caller must present a Bearer token for an ACTIVE row in sales_users.
//
// All database access here uses the service key but is scoped to the caller:
//   - my-bookings/my-leads only return rows where created_by_user = caller.
//   - create-booking stamps created_by_user = caller, validates the slot, and
//     re-prices the basket from product_models (the browser's prices are ignored).
//   - create-lead stamps created_by_user = caller. mark-lead-lost and
//     create-booking's optional leadId conversion both re-check the lead
//     belongs to the caller and is still 'open' before touching it.
// Sales users therefore need no database permissions of their own.

const { requireSales, sb } = require('./_auth');

const ALLOWED_SOURCES = new Set([
  'Phone Call', 'WhatsApp', 'Instagram', 'Snapchat', 'TikTok', 'Google Search',
  'Friend / Family', 'Existing Customer', 'Direct Sales', 'Dammam Showroom', 'Khobar Showroom',
  'Lulu Kiosk', 'Exhibition / Event', 'Flyer / Billboard', 'Other'
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

// Slots and promo validity are Saudi wall-clock concepts, so "now" is Riyadh time.
function riyadhNow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const g = (t) => parts.find((p) => p.type === t).value;
  return { today: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
}

function slotHasStarted(slotDate, slotHour) {
  const { today, minutes } = riyadhNow();
  if (slotDate > today) return false;
  if (slotDate < today) return true;
  return Number(slotHour) * 60 <= minutes;
}

// ── promo codes ────────────────────────────────────────────────────────────
// Same rules as the admin/customer booking flows: active + inside its validity
// window. Looked up server-side so a browser can't invent a discount.
async function lookupPromo(rawCode) {
  const code = clean(rawCode, 40);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(code)) throw bad(400, 'That code isn\u2019t valid.');
  // ilike treats "_" as a wildcard, so confirm the exact (case-insensitive) match ourselves.
  const rows = await sb('GET', `/rest/v1/promo_codes?code=ilike.${encodeURIComponent(code)}&select=*`);
  const promo = (rows || []).find((r) => String(r.code).toLowerCase() === code.toLowerCase());
  if (!promo) throw bad(400, 'That code isn\u2019t valid.');
  if (!promo.is_active) throw bad(400, 'This code is no longer active.');
  const { today } = riyadhNow();
  if (promo.valid_from && today < promo.valid_from) throw bad(400, 'This code isn\u2019t active yet.');
  if (promo.valid_until && today > promo.valid_until) throw bad(400, 'This code has expired.');
  return promo;
}

// SAR discount, computed PER PRODUCT LINE (not once on the order total) — a
// fixed-amount code multiplies by that line's quantity (SADA96 on qty 3 of
// one product = 288 off that line); a percent code is naturally proportional
// to quantity already, since it's a % of that line's own subtotal. Each
// line's discount is capped at that line's own value, so no line can go
// negative.
function promoDiscount(lines, promo) {
  return lines.reduce((sum, l) => {
    const lineSubtotal = l.unit_price * l.qty;
    let d = promo.discount_type === 'percent' ? lineSubtotal * (Number(promo.discount_value) / 100) : Number(promo.discount_value) * l.qty;
    d = Math.round(d * 100) / 100;
    return sum + Math.min(Math.max(0, d), lineSubtotal);
  }, 0);
}

// ── my-bookings ────────────────────────────────────────────────────────────
async function myBookings(user) {
  const cols = [
    'id', 'booking_reference', 'status', 'booking_type', 'customer_name', 'customer_phone',
    'city_name', 'location_address', 'floor_no', 'flat_no', 'slot_date', 'slot_hour',
    'product_model', 'product_qty', 'order_total', 'promo_code', 'discount_amount', 'referral_source', 'created_at',
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
  const promoCode = clean(body.promoCode, 40);
  const leadId = clean(body.leadId, 40);
  const toCoord = (v, min, max) => { const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
  const latitude = toCoord(body.latitude, -90, 90);
  const longitude = toCoord(body.longitude, -180, 180);

  if (!name) throw bad(400, 'Enter the customer name.');
  if (!phone) throw bad(400, 'That mobile number doesn\'t look right. Use a 10-digit Saudi mobile, e.g. 0558233001.');
  if (!UUID_RE.test(regionId)) throw bad(400, 'Choose a region.');
  if (!cityName) throw bad(400, 'Choose a city.');
  if (!address) throw bad(400, 'Enter the address the customer gave.');
  if (!UUID_RE.test(slotId)) throw bad(400, 'Pick an available date and time slot.');
  if (source && !ALLOWED_SOURCES.has(source)) throw bad(400, 'Unknown source.');
  if (!items.length || items.length > 12) throw bad(400, 'Add at least one product.');

  // Booking from a lead ("Convert to Booking") — confirm it's really theirs and
  // still open BEFORE reserving a slot, so a stale/bogus leadId fails cleanly
  // instead of creating a booking that then silently can't be linked.
  let lead = null;
  if (leadId) {
    if (!UUID_RE.test(leadId)) throw bad(400, 'Unknown lead.');
    const rows = await sb('GET', `/rest/v1/leads?id=eq.${leadId}&select=id,created_by_user,status`);
    lead = rows && rows[0];
    if (!lead || lead.created_by_user !== user.userId) throw bad(404, 'Lead not found.');
    if (lead.status !== 'open') throw bad(400, 'This lead has already been converted or marked lost.');
  }

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
  // A code the salesperson entered but that isn't valid stops the booking (never silently dropped).
  const promo = promoCode ? await lookupPromo(promoCode) : null;
  const discount = promo ? promoDiscount(lines, promo) : 0;

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
      p_region_id: regionId, p_address: address, p_latitude: latitude, p_longitude: longitude
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
      promo_code: promo ? promo.code : null,
      discount_amount: discount || null,
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
  if (lead) {
    await sb('PATCH', `/rest/v1/leads?id=eq.${leadId}`, {
      status: 'converted', converted_booking_id: bookingId, converted_at: new Date().toISOString(), updated_at: new Date().toISOString()
    }).catch((e) => warnings.push('lead: ' + e.message));
  }

  return {
    ok: true,
    booking: {
      id: bookingId, reference: created.booking_reference,
      slot_date: created.slot_date, slot_hour: created.slot_hour,
      customer_name: name, customer_phone: phone, city_name: cityName,
      subtotal, discount, promo_code: promo ? promo.code : null, total: Math.max(0, subtotal - discount)
    },
    warnings
  };
}

// ── my-leads ───────────────────────────────────────────────────────────────
async function myLeads(user) {
  const rows = await sb('GET',
    `/rest/v1/leads?created_by_user=eq.${user.userId}&select=*&order=created_at.desc&limit=500`);
  return { leads: rows || [] };
}

// ── create-lead ────────────────────────────────────────────────────────────
async function createLead(user, body) {
  const name = clean(body.name, 80);
  const phone = normalizePhone(body.phone);
  const regionId = clean(body.regionId, 40);
  const cityName = clean(body.cityName, 80) || null;
  const source = clean(body.source, 40) || null;
  const productInterest = clean(body.productInterest, 80) || null;
  const notes = clean(body.notes, 500) || null;

  if (!name) throw bad(400, 'Enter the lead\'s name.');
  if (!phone) throw bad(400, 'That mobile number doesn\'t look right. Use a 10-digit Saudi mobile, e.g. 0558233001.');
  if (regionId && !UUID_RE.test(regionId)) throw bad(400, 'Choose a valid region.');
  if (source && !ALLOWED_SOURCES.has(source)) throw bad(400, 'Unknown source.');
  if (productInterest) {
    const catalogue = await sb('GET', '/rest/v1/product_models?select=model_name');
    if (!(catalogue || []).some((p) => p.model_name === productInterest)) throw bad(400, `Unknown product: ${productInterest}`);
  }

  const rows = await sb('POST', '/rest/v1/leads', {
    name, phone, region_id: regionId || null, city_name: cityName,
    source, product_interest: productInterest, notes,
    status: 'open', created_by_user: user.userId, created_by_name: user.name
  }, null, { Prefer: 'return=representation' });
  const row = rows && rows[0];
  if (!row) throw bad(500, 'Could not save the lead.');

  await sb('POST', '/rest/v1/activity_log', {
    actor: user.email, action: 'lead.create',
    summary: `Sales (${user.name}) added a lead: ${name} (${phone})`,
    entity_type: 'lead', entity_id: String(row.id)
  }).catch(() => {});

  return { ok: true, lead: row };
}

// ── mark-lead-lost ─────────────────────────────────────────────────────────
async function markLeadLost(user, body) {
  const leadId = clean(body.leadId, 40);
  const reason = clean(body.reason, 300) || null;
  if (!UUID_RE.test(leadId)) throw bad(400, 'Unknown lead.');

  const rows = await sb('GET', `/rest/v1/leads?id=eq.${leadId}&select=id,created_by_user,status`);
  const lead = rows && rows[0];
  if (!lead || lead.created_by_user !== user.userId) throw bad(404, 'Lead not found.');
  if (lead.status !== 'open') throw bad(400, 'This lead is no longer open.');

  await sb('PATCH', `/rest/v1/leads?id=eq.${leadId}`, {
    status: 'lost', lost_reason: reason, updated_at: new Date().toISOString()
  });
  return { ok: true };
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
      case 'check-promo': {
        const p = await lookupPromo(body.code);
        return res.status(200).json({ code: p.code, discount_type: p.discount_type, discount_value: Number(p.discount_value) });
      }
      case 'my-bookings': return res.status(200).json(await myBookings(user));
      case 'my-leads': return res.status(200).json(await myLeads(user));
      case 'create-lead': return res.status(201).json(await createLead(user, body));
      case 'mark-lead-lost': return res.status(200).json(await markLeadLost(user, body));
      case 'create-booking': return res.status(201).json(await createBooking(user, body));
      default: return res.status(400).json({ error: 'Unknown action' });
    }
  } catch (e) {
    const code = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (!e.expose) console.error('sales/ops:', e.message);
    return res.status(code).json({ error: e.expose ? e.message : 'Something went wrong. Please try again.' });
  }
};
