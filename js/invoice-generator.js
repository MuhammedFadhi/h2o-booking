/* SA'DA H2O — ZATCA (Fatoora) Phase-1 SIMPLIFIED TAX INVOICE generator.
   Produces a branded, bilingual (Arabic/English) tax invoice in a new window and
   opens the print dialog (customer / admin saves as PDF). No build step; the only
   external dependency is a QR library loaded from cdnjs inside the print window.

   ZATCA Phase-1 ("generation") requires a simplified tax invoice to carry a QR
   code encoding a Base64 TLV (Tag-Length-Value) of exactly five fields:
     1 seller name, 2 VAT registration number, 3 ISO-8601 timestamp,
     4 invoice total (incl VAT), 5 VAT total.
   buildQrPayload() produces that Base64 string; the document renders it as a QR.

   Call SADAInvoice.open(data). See printInvoice() in the dashboard for `data`. */
(function (global) {
  'use strict';

  // ---- helpers -------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  function money(n) {
    const v = Number(n || 0);
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function fmtDateTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      const date = d.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
      const time = d.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });
      return `${date} · ${time}`;
    } catch (e) { return String(iso); }
  }

  // ---- ZATCA Phase-1 TLV QR payload ---------------------------------------
  // Each field: [tag:1 byte][length:1 byte][UTF-8 value bytes]. Concatenate the
  // five fields and Base64-encode. Length is the BYTE length (matters for the
  // Arabic seller name), so we encode with TextEncoder.
  function tlv(tag, value) {
    const bytes = new TextEncoder().encode(String(value == null ? '' : value));
    const out = new Uint8Array(2 + bytes.length);
    out[0] = tag; out[1] = bytes.length; out.set(bytes, 2);
    return out;
  }
  function bytesToBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return global.btoa(bin);
  }
  // { sellerName, vatNumber, timestamp(ISO), total(incl VAT), vatTotal }
  function buildQrPayload(p) {
    const parts = [
      tlv(1, p.sellerName || ''),
      tlv(2, p.vatNumber || ''),
      tlv(3, p.timestamp || new Date().toISOString()),
      tlv(4, round2(p.total).toFixed(2)),
      tlv(5, round2(p.vatTotal).toFixed(2)),
    ];
    const len = parts.reduce((s, a) => s + a.length, 0);
    const all = new Uint8Array(len);
    let off = 0;
    for (const a of parts) { all.set(a, off); off += a.length; }
    return bytesToBase64(all);
  }

  // ---- document ------------------------------------------------------------
  function html(data) {
    const d = data || {};
    const s = d.seller || {};
    const c = d.customer || {};
    const VAT_RATE = 0.15;

    const sellerNameEn = s.nameEn || s.seller_name_en || "SA'DA H2O Water Purifiers";
    const sellerNameAr = s.nameAr || s.seller_name_ar || '';
    const vatNumber    = s.vatNumber || s.vat_number || '';
    const crNumber     = s.crNumber || s.cr_number || '';
    const addressEn    = s.addressEn || s.address_en || '';
    const addressAr    = s.addressAr || s.address_ar || '';
    const sellerPhone  = s.phone || '';
    const sellerCity   = s.city || '';

    // Line items: unit_price in this system is the GROSS (VAT-inclusive) selling
    // price. Fall back to a single service line when a booking has no basket.
    let items = Array.isArray(d.items) && d.items.length ? d.items.slice() : [];
    const grandTotal = d.totalInclVat != null
      ? round2(d.totalInclVat)
      : round2(items.reduce((sum, it) => sum + (Number(it.qty)||1) * (Number(it.unitInclVat)||0), 0));
    if (!items.length) {
      items = [{ description: 'Installation / Service', qty: 1, unitInclVat: grandTotal }];
    }

    const itemsGross = round2(items.reduce((sum, it) => sum + (Number(it.qty)||1) * (Number(it.unitInclVat)||0), 0));
    // If a discount made the booking total lower than the sum of line prices,
    // show the difference as a discount line so the maths reconciles.
    const discount = itemsGross > grandTotal + 0.01 ? round2(itemsGross - grandTotal) : 0;

    // Totals are derived from the authoritative gross grand total (matches how
    // submitPayment derives net/VAT), so the QR and the printed totals agree.
    const totalNet = round2(grandTotal / (1 + VAT_RATE));
    const totalVat = round2(grandTotal - totalNet);

    const rows = items.map((it, i) => {
      const qty = Number(it.qty) || 1;
      const unitGross = Number(it.unitInclVat) || 0;
      const lineGross = round2(qty * unitGross);
      const lineNet   = round2(lineGross / (1 + VAT_RATE));
      const lineVat   = round2(lineGross - lineNet);
      const unitNet   = round2(unitGross / (1 + VAT_RATE));
      return `<tr>
        <td class="c">${i + 1}</td>
        <td>${esc(it.description || '—')}</td>
        <td class="c">${qty}</td>
        <td class="r">${money(unitNet)}</td>
        <td class="r">${money(lineNet)}</td>
        <td class="r">${money(lineVat)}</td>
        <td class="r">${money(lineGross)}</td>
      </tr>`;
    }).join('');

    const discountRow = discount > 0
      ? `<tr class="disc"><td></td><td>Discount / خصم</td><td colspan="4"></td><td class="r">-${money(discount)}</td></tr>`
      : '';

    // QR: prefer a stored payload (byte-identical re-prints); else build it now.
    const qrPayload = d.qrPayload || buildQrPayload({
      sellerName: sellerNameAr || sellerNameEn, vatNumber, timestamp: d.issuedAt, total: grandTotal, vatTotal: totalVat,
    });

    const vatMissing = !vatNumber;
    const methodLabel = d.paymentMethod ? String(d.paymentMethod).replace(/_/g, ' ') : '';

    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>SA'DA H2O — Tax Invoice ${esc(d.invoiceNumber || '')}</title>
<link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700&family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@700&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
<style>
  @page { size: A4 portrait; margin: 0; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'DM Sans',sans-serif; color:#0A1628; background:#eef1f5; }
  .sheet { width:210mm; min-height:297mm; margin:0 auto; background:#fff; padding:14mm 14mm 12mm; position:relative; }
  .ar { font-family:'Cairo',sans-serif; direction:rtl; }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:3px solid #0D3B6E; padding-bottom:12px; }
  .brand { font-family:'Playfair Display',serif; font-size:26px; font-weight:700; color:#0D3B6E; }
  .brand span { color:#1565C0; }
  .brand-ar { font-family:'Cairo',sans-serif; font-size:18px; font-weight:700; color:#0D3B6E; text-align:right; }
  .sub { font-size:10px; letter-spacing:3px; color:#607D8B; text-transform:uppercase; margin-top:2px; }
  .doc-title { text-align:center; margin:16px 0 4px; }
  .doc-title .en { font-size:17px; font-weight:700; letter-spacing:.5px; color:#0A1628; }
  .doc-title .ar { font-size:16px; font-weight:700; color:#0A1628; direction:rtl; }
  .warn { background:#FEF2F2; border:1px solid #FECACA; color:#B71C1C; font-size:12px; font-weight:600;
          padding:8px 12px; border-radius:8px; margin:10px 0; text-align:center; }
  .panels { display:flex; gap:12px; margin-top:14px; }
  .panel { flex:1; border:1px solid #E2E8F0; border-radius:10px; padding:11px 13px; font-size:12px; }
  .panel h4 { font-size:10px; text-transform:uppercase; letter-spacing:.6px; color:#607D8B; margin-bottom:7px; }
  .panel .line { display:flex; justify-content:space-between; gap:8px; padding:2px 0; }
  .panel .line b { color:#0A1628; font-weight:600; text-align:right; }
  .panel .k { color:#607D8B; }
  .vatno { font-family:monospace; font-size:13px; font-weight:700; color:#0D3B6E; letter-spacing:1px; }
  table.items { width:100%; border-collapse:collapse; margin-top:16px; font-size:12px; }
  table.items thead th { background:#0D3B6E; color:#fff; font-weight:600; padding:8px 7px; text-align:left; font-size:11px; }
  table.items thead th .a { display:block; font-family:'Cairo',sans-serif; font-weight:600; opacity:.85; font-size:10px; }
  table.items td { padding:8px 7px; border-bottom:1px solid #E2E8F0; }
  table.items td.c { text-align:center; } table.items td.r { text-align:right; font-variant-numeric:tabular-nums; }
  table.items tr.disc td { color:#B91C1C; font-weight:600; }
  .bottom { display:flex; gap:16px; margin-top:18px; align-items:flex-start; }
  .qr-box { flex:0 0 auto; text-align:center; }
  .qr-box #qr { width:132px; height:132px; padding:8px; border:1px solid #E2E8F0; border-radius:10px; background:#fff; }
  .qr-box #qr img, .qr-box #qr canvas { display:block; }
  .qr-cap { font-size:9px; color:#607D8B; margin-top:5px; max-width:150px; line-height:1.4; }
  .totals { flex:1; }
  .totals .t { display:flex; justify-content:space-between; padding:7px 12px; font-size:13px; border-bottom:1px solid #E2E8F0; }
  .totals .t .lbl .a { font-family:'Cairo',sans-serif; color:#607D8B; font-size:11px; margin-left:6px; }
  .totals .grand { background:#0D3B6E; color:#fff; border-radius:0 0 8px 8px; font-size:16px; font-weight:700; border:none; }
  .totals .grand .a { font-family:'Cairo',sans-serif; font-weight:700; }
  .totals .head { background:#F0F6FF; border-radius:8px 8px 0 0; font-weight:700; color:#0D3B6E; }
  .foot { margin-top:28px; padding-top:12px; border-top:1px solid #E2E8F0; font-size:10.5px; color:#607D8B; text-align:center; line-height:1.7; }
  .print-bar { position:fixed; top:0; left:0; right:0; background:#0D3B6E; color:#fff; padding:11px; text-align:center; z-index:99; font-family:'DM Sans',sans-serif; font-size:14px; }
  .print-bar button { background:#C9A84C; color:#0A1628; border:none; padding:9px 22px; border-radius:8px; font-weight:700; cursor:pointer; font-size:14px; margin:0 6px; }
  .print-bar button.ghost { background:rgba(255,255,255,.15); color:#fff; }
  @media print { .print-bar { display:none; } body { background:#fff; } .sheet { margin:0; } }
</style></head><body>
  <div class="print-bar">
    Tax invoice ready.
    <button onclick="window.print()">⬇ Save as PDF / Print</button>
    <button class="ghost" onclick="window.close()">Close</button>
  </div>
  <div class="sheet">
    <div class="top">
      <div>
        <div class="brand">SA'DA <span>H₂O</span></div>
        <div class="sub">Water Purifiers · The Art of Purity</div>
      </div>
      <div class="brand-ar">${esc(sellerNameAr || 'سعدا لتنقية المياه')}</div>
    </div>

    <div class="doc-title">
      <div class="en">Simplified Tax Invoice</div>
      <div class="ar">فاتورة ضريبية مبسطة</div>
    </div>

    ${vatMissing ? `<div class="warn">⚠ Seller VAT registration number is not set — this invoice is NOT ZATCA-compliant until it is configured in Tax / Company info.</div>` : ''}

    <div class="panels">
      <div class="panel">
        <h4>Seller / البائع</h4>
        <div class="line"><span class="k">Name</span><b>${esc(sellerNameEn)}</b></div>
        ${sellerNameAr ? `<div class="line"><span class="k">الاسم</span><b class="ar">${esc(sellerNameAr)}</b></div>` : ''}
        <div class="line"><span class="k">VAT No. / الرقم الضريبي</span><b class="vatno">${esc(vatNumber || '— not set —')}</b></div>
        ${crNumber ? `<div class="line"><span class="k">CR No. / السجل التجاري</span><b>${esc(crNumber)}</b></div>` : ''}
        ${(addressEn || sellerCity) ? `<div class="line"><span class="k">Address</span><b>${esc(addressEn || sellerCity)}</b></div>` : ''}
        ${sellerPhone ? `<div class="line"><span class="k">Phone</span><b>${esc(sellerPhone)}</b></div>` : ''}
      </div>
      <div class="panel">
        <h4>Invoice / الفاتورة</h4>
        <div class="line"><span class="k">Invoice No. / رقم الفاتورة</span><b>${esc(d.invoiceNumber || '—')}</b></div>
        <div class="line"><span class="k">Issue Date / تاريخ الإصدار</span><b>${esc(fmtDateTime(d.issuedAt))}</b></div>
        ${d.reference ? `<div class="line"><span class="k">Booking Ref.</span><b>${esc(d.reference)}</b></div>` : ''}
        ${methodLabel ? `<div class="line"><span class="k">Payment / الدفع</span><b style="text-transform:capitalize;">${esc(methodLabel)}</b></div>` : ''}
        <h4 style="margin-top:10px;">Buyer / المشتري</h4>
        <div class="line"><span class="k">Name / الاسم</span><b>${esc(c.name || '—')}</b></div>
        ${c.phone ? `<div class="line"><span class="k">Phone / الهاتف</span><b>${esc(c.phone)}</b></div>` : ''}
        ${c.address ? `<div class="line"><span class="k">Address</span><b>${esc(c.address)}</b></div>` : ''}
      </div>
    </div>

    <table class="items">
      <thead><tr>
        <th>#</th>
        <th>Description<span class="a">الوصف</span></th>
        <th>Qty<span class="a">الكمية</span></th>
        <th class="r">Unit (excl.)<span class="a">سعر الوحدة</span></th>
        <th class="r">Taxable<span class="a">الخاضع للضريبة</span></th>
        <th class="r">VAT 15%<span class="a">الضريبة</span></th>
        <th class="r">Total<span class="a">الإجمالي</span></th>
      </tr></thead>
      <tbody>${rows}${discountRow}</tbody>
    </table>

    <div class="bottom">
      <div class="qr-box">
        <div id="qr"></div>
        <div class="qr-cap">Scan to verify · ZATCA QR<br><span class="ar">رمز الاستجابة السريعة للتحقق</span></div>
      </div>
      <div class="totals">
        <div class="t head"><span class="lbl">Summary <span class="a">الملخص</span></span><span></span></div>
        <div class="t"><span class="lbl">Total (excl. VAT) <span class="a">الإجمالي الخاضع للضريبة</span></span><b>SAR ${money(totalNet)}</b></div>
        <div class="t"><span class="lbl">VAT 15% <span class="a">ضريبة القيمة المضافة</span></span><b>SAR ${money(totalVat)}</b></div>
        <div class="t grand"><span class="lbl">Total Due <span class="a">الإجمالي المستحق</span></span><span>SAR ${money(grandTotal)}</span></div>
      </div>
    </div>

    <div class="foot">
      This is a simplified tax invoice issued under the VAT regulations of the Kingdom of Saudi Arabia (ZATCA).<br>
      <span class="ar">فاتورة ضريبية مبسطة صادرة وفقاً لأنظمة ضريبة القيمة المضافة في المملكة العربية السعودية</span><br>
      SA'DA H₂O Water Purifiers · 920022569 · Thank you for choosing The Art of Purity.
    </div>
  </div>

  <script>
    (function () {
      var payload = ${JSON.stringify(qrPayload)};
      function render() {
        try {
          new QRCode(document.getElementById('qr'), {
            text: payload, width: 116, height: 116,
            correctLevel: QRCode.CorrectLevel.M
          });
        } catch (e) {
          document.getElementById('qr').textContent = 'QR unavailable';
        }
      }
      if (typeof QRCode !== 'undefined') { render(); return; }
      var t = setInterval(function () {
        if (typeof QRCode !== 'undefined') { clearInterval(t); render(); }
      }, 60);
      setTimeout(function () { clearInterval(t); }, 4000);
    })();
  <\/script>
</body></html>`;
  }

  // `win`: optional window the caller already opened inside the click handler
  // (needed when the invoice is only ready after an async save).
  function open(data, win) {
    const w = (win && !win.closed) ? win : global.open('', '_blank');
    if (!w) { global.alert('Please allow pop-ups to view the invoice.'); return; }
    w.document.open();
    w.document.write(html(data));
    w.document.close();
  }

  global.SADAInvoice = { open, html, buildQrPayload };
})(window);
