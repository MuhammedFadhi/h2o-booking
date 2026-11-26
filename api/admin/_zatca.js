// Shared ZATCA helpers for the admin Worker endpoints (zatca-status,
// zatca-onboard, zatca-report). The relay holds the private key and the ZATCA
// certificates; these endpoints hold the relay URL + key so the browser never does.
//
// Env (Worker secrets): ZATCA_RELAY_URL, ZATCA_RELAY_KEY.
// Optional var: ZATCA_ENV — the environment to show/configure while the relay is
// not connected yet (developer-portal | simulation | core). Default simulation.

const RELAY_URL = (process.env.ZATCA_RELAY_URL || '').replace(/\/$/, '');
const RELAY_KEY = process.env.ZATCA_RELAY_KEY || '';
const FALLBACK_ENV = process.env.ZATCA_ENV || 'simulation';

const ENV_LABELS = { 'developer-portal': 'SANDBOX', simulation: 'SIMULATION', core: 'PRODUCTION' };

function relayConfigured() { return !!(RELAY_URL && RELAY_KEY); }

async function relayCall(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(RELAY_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'x-relay-key': RELAY_KEY },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const out = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, out };
  } finally {
    clearTimeout(t);
  }
}

// The relay's live status, or a "not connected" stand-in.
async function relayStatus() {
  if (!relayConfigured()) {
    return { configured: false, connected: false, environment: FALLBACK_ENV, onboarded: false, hasCompliance: false };
  }
  try {
    const { ok, out } = await relayCall('/status', { timeoutMs: 8000 });
    if (!ok) return { configured: true, connected: false, environment: FALLBACK_ENV, onboarded: false, hasCompliance: false, error: out.error || 'Signing service error' };
    return { configured: true, connected: true, ...out };
  } catch (e) {
    return { configured: true, connected: false, environment: FALLBACK_ENV, onboarded: false, hasCompliance: false,
      error: e.name === 'AbortError' ? 'Signing service did not answer in time' : e.message };
  }
}

async function deviceState(admin, env) {
  const { data } = await admin.from('zatca_device_state').select('*').eq('environment', env).maybeSingle();
  return data || { environment: env, auto_submit: null, phase2_start_date: null };
}

// Seller identity for the CSR and the e-invoice, from the ZATCA seller details (company_settings).
function sellerFromCompany(cs) {
  return {
    vatNumber: cs.vat_number || '', name: cs.seller_name_ar || cs.seller_name_en || '',
    nameEn: cs.seller_name_en || '', crNumber: cs.cr_number || '',
    street: cs.street_ar || cs.street_en || '', building: cs.building_no || '',
    plot: cs.secondary_no || '', district: cs.district_ar || cs.district_en || '',
    city: cs.city || '', postalZone: cs.postal_code || '', countryCode: 'SA',
  };
}

// The seller fields ZATCA rejects or warns about (BR-KSA-64 etc.), checked
// before anything is sent. Same rules the ZATCA page shows as its checklist.
function sellerIssues(cs) {
  const issues = [];
  const add = (field, text) => issues.push({ field, text });
  if (!/^3\d{13}3$/.test(cs.vat_number || '')) add('vat_number', 'VAT number must be 15 digits, starting and ending with 3.');
  if (!(cs.seller_name_ar || cs.seller_name_en)) add('seller_name', 'Legal name is missing.');
  if (!cs.cr_number) add('cr_number', 'CR number is missing.');
  if (!/^\d{4}$/.test(cs.building_no || '')) add('building_no', 'Building number must be 4 digits.');
  if (!(cs.street_ar || cs.street_en)) add('street', 'Street is missing.');
  if (!(cs.district_ar || cs.district_en)) add('district', 'District is missing.');
  if (!cs.city) add('city', 'City is missing.');
  if (!/^\d{5}$/.test(cs.postal_code || '')) add('postal_code', 'Postal code must be 5 digits.');
  return issues;
}

// B2B (standard tax invoice) buyer — the same rules the dashboard checks.
const BUYER_ID_SCHEMES = ['CRN', 'MOM', 'MLS', '700', 'SAG', 'NAT', 'GCC', 'IQA', 'PAS', 'TIN', 'OTH'];
function buyerIssues(inv) {
  const out = [];
  const v = (k) => String(inv[k] == null ? '' : inv[k]).trim();
  if (!v('customer_name')) out.push('Buyer name is required.');
  if (v('buyer_vat_number')) {
    if (!/^3\d{13}3$/.test(v('buyer_vat_number'))) out.push('Buyer VAT number must be 15 digits, starting and ending with 3.');
  } else if (!v('buyer_id_number') || !BUYER_ID_SCHEMES.includes(v('buyer_id_scheme'))) {
    out.push('Enter the buyer VAT number, or another ID (e.g. CR number) with its type.');
  }
  if ((v('buyer_country') || 'SA') === 'SA') {
    if (!v('buyer_street')) out.push('Buyer street is required.');
    if (!/^\d{4}$/.test(v('buyer_building_no'))) out.push('Buyer building number must be 4 digits.');
    if (!v('buyer_district')) out.push('Buyer district is required.');
    if (!v('buyer_city')) out.push('Buyer city is required.');
    if (!/^\d{5}$/.test(v('buyer_postal_code'))) out.push('Buyer postal code must be 5 digits.');
    if (v('buyer_additional_no') && !/^\d{4}$/.test(v('buyer_additional_no'))) out.push('Buyer additional number must be 4 digits.');
  }
  return out;
}

module.exports = { relayConfigured, relayCall, relayStatus, deviceState, sellerFromCompany, sellerIssues, buyerIssues, BUYER_ID_SCHEMES, ENV_LABELS, FALLBACK_ENV };
