/* SA'DA H2O — Warranty Certificate generator.
   Produces a branded, professional certificate in a new window and opens the
   print dialog (customer saves as PDF). No external libraries — works in the
   browser-only workflow. Call SADACert.open(data). */
(function (global) {
  function fmt(d) {
    if (!d) return '—';
    try { const x = new Date(d); return x.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' }); }
    catch (e) { return String(d); }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  function html(data) {
    const {
      name = '', serial = '', product = '', registrationDate = '',
      filterExpiry = '', serviceExpiry = '', warrantyExpiry = '', reference = ''
    } = data || {};
    const activated = !!warrantyExpiry;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>SA'DA H2O — Warranty Certificate</title>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  @page { size: A4 portrait; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'DM Sans',sans-serif; color:#0A1628; background:#fff; }
  .sheet { width:210mm; min-height:297mm; padding:0; position:relative; }
  .border-frame { position:absolute; inset:12mm; border:2px solid #C9A84C; pointer-events:none; }
  .border-frame::before { content:''; position:absolute; inset:4px; border:1px solid #C9A84C; opacity:.5; }
  .inner { padding:26mm 24mm; position:relative; z-index:1; }
  .head { text-align:center; border-bottom:2px solid #0D3B6E; padding-bottom:16px; margin-bottom:8px; }
  .brand { font-family:'Playfair Display',serif; font-size:30px; font-weight:700; color:#0D3B6E; letter-spacing:1px; }
  .brand span { color:#1565C0; }
  .subbrand { font-size:11px; letter-spacing:5px; color:#607D8B; text-transform:uppercase; margin-top:3px; }
  .title { text-align:center; font-family:'Playfair Display',serif; font-size:23px; color:#0A1628; margin:26px 0 4px; letter-spacing:.5px; }
  .title-sub { text-align:center; font-size:12px; color:#607D8B; margin-bottom:26px; }
  .seal { position:absolute; top:22mm; right:24mm; width:70px; height:70px; border-radius:50%; background:radial-gradient(circle at 30% 30%, #1E88E5, #0D3B6E); color:#fff; display:flex; align-items:center; justify-content:center; font-size:30px; box-shadow:0 4px 14px rgba(13,59,110,.3); }
  .row { display:flex; padding:11px 0; border-bottom:1px solid #E2E8F0; font-size:14px; }
  .row .k { width:42%; color:#607D8B; font-weight:600; }
  .row .v { width:58%; color:#0A1628; font-weight:700; }
  .status-chip { display:inline-block; padding:3px 12px; border-radius:20px; font-size:12px; font-weight:700; }
  .active { background:#DCFCE7; color:#15803D; }
  .pending { background:#FFEDD5; color:#C2410C; }
  .coverage { margin-top:26px; background:#F0F6FF; border-left:4px solid #1565C0; border-radius:8px; padding:16px 18px; }
  .coverage h3 { font-size:13px; text-transform:uppercase; letter-spacing:.5px; color:#0D3B6E; margin-bottom:10px; }
  .cov-grid { display:flex; gap:14px; }
  .cov-item { flex:1; text-align:center; background:#fff; border:1px solid #DBEAFE; border-radius:8px; padding:12px 8px; }
  .cov-item .lbl { font-size:10px; text-transform:uppercase; letter-spacing:.4px; color:#607D8B; }
  .cov-item .dt { font-size:15px; font-weight:700; color:#0D3B6E; margin-top:4px; }
  .terms { margin-top:24px; font-size:11px; color:#42546b; line-height:1.7; }
  .terms h3 { font-size:12px; text-transform:uppercase; letter-spacing:.5px; color:#0A1628; margin-bottom:8px; }
  .terms .void { color:#B91C1C; font-weight:700; }
  .foot { margin-top:40px; padding-top:16px; border-top:1px solid #E2E8F0; display:flex; justify-content:space-between; align-items:flex-end; font-size:11px; color:#607D8B; }
  .sig { text-align:center; }
  .sig .line { width:150px; border-top:1.5px solid #0A1628; margin-bottom:5px; }
  .print-bar { position:fixed; top:0; left:0; right:0; background:#0D3B6E; color:#fff; padding:12px; text-align:center; z-index:99; font-family:'DM Sans',sans-serif; }
  .print-bar button { background:#C9A84C; color:#0A1628; border:none; padding:9px 22px; border-radius:8px; font-weight:700; cursor:pointer; font-size:14px; margin:0 6px; }
  .print-bar button.ghost { background:rgba(255,255,255,.15); color:#fff; }
  @media print { .print-bar { display:none; } .sheet { box-shadow:none; } }
</style></head><body>
  <div class="print-bar">
    Your warranty certificate is ready. <button onclick="window.print()">⬇ Save as PDF / Print</button>
    <button class="ghost" onclick="window.close()">Close</button>
  </div>
  <div class="sheet">
    <div class="border-frame"></div>
    <div class="inner">
      <div class="seal">🛡️</div>
      <div class="head">
        <div class="brand">SA'DA <span>H₂O</span></div>
        <div class="subbrand">Water Purifiers · The Art of Purity</div>
      </div>
      <div class="title">Certificate of Warranty</div>
      <div class="title-sub">This certifies that the unit below is registered and covered under SA'DA H₂O warranty.</div>

      <div class="row"><div class="k">Customer Name</div><div class="v">${esc(name) || '—'}</div></div>
      <div class="row"><div class="k">Product Model</div><div class="v">${esc(product) || '—'}</div></div>
      <div class="row"><div class="k">Serial Number</div><div class="v">${esc(serial) || '—'}</div></div>
      ${reference ? `<div class="row"><div class="k">Booking Reference</div><div class="v">${esc(reference)}</div></div>` : ''}
      <div class="row"><div class="k">Registration Date</div><div class="v">${fmt(registrationDate)}</div></div>
      <div class="row"><div class="k">Warranty Status</div><div class="v"><span class="status-chip ${activated?'active':'pending'}">${activated?'ACTIVE':'NOT ACTIVATED'}</span></div></div>

      <div class="coverage">
        <h3>Coverage Milestones</h3>
        <div class="cov-grid">
          <div class="cov-item"><div class="lbl">Filter Due</div><div class="dt">${fmt(filterExpiry)}</div></div>
          <div class="cov-item"><div class="lbl">Annual Service</div><div class="dt">${fmt(serviceExpiry)}</div></div>
          <div class="cov-item"><div class="lbl">Warranty Until</div><div class="dt">${activated?fmt(warrantyExpiry):'On activation'}</div></div>
        </div>
      </div>

      <div class="terms">
        <h3>Terms &amp; Conditions</h3>
        <p><span class="void">Important — Warranty Validity:</span> This warranty is valid <strong>only</strong> while filter replacements and annual servicing are carried out by SA'DA H₂O or its authorised technicians. <span class="void">Using third-party filters, parts, or unauthorised service providers immediately voids this warranty.</span></p>
        <p style="margin-top:8px;">The warranty covers manufacturing defects in the unit's core components. It does not cover physical damage, misuse, water-quality damage from unsupported source water, or consumable filters beyond their rated life. Filter and service due dates begin at installation; warranty coverage begins on customer activation. Please keep this certificate for your records. For service, contact SA'DA H₂O on 920022569.</p>
      </div>

      <div class="foot">
        <div>Issued: ${fmt(new Date().toISOString())}<br>SA'DA H₂O Water Purifiers</div>
        <div class="sig"><div class="line"></div>Authorised Signature</div>
      </div>
    </div>
  </div>
</body></html>`;
  }

  function open(data) {
    const w = window.open('', '_blank');
    if (!w) { alert('Please allow pop-ups to view the certificate.'); return; }
    w.document.write(html(data));
    w.document.close();
  }

  global.SADACert = { open, html };
})(window);
