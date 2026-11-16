// SA'DA H2O — ZATCA Phase-2 reporting proxy (admin-only).
// The browser must never hold the relay key, and the relay must never be public,
// so the dashboard calls here; this Worker handler injects the relay URL + key
// from env and forwards one invoice to the signing relay, then records the result.
//
// Env (Worker secrets): ZATCA_RELAY_URL (e.g. https://zatca.sadawater.com),
//                       ZATCA_RELAY_KEY (matches the relay's RELAY_API_KEY).
// Until both are set this endpoint cleanly reports { configured:false } so the
// live app keeps working before onboarding is done.
const crypto = require('crypto');
const { requireAdmin } = require('./_auth.js');

const RELAY_URL = process.env.ZATCA_RELAY_URL || '';
const RELAY_KEY = process.env.ZATCA_RELAY_KEY || '';
// ZATCA's defined first-invoice PIH = Base64( SHA256("0") ).
const SEED_PIH = crypto.createHash('sha256').update('0').digest('base64');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let ctx;
  try { ctx = await requireAdmin(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }
  const admin = ctx.admin;

  if (!RELAY_URL || !RELAY_KEY) {
    return res.status(200).json({ configured: false, message: 'ZATCA relay not configured yet (ZATCA_RELAY_URL / ZATCA_RELAY_KEY).' });
  }

  const { invoiceId } = req.body || {};
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });

  try {
    // Load the invoice, its booking + line items, and the seller identity.
    const { data: inv } = await admin.from('invoices')
      .select('*, bookings(booking_reference, city_name)').eq('id', invoiceId).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.total == null) return res.status(400).json({ error: 'Invoice has no total — cannot e-invoice.' });
    if (inv.einvoice_status === 'reported' || inv.einvoice_status === 'cleared') {
      return res.status(200).json({ already: true, status: inv.einvoice_status, qr: inv.zatca_qr });
    }

    const { data: cs } = await admin.from('company_settings').select('*').eq('id', 'default').maybeSingle();
    if (!cs || !cs.vat_number) return res.status(400).json({ error: 'Set the seller VAT number in Tax / Company info first.' });

    let items = [];
    if (inv.booking_id) {
      const { data: bi } = await admin.from('booking_items')
        .select('product_model, qty, unit_price').eq('booking_id', inv.booking_id);
      items = (bi || []).map(r => ({ name: r.product_model, qty: r.qty || 1, unitPriceInclVat: Number(r.unit_price) || 0 }));
    }
    if (!items.length) items = [{ name: 'Installation / Service', qty: 1, unitPriceInclVat: Number(inv.total) }];

    // ICV (monotonic counter) + PIH (previous invoice hash) for the hash chain.
    const { data: icvData } = await admin.rpc('next_einvoice_icv');
    const icv = Number(icvData) || 1;
    const { data: prev } = await admin.from('invoices')
      .select('einvoice_hash').not('einvoice_hash', 'is', null)
      .order('zatca_submitted_at', { ascending: false }).limit(1).maybeSingle();
    const pih = prev?.einvoice_hash || SEED_PIH;

    const payload = {
      invoiceNumber: inv.invoice_number,
      uuid: inv.einvoice_uuid || undefined,
      issueInstant: inv.issued_at,
      icv, pih,
      invoiceType: 'simplified',
      seller: {
        vatNumber: cs.vat_number, name: cs.seller_name_en, crNumber: cs.cr_number || '',
        city: cs.city || '', countryCode: 'SA',
      },
      buyer: { name: inv.customer_name, phone: inv.customer_phone },
      lines: items,
      totalInclVat: Number(inv.total),
    };

    const r = await fetch(`${RELAY_URL.replace(/\/$/, '')}/sign-report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-relay-key': RELAY_KEY },
      body: JSON.stringify(payload),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok || out.error) {
      // Persist the hash/uuid/qr if the relay produced them (so a retry can report).
      if (out.uuid) await admin.from('invoices').update({
        einvoice_uuid: out.uuid, einvoice_hash: out.invoiceHash, zatca_qr: out.qr,
        einvoice_icv: icv, einvoice_pih: pih, einvoice_status: 'failed',
        einvoice_response: out, zatca_submitted_at: new Date().toISOString(),
      }).eq('id', invoiceId);
      return res.status(502).json({ error: out.error || out.detail || 'Relay error', detail: out });
    }

    const status = out.cleared ? 'cleared' : (out.status === 'REPORTED' || out.reported ? 'reported' : 'failed');
    await admin.from('invoices').update({
      einvoice_uuid: out.uuid, einvoice_hash: out.invoiceHash, zatca_qr: out.qr,
      einvoice_icv: icv, einvoice_pih: pih, einvoice_status: status,
      einvoice_response: out.zatca || out, zatca_submitted_at: new Date().toISOString(),
    }).eq('id', invoiceId);

    return res.status(200).json({ ok: true, status, qr: out.qr, uuid: out.uuid, warnings: out.warnings || [] });
  } catch (e) {
    console.error('zatca-report error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
