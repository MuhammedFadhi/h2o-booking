// SA'DA H2O — ZATCA onboarding from the dashboard (admin-only).
// Takes the Fatoora OTP, adds the ZATCA seller details from the dashboard, and asks
// the signing service to onboard: key + CSR -> compliance certificate ->
// compliance checks -> production certificate. The keys stay on the relay.
const { requireAdmin } = require('./_auth.js');
const { relayConfigured, relayCall, sellerFromCompany, sellerIssues } = require('./_zatca.js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  let ctx;
  try { ctx = await requireAdmin(req); }
  catch (e) { return res.status(e.status || 401).json({ error: e.message }); }

  if (!relayConfigured()) {
    return res.status(200).json({ configured: false, error: 'The ZATCA signing service is not connected yet (ZATCA_RELAY_URL / ZATCA_RELAY_KEY).' });
  }

  const otp = String((req.body || {}).otp || '').trim();
  try {
    const { data: cs } = await ctx.admin.from('company_settings').select('*').eq('id', 'default').maybeSingle();
    const issues = sellerIssues(cs || {});
    if (issues.length) {
      return res.status(400).json({ error: 'Complete the ZATCA seller details first: ' + issues.map(i => i.text).join(' ') });
    }
    // Onboarding signs and submits several sample documents: allow it a few minutes.
    const { ok, out } = await relayCall('/onboard', { method: 'POST', body: { otp, seller: sellerFromCompany(cs) }, timeoutMs: 180000 });
    return res.status(ok ? 200 : 400).json(out);
  } catch (e) {
    console.error('zatca-onboard error:', e.message);
    return res.status(502).json({ error: e.name === 'AbortError' ? 'The signing service did not finish in time. Check the ZATCA page — onboarding resumes from where it stopped.' : e.message });
  }
};
