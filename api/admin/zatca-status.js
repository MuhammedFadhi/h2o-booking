// SA'DA H2O — ZATCA status for the dashboard's ZATCA E-Invoicing page (admin-only).
// Returns the signing service's environment + onboarding state, and a check of the
// seller details ZATCA needs. Settings, counts and the pending list are read by
// the dashboard straight from Supabase (zatca_device_state, invoices).
const { requireAdmin } = require('./_auth.js');
const { relayStatus, sellerIssues, ENV_LABELS } = require('./_zatca.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  let ctx;
  try { ctx = await requireAdmin(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  try {
    const relay = await relayStatus();
    const { data: cs } = await ctx.admin.from('company_settings').select('*').eq('id', 'default').maybeSingle();
    return res.status(200).json({
      relay,
      environment: relay.environment,
      environmentLabel: ENV_LABELS[relay.environment] || String(relay.environment || '').toUpperCase(),
      sellerIssues: sellerIssues(cs || {}),
    });
  } catch (e) {
    console.error('zatca-status error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
