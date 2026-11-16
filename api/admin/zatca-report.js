// SA'DA H2O — ZATCA Phase-2 reporting proxy (admin-only).
// The browser must never hold the relay key, and the relay must never be public,
// so the dashboard calls here; this Worker handler forwards one invoice to the
// signing relay and records the result on the invoice.
//
// Body: { invoiceId, auto? }  — auto:true is the automatic submission made right
// after an invoice is saved; it is skipped (not an error) when automatic
// submission is OFF, the service is not onboarded, or the invoice is Phase 1.
//
// Every rule is enforced HERE, not only in the dashboard (as in Al Amanah):
//   * nothing is sent until the Phase 2 start date is set, and nothing dated
//     before it is ever sent (those were Phase 1 documents);
//   * an invoice already reported/cleared in this environment is never re-sent;
//   * an invoice issued under another VAT number is never sent;
//   * the seller's National Address must be complete (ZATCA warns otherwise,
//     and records warnings as violations).
const crypto = require('crypto');
const { requireAdmin } = require('./_auth.js');
const { relayConfigured, relayCall, relayStatus, deviceState, sellerFromCompany, sellerIssues } = require('./_zatca.js');

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

  const { invoiceId, auto } = req.body || {};
  if (!invoiceId) return res.status(400).json({ error: 'invoiceId required' });
  const skip = (reason, message) => res.status(200).json({ skipped: reason, message });

  if (!relayConfigured()) {
    if (auto) return skip('not_configured', 'Signing service not connected.');
    return res.status(200).json({ configured: false, message: 'ZATCA signing service not connected yet (ZATCA_RELAY_URL / ZATCA_RELAY_KEY).' });
  }

  try {
    const relay = await relayStatus();
    if (!relay.connected) {
      if (auto) return skip('relay_down', relay.error || 'Signing service unreachable.');
      return res.status(503).json({ error: 'The ZATCA signing service is not reachable: ' + (relay.error || 'unknown error') });
    }
    const env = relay.environment;
    if (!relay.onboarded) {
      if (auto) return skip('not_onboarded', 'Not onboarded.');
      return res.status(400).json({ error: `Not onboarded for ${env}. Onboard on the ZATCA E-Invoicing page first.` });
    }

    const state = await deviceState(admin, env);
    if (auto && !state.auto_submit) return skip('disabled', 'Automatic submission is OFF.');

    const { data: inv } = await admin.from('invoices')
      .select('*, bookings(booking_reference, city_name)').eq('id', invoiceId).maybeSingle();
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.total == null) return res.status(400).json({ error: 'Invoice has no total — cannot e-invoice.' });
    if (inv.einvoice_env === env && ['reported', 'cleared'].includes(inv.einvoice_status)) {
      return res.status(200).json({ already: true, status: inv.einvoice_status, qr: inv.zatca_qr });
    }

    // Phase 2 start date: the single check behind every route (button, batch, auto).
    if (!state.phase2_start_date) {
      if (auto) return skip('no_phase2_date', 'Phase 2 start date not set.');
      return res.status(400).json({ error: 'Set the Phase 2 start date on the ZATCA E-Invoicing page first: invoices dated before your integration date must never be sent to ZATCA.' });
    }
    // Saudi calendar day (UTC+3), the same day the dashboard shows.
    const issuedDay = new Date(new Date(inv.issued_at).getTime() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    if (issuedDay < state.phase2_start_date) {
      if (auto) return skip('phase1', 'Phase 1 invoice.');
      return res.status(400).json({ error: `This invoice is dated ${issuedDay}, before the Phase 2 start date (${state.phase2_start_date}). It was a Phase 1 invoice and must not be sent to ZATCA.` });
    }

    const { data: cs } = await admin.from('company_settings').select('*').eq('id', 'default').maybeSingle();
    const issues = sellerIssues(cs || {});
    if (issues.length) {
      return res.status(400).json({ error: 'Complete Tax / Company info first: ' + issues.map(i => i.text).join(' ') });
    }
    if (inv.seller_vat_number && inv.seller_vat_number.replace(/\s+/g, '') !== cs.vat_number) {
      return res.status(400).json({ error: `This invoice was issued under VAT ${inv.seller_vat_number}, not ${cs.vat_number}, so it cannot be sent under this ZATCA certificate.` });
    }

    let items = [];
    if (Array.isArray(inv.line_items) && inv.line_items.length) {
      // Lines saved on the invoice itself (New Invoice form, migration v121).
      items = inv.line_items.map(r => ({ name: r.description || 'Item', qty: Number(r.qty) || 1, unitPriceInclVat: Number(r.unitInclVat) || 0 }));
    } else if (inv.booking_id) {
      const { data: bi } = await admin.from('booking_items')
        .select('product_model, qty, unit_price').eq('booking_id', inv.booking_id);
      items = (bi || []).map(r => ({ name: r.product_model, qty: r.qty || 1, unitPriceInclVat: Number(r.unit_price) || 0 }));
    }
    items = items.filter(i => i.qty > 0);
    if (!items.length) items = [{ name: 'Installation / Service', qty: 1, unitPriceInclVat: Number(inv.total) }];

    // ICV (monotonic counter) + PIH (hash of the previous document this EGS
    // signed in this environment) for the hash chain.
    const { data: icvData } = await admin.rpc('next_einvoice_icv');
    const icv = Number(icvData) || 1;
    const { data: prev } = await admin.from('invoices')
      .select('einvoice_hash').eq('einvoice_env', env).not('einvoice_hash', 'is', null)
      .order('einvoice_icv', { ascending: false }).limit(1).maybeSingle();
    const pih = prev?.einvoice_hash || SEED_PIH;

    const payload = {
      invoiceNumber: inv.invoice_number,
      uuid: inv.einvoice_uuid || undefined,
      issueInstant: inv.issued_at,
      icv, pih,
      invoiceType: 'simplified',
      seller: sellerFromCompany(cs),
      buyer: { name: inv.customer_name, phone: inv.customer_phone },
      lines: items,
      totalInclVat: Number(inv.total),
    };

    const { ok, out } = await relayCall('/sign-report', { method: 'POST', body: payload, timeoutMs: 60000 });
    const now = new Date().toISOString();
    if (!ok || out.error) {
      const reason = out.zatca?.validationResults
        ? JSON.stringify({ validationResults: out.zatca.validationResults })
        : (out.detail || out.error || 'Signing service error');
      const upd = {
        einvoice_env: env, einvoice_status: 'failed', einvoice_error: reason,
        einvoice_response: out, zatca_submitted_at: now,
      };
      // Keep the hash/uuid/qr if the relay produced them (the chain moved on).
      if (out.uuid) Object.assign(upd, { einvoice_uuid: out.uuid, einvoice_hash: out.invoiceHash, zatca_qr: out.qr, einvoice_icv: icv, einvoice_pih: pih });
      await admin.from('invoices').update(upd).eq('id', invoiceId);
      return res.status(502).json({ error: 'ZATCA did not accept this invoice.', detail: reason, env });
    }

    const status = out.cleared ? 'cleared' : (out.status === 'REPORTED' || out.reported ? 'reported' : 'failed');
    await admin.from('invoices').update({
      einvoice_uuid: out.uuid, einvoice_hash: out.invoiceHash, zatca_qr: out.qr,
      einvoice_icv: icv, einvoice_pih: pih, einvoice_status: status, einvoice_env: env,
      einvoice_error: status === 'failed' ? JSON.stringify(out.zatca || out) : null,
      einvoice_response: out.zatca || out, zatca_submitted_at: now,
    }).eq('id', invoiceId);

    return res.status(200).json({ ok: true, status, env, qr: out.qr, uuid: out.uuid, warnings: out.warnings || [] });
  } catch (e) {
    console.error('zatca-report error:', e.message);
    if (auto) return skip('error', e.message);
    return res.status(500).json({ error: e.name === 'AbortError' ? 'The signing service did not answer in time — try again.' : e.message });
  }
};
