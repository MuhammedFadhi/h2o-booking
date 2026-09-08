/**
 * SA'DA H2O — Inspection Report module
 *
 * Vanilla ES2020. Depends on:
 *   window.db          → Supabase JS v2 client (from shared/supabase.js)
 *   window.SignaturePad → https://cdn.jsdelivr.net/npm/signature_pad@4.2.0/dist/signature_pad.umd.min.js
 *
 * Public API on SADA.InspectionReport:
 *   openForm(bookingId, { installerId, installerName, installerPhone, onSaved })
 *   openView(reportId, { canPrint })
 *   exportPDF(reportId)
 *   list({ from, to, status, installerId })
 *   listByInstaller(id) / listByBooking(id) / listByCustomerPhone(phone)
 *   rowHTML(report)  — admin/customer list row helper
 *   close()
 */
window.SADA = window.SADA || {};

SADA.InspectionReport = (function () {
  'use strict';

  const TABLE = 'inspection_reports';

  const CHECKLIST = [
    { key: 'water_quality', en: 'Overall Water Quality (Taste / Odor)', ar: 'جودة الماء (الطعم والرائحة)' },
    { key: 'faucet',        en: 'Faucet & Fittings',                    ar: 'الحنفية والوصلات' },
    { key: 'tank',          en: 'Pressure / Storage Tank',              ar: 'خزان الضغط' },
    { key: 'pump',          en: 'Booster Pump',                         ar: 'مضخة الضغط' },
    { key: 's1',            en: 'Stage 1 — PP Sediment Filter (5μ)',    ar: 'المرحلة 1 — فلتر الرواسب' },
    { key: 's2',            en: 'Stage 2 — GAC Pre-Carbon Filter',      ar: 'المرحلة 2 — الكربون الحبيبي' },
    { key: 's3',            en: 'Stage 3 — CTO Carbon Block Filter',    ar: 'المرحلة 3 — الكربون المضغوط' },
    { key: 's4',            en: 'Stage 4 — RO Membrane',                ar: 'المرحلة 4 — الغشاء' },
    { key: 's5',            en: 'Stage 5 — T33 Post-Carbon Filter',     ar: 'المرحلة 5 — الكربون النهائي' },
    { key: 's6',            en: 'Stage 6 — Alkaline Filter',            ar: 'المرحلة 6 — القلوي' },
    { key: 's7',            en: 'Stage 7 — Mineral Filter',             ar: 'المرحلة 7 — المعادن' },
    { key: 'valve',         en: 'Auto Shut-off / Check Valve',          ar: 'صمام الإغلاق التلقائي' },
    { key: 'tubing',        en: 'Tubing & Connections (leak check)',    ar: 'الأنابيب والوصلات' },
    { key: 'overall',       en: 'Overall RO Unit',                      ar: 'الحالة العامة للجهاز' },
  ];

  const VISIT_TYPES = [
    { value: 'installation',  label: 'Installation' },
    { value: 'service',       label: 'Service Visit' },
    { value: 'filter_change', label: 'Filter Change' },
    { value: 'other',         label: 'Other' },
  ];

  const LOGO_CANDIDATES = ['/assets/SADA_h2o_logo.png', '../assets/SADA_h2o_logo.png', 'assets/SADA_h2o_logo.png'];

  // ------------------------------------------------------------- helpers
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  const fmtDate = (v) => {
    if (!v) return '';
    const d = typeof v === 'string' && v.length === 10 ? new Date(v + 'T00:00:00') : new Date(v);
    if (isNaN(d)) return String(v);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return `${dd}/${mm}/${d.getFullYear()}`;
  };
  const isoToday = () => new Date().toISOString().slice(0, 10);

  const rejection = (feed, prod) => {
    const f = Number(feed), p = Number(prod);
    if (!f || !isFinite(f) || !isFinite(p)) return null;
    return Math.max(0, ((f - p) / f) * 100);
  };

  function logoImg() {
    const src = LOGO_CANDIDATES[0];
    return `<img class="sada-ir__logo" src="${src}" alt="SA'DA H2O"
      onerror="var i=parseInt(this.dataset.i||'0',10)+1;var l=${JSON.stringify(LOGO_CANDIDATES)};this.dataset.i=i;if(i<l.length){this.src=l[i]}else{this.style.display='none'}">`;
  }

  // ------------------------------------------------------------- data layer
  async function loadBooking(bookingId) {
    if (!bookingId) return null;
    const { data, error } = await window.db.from('bookings').select('*').eq('id', bookingId).maybeSingle();
    if (error) { console.error('[IR] loadBooking', error); return null; }
    return data;
  }
  async function loadReport(id) {
    const { data, error } = await window.db.from(TABLE).select('*').eq('id', id).maybeSingle();
    if (error) { console.error('[IR] loadReport', error); return null; }
    return data;
  }
  async function loadReportForBooking(bookingId) {
    const { data, error } = await window.db.from(TABLE).select('*')
      .eq('booking_id', bookingId).order('created_at', { ascending: false }).limit(1);
    if (error) { console.error('[IR] loadReportForBooking', error); return null; }
    return data?.[0] ?? null;
  }
  async function saveReport(payload) {
    const row = { ...payload };
    delete row.created_at; delete row.updated_at;
    if (row.status === 'submitted' && !row.submitted_at) row.submitted_at = new Date().toISOString();
    const q = row.id
      ? window.db.from(TABLE).update(row).eq('id', row.id).select().single()
      : window.db.from(TABLE).insert(row).select().single();
    const { data, error } = await q;
    if (error) throw error;
    return data;
  }
  async function list({ from, to, status, installerId } = {}) {
    let q = window.db.from(TABLE).select('*');
    if (from)        q = q.gte('visit_date', from);
    if (to)          q = q.lte('visit_date', to);
    if (status)      q = q.eq('status', status);
    if (installerId) q = q.eq('installer_id', installerId);
    q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }
  async function listByInstaller(id) { return list({ installerId: id }); }
  async function listByBooking(bookingId) {
    const { data, error } = await window.db.from(TABLE).select('*')
      .eq('booking_id', bookingId).order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function listByCustomerPhone(phone) {
    const { data, error } = await window.db.from(TABLE).select('*')
      .eq('customer_phone', phone).eq('status', 'submitted')
      .order('submitted_at', { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // ------------------------------------------------------------- modal shell
  let _root = null;
  function openModal(html) {
    closeModal();
    _root = document.createElement('div');
    _root.className = 'sada-ir-overlay';
    _root.innerHTML = html;
    _root.addEventListener('click', (e) => { if (e.target === _root) closeModal(); });
    document.body.appendChild(_root);
    document.body.style.overflow = 'hidden';
    return _root;
  }
  function closeModal() {
    if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
    _root = null;
    document.body.style.overflow = '';
  }

  // ------------------------------------------------------------- letterhead
  function brandHead() {
    return `
      <div class="sada-ir__head">
        <div class="sada-ir__title">
          <h1>Domestic RO System Inspection Report</h1>
          <p>تقرير فحص نظام التناضح العكسي المنزلي</p>
        </div>
        ${logoImg()}
      </div>`;
  }
  function brandFoot() {
    return `
      <div class="sada-ir__foot">
        <div class="phone">920022569</div>
        <div class="web">WWW.SADAWATER.COM</div>
      </div>`;
  }

  // ------------------------------------------------------------- templates
  function tplChecklistHead() {
    return `
      <div class="sada-ir__check-head">
        <div>Component / المكون</div>
        <div>Good</div><div>Normal</div><div>Poor</div>
        <div>Other Remarks / ملاحظات</div>
      </div>`;
  }
  function tplChecklistRow(item, current, remark, readonly = false) {
    const disabled = readonly ? 'disabled' : '';
    const opts = ['good','normal','poor'].map(v => `
      <div class="opt">
        <input type="radio" class="sada-ir__radio"
               name="cond_${item.key}" data-val="${v}" value="${v}"
               ${current === v ? 'checked' : ''} ${disabled}>
      </div>`).join('');
    return `
      <div class="sada-ir__check-row" data-key="${item.key}">
        <div class="name">
          <span class="en">${esc(item.en)}</span>
          <span class="ar">${esc(item.ar)}</span>
        </div>
        ${opts}
        <div class="remark">
          <input type="text" name="remark_${item.key}" value="${esc(remark || '')}" placeholder="—" ${disabled}>
        </div>
      </div>`;
  }

  function tplForm(booking, existing, ctx) {
    const b = booking || {};
    const r = existing || {};
    const comp = r.components || {};
    const remarks = r.component_remarks || {};

    const clientRows = `
      <div class="sada-ir__grid">
        <div class="sada-ir__field">
          <label>Customer Name <span dir="rtl">اسم العميل</span></label>
          <input name="customer_name" value="${esc(r.customer_name || b.customer_name || '')}" ${b.customer_name ? 'readonly' : ''}>
        </div>
        <div class="sada-ir__field">
          <label>Contact Number <span dir="rtl">رقم الجوال</span></label>
          <input name="customer_phone" value="${esc(r.customer_phone || b.customer_phone || '')}" ${b.customer_phone ? 'readonly' : ''}>
        </div>
        <div class="sada-ir__field">
          <label>Date <span dir="rtl">التاريخ</span></label>
          <input type="date" name="visit_date" value="${esc(r.visit_date || isoToday())}">
        </div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field sada-ir__col-span-2">
          <label>Address / Location <span dir="rtl">العنوان / الموقع</span></label>
          <input name="address" value="${esc(r.address || b.location_address || '')}">
        </div>
        <div class="sada-ir__field">
          <label>RO Model / Serial No. <span dir="rtl">الموديل / الرقم التسلسلي</span></label>
          <input name="model_serial" value="${esc([r.ro_model, r.serial_no || ctx.scannedSerial].filter(Boolean).join(' / '))}">
        </div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field">
          <label>Technician Name <span dir="rtl">اسم الفني</span></label>
          <input name="tech_name" value="${esc(r.tech_name || ctx.installerName || '')}">
        </div>
        <div class="sada-ir__field">
          <label>Technician Contact <span dir="rtl">رقم الفني</span></label>
          <input name="tech_contact" value="${esc(r.tech_contact || ctx.installerPhone || '')}">
        </div>
        <div class="sada-ir__field">
          <label>Visit Type <span dir="rtl">نوع الزيارة</span></label>
          <select name="visit_type">
            ${VISIT_TYPES.map(v => `<option value="${v.value}" ${r.visit_type === v.value ? 'selected' : ''}>${v.label}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field">
          <label>Next Service In <span dir="rtl">الخدمة القادمة بعد</span></label>
          <select name="service_interval" data-role="service-interval">
            <option value="3">3 months / 3 أشهر</option>
            <option value="6" selected>6 months / 6 أشهر</option>
            <option value="12">12 months / 12 شهر</option>
          </select>
        </div>
        <div class="sada-ir__field">
          <label>Next Service Due <span dir="rtl">تاريخ الخدمة القادمة</span></label>
          <input type="date" name="next_service_due" data-role="next-service" value="${esc(r.next_service_due || '')}">
        </div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field">
          <label>Booking Ref <span dir="rtl">رقم الحجز</span></label>
          <input value="${esc(b.booking_reference || String(b.id || '').slice(0, 12))}" readonly>
        </div>
      </div>`;

    const water = `
      <div class="sada-ir__water">
        <div class="sada-ir__stat">
          <label>Feed TDS</label>
          <span class="ar">TDS الماء الداخل</span>
          <input type="number" name="feed_tds" min="0" max="5000" step="1" inputmode="numeric" value="${esc(r.feed_tds ?? '')}">
          <div class="unit">mg/L</div>
        </div>
        <div class="sada-ir__stat">
          <label>Product TDS</label>
          <span class="ar">TDS الماء المنتج</span>
          <input type="number" name="product_tds" min="0" max="5000" step="1" inputmode="numeric" value="${esc(r.product_tds ?? '')}">
          <div class="unit">mg/L</div>
        </div>
      </div>`;

    const checklist = `
      ${tplChecklistHead()}
      <div class="sada-ir__checklist">
        ${CHECKLIST.map(i => tplChecklistRow(i, comp[i.key], remarks[i.key])).join('')}
      </div>`;

    const sigs = `
      <div class="sada-ir__sigs">
        <div class="sada-ir__sig">
          <div class="sada-ir__sig-head"><span>Inspected by (Technician)</span><span dir="rtl">الفني</span></div>
          <div class="sada-ir__sig-body">
            <input name="sig_tech_name" placeholder="Name / الاسم" value="${esc(r.tech_name || ctx.installerName || '')}">
            <canvas class="sada-ir__pad" data-pad="tech"></canvas>
            <div class="sada-ir__pad-actions">
              <span>Sign above / وقّع أعلاه</span>
              <button type="button" data-clear="tech">Clear</button>
            </div>
          </div>
        </div>
        <div class="sada-ir__sig">
          <div class="sada-ir__sig-head"><span>Acknowledged by (Customer)</span><span dir="rtl">العميل</span></div>
          <div class="sada-ir__sig-body">
            <input name="customer_ack_name" placeholder="Name / الاسم" value="${esc(r.customer_ack_name || b.customer_name || '')}">
            <canvas class="sada-ir__pad" data-pad="cust"></canvas>
            <div class="sada-ir__pad-actions">
              <span>Sign above / وقّع أعلاه</span>
              <button type="button" data-clear="cust">Clear</button>
            </div>
          </div>
        </div>
      </div>`;

    return `
      <div class="sada-ir">
        <button class="sada-ir__close" aria-label="Close" data-action="close">×</button>
        ${brandHead()}
        <div class="sada-ir__body">

          <div class="sada-ir__section">
            <div class="sada-ir__section-head">
              <span>Client Details</span><span dir="rtl">بيانات العميل</span>
            </div>
            ${clientRows}
          </div>

          <div class="sada-ir__section">
            <div class="sada-ir__section-head">
              <span>Water Analysis</span><span dir="rtl">تحليل الماء</span>
            </div>
            ${water}
          </div>

          <div class="sada-ir__section">
            <div class="sada-ir__section-head">
              <span>Working Condition</span><span dir="rtl">حالة التشغيل</span>
            </div>
            ${checklist}
          </div>

          <div class="sada-ir__section">
            <div class="sada-ir__section-head">
              <span>Service / Action Taken</span><span dir="rtl">الإجراء المتخذ</span>
            </div>
            <div class="sada-ir__field" style="border-radius:0 0 8px 8px;">
              <textarea name="action_taken" rows="3" placeholder="What was inspected / replaced / adjusted…">${esc(r.action_taken || '')}</textarea>
            </div>
          </div>

          <div class="sada-ir__section">
            <div class="sada-ir__section-head sada-ir__section-head--navy">
              <span>Signatures</span><span dir="rtl">التوقيعات</span>
            </div>
            ${sigs}
          </div>

          <div class="sada-ir__section">
            <div class="sada-ir__section-head">
              <span>Remarks</span><span dir="rtl">ملاحظات</span>
            </div>
            <div class="sada-ir__field" style="border-radius:0 0 8px 8px;">
              <textarea name="remarks" rows="2" placeholder="Optional notes…">${esc(r.remarks || '')}</textarea>
            </div>
          </div>

        </div>

        ${brandFoot()}

        <div class="sada-ir__actions">
          <button class="sada-ir__btn sada-ir__btn--ghost" data-action="save-draft">Save Draft</button>
          <button class="sada-ir__btn" data-action="submit">Submit Report</button>
        </div>
      </div>`;
  }

  function tplView(booking, r) {
    const b = booking || {};
    const comp = r.components || {};
    const remarks = r.component_remarks || {};

    const clientRows = `
      <div class="sada-ir__grid">
        <div class="sada-ir__field"><label>Customer <span dir="rtl">العميل</span></label><input readonly value="${esc(r.customer_name || b.customer_name || '')}"></div>
        <div class="sada-ir__field"><label>Contact <span dir="rtl">الجوال</span></label><input readonly value="${esc(r.customer_phone || b.customer_phone || '')}"></div>
        <div class="sada-ir__field"><label>Date <span dir="rtl">التاريخ</span></label><input readonly value="${esc(fmtDate(r.visit_date))}"></div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field sada-ir__col-span-2"><label>Address <span dir="rtl">العنوان</span></label><input readonly value="${esc(r.address || b.location_address || '')}"></div>
        <div class="sada-ir__field"><label>Model / Serial <span dir="rtl">الموديل / الرقم</span></label><input readonly value="${esc([r.ro_model, r.serial_no].filter(Boolean).join(' / '))}"></div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field"><label>Technician <span dir="rtl">الفني</span></label><input readonly value="${esc(r.tech_name || '')}"></div>
        <div class="sada-ir__field"><label>Tech Contact <span dir="rtl">رقم الفني</span></label><input readonly value="${esc(r.tech_contact || '')}"></div>
        <div class="sada-ir__field"><label>Visit Type <span dir="rtl">نوع الزيارة</span></label><input readonly value="${esc(VISIT_TYPES.find(v => v.value === r.visit_type)?.label || r.visit_type || '')}"></div>
      </div>
      <div class="sada-ir__grid" style="margin-top:8px;">
        <div class="sada-ir__field"><label>Status <span dir="rtl">الحالة</span></label><input readonly value="${esc(r.status || '')}"></div>
        <div class="sada-ir__field"><label>Next Service Due <span dir="rtl">تاريخ الخدمة القادمة</span></label><input readonly value="${esc(r.next_service_due ? fmtDate(r.next_service_due) : '—')}"></div>
      </div>`;

    const water = `
      <div class="sada-ir__water">
        <div class="sada-ir__stat"><label>Feed TDS</label><span class="ar">TDS الماء الداخل</span>
          <input readonly value="${esc(r.feed_tds ?? '—')}"><div class="unit">mg/L</div></div>
        <div class="sada-ir__stat"><label>Product TDS</label><span class="ar">TDS الماء المنتج</span>
          <input readonly value="${esc(r.product_tds ?? '—')}"><div class="unit">mg/L</div></div>
      </div>`;

    const checklist = `
      ${tplChecklistHead()}
      <div class="sada-ir__checklist">
        ${CHECKLIST.map(i => tplChecklistRow(i, comp[i.key], remarks[i.key], true)).join('')}
      </div>`;

    const sigImg = (dataUrl, alt) => dataUrl
      ? `<img src="${esc(dataUrl)}" alt="${esc(alt)}" style="max-width:100%; height:100px; object-fit:contain;">`
      : `<div style="height:100px; display:grid; place-items:center; color:#94a3b8;">— not signed —</div>`;

    const sigs = `
      <div class="sada-ir__sigs">
        <div class="sada-ir__sig">
          <div class="sada-ir__sig-head"><span>Inspected by (Technician)</span><span dir="rtl">الفني</span></div>
          <div class="sada-ir__sig-body">
            <div style="margin-bottom:6px; font-weight:600; font-size:13px;">${esc(r.tech_name || '')}</div>
            ${sigImg(r.tech_signature, 'Technician signature')}
          </div>
        </div>
        <div class="sada-ir__sig">
          <div class="sada-ir__sig-head"><span>Acknowledged by (Customer)</span><span dir="rtl">العميل</span></div>
          <div class="sada-ir__sig-body">
            <div style="margin-bottom:6px; font-weight:600; font-size:13px;">${esc(r.customer_ack_name || '')}</div>
            ${sigImg(r.customer_signature, 'Customer signature')}
          </div>
        </div>
      </div>`;

    return `
      <div class="sada-ir sada-ir--view">
        <button class="sada-ir__close" aria-label="Close" data-action="close">×</button>
        ${brandHead()}
        <div class="sada-ir__body">
          <div class="sada-ir__section"><div class="sada-ir__section-head"><span>Client Details</span><span dir="rtl">بيانات العميل</span></div>${clientRows}</div>
          <div class="sada-ir__section"><div class="sada-ir__section-head"><span>Water Analysis</span><span dir="rtl">تحليل الماء</span></div>${water}</div>
          <div class="sada-ir__section"><div class="sada-ir__section-head"><span>Working Condition</span><span dir="rtl">حالة التشغيل</span></div>${checklist}</div>
          <div class="sada-ir__section"><div class="sada-ir__section-head"><span>Service / Action Taken</span><span dir="rtl">الإجراء المتخذ</span></div>
            <div class="sada-ir__field" style="border-radius:0 0 8px 8px;"><textarea readonly rows="3">${esc(r.action_taken || '')}</textarea></div></div>
          <div class="sada-ir__section"><div class="sada-ir__section-head sada-ir__section-head--navy"><span>Signatures</span><span dir="rtl">التوقيعات</span></div>${sigs}</div>
          ${r.remarks ? `<div class="sada-ir__section"><div class="sada-ir__section-head"><span>Remarks</span><span dir="rtl">ملاحظات</span></div>
            <div class="sada-ir__field" style="border-radius:0 0 8px 8px;"><textarea readonly rows="2">${esc(r.remarks)}</textarea></div></div>` : ''}
        </div>
        ${brandFoot()}
        <div class="sada-ir__actions">
          <button class="sada-ir__btn sada-ir__btn--ghost" data-action="close">Close</button>
          <button class="sada-ir__btn sada-ir__btn--navy" data-action="print">Download / Print PDF</button>
        </div>
      </div>`;
  }

  // ------------------------------------------------------------- signature pads
  function initSignaturePads(root, existing = {}) {
    if (typeof window.SignaturePad !== 'function') {
      console.warn('[IR] SignaturePad not loaded');
      return {};
    }
    const pads = {};
    $$('canvas.sada-ir__pad', root).forEach(cv => {
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      cv.width  = cv.offsetWidth  * ratio;
      cv.height = cv.offsetHeight * ratio;
      cv.getContext('2d').scale(ratio, ratio);
      const pad = new window.SignaturePad(cv, { backgroundColor: 'rgba(255,255,255,0)', penColor: '#0A1628' });
      const key = cv.dataset.pad;
      if (existing[key]) { try { pad.fromDataURL(existing[key]); } catch (_) {} }
      pads[key] = pad;
    });
    $$('[data-clear]', root).forEach(btn => {
      btn.addEventListener('click', () => pads[btn.dataset.clear]?.clear());
    });
    return pads;
  }

  // ------------------------------------------------------------- collect + save
  function collect(root, ctx, status) {
    const val = (n) => $(`[name="${n}"]`, root)?.value?.trim() || null;
    const comp = {}, remarks = {};
    CHECKLIST.forEach(({ key }) => {
      const picked = $(`input[name="cond_${key}"]:checked`, root);
      if (picked) comp[key] = picked.value;
      const remark = val(`remark_${key}`);
      if (remark) remarks[key] = remark;
    });
    const modelSerial = (val('model_serial') || '').split('/').map(s => s.trim());
    const feed_tds = val('feed_tds'); const product_tds = val('product_tds');

    return {
      id: ctx.existing?.id,
      booking_id: ctx.bookingId || null,
      installer_id: ctx.installerId || ctx.existing?.installer_id || null,
      customer_name: val('customer_name') || ctx.booking?.customer_name || null,
      customer_phone: val('customer_phone') || ctx.booking?.customer_phone || null,
      address: val('address') || ctx.booking?.location_address || null,
      city_name: ctx.booking?.city_name || null,
      visit_type: val('visit_type') || 'installation',
      visit_date: val('visit_date') || isoToday(),
      next_service_due: val('next_service_due') || null,
      ro_model: modelSerial[0] || null,
      serial_no: modelSerial[1] || null,
      tech_name: val('tech_name') || val('sig_tech_name') || null,
      tech_contact: val('tech_contact') || null,
      feed_tds: feed_tds ? parseInt(feed_tds, 10) : null,
      product_tds: product_tds ? parseInt(product_tds, 10) : null,
      components: { ...comp, __remarks: undefined },
      remarks: val('remarks'),
      action_taken: val('action_taken'),
      customer_ack_name: val('customer_ack_name'),
      tech_signature: ctx.pads?.tech && !ctx.pads.tech.isEmpty()
        ? ctx.pads.tech.toDataURL('image/png') : (ctx.existing?.tech_signature || null),
      customer_signature: ctx.pads?.cust && !ctx.pads.cust.isEmpty()
        ? ctx.pads.cust.toDataURL('image/png') : (ctx.existing?.customer_signature || null),
      status,
      submitted_at: status === 'submitted' ? new Date().toISOString() : null,
      component_remarks: Object.keys(remarks).length ? remarks : null,
    };
  }

  // ------------------------------------------------------------- form wiring
  function wireForm(root, ctx) {
    // Auto-compute "Next Service Due" = visit date + N months. Recomputes when the
    // interval or the visit date changes; leaves a manually-edited date alone until
    // the interval is touched again.
    const intervalEl = $('[data-role="service-interval"]', root);
    const nextEl = $('[data-role="next-service"]', root);
    const visitEl = $('input[name="visit_date"]', root);
    const addMonths = (iso, n) => {
      const d = new Date((iso || isoToday()) + 'T00:00:00');
      const targetMonth = d.getMonth() + Number(n);
      const t = new Date(d);
      t.setMonth(targetMonth);
      // guard month overflow (e.g. 31 Jan + 1mo): clamp to last valid day
      if (t.getDate() !== d.getDate()) t.setDate(0);
      return t.toISOString().slice(0, 10);
    };
    const recompute = () => {
      if (!nextEl || !intervalEl) return;
      nextEl.value = addMonths(visitEl?.value, intervalEl.value);
    };
    // Only auto-fill if the report doesn't already carry a saved date.
    if (nextEl && !nextEl.value) recompute();
    intervalEl?.addEventListener('change', recompute);
    visitEl?.addEventListener('change', () => { if (intervalEl) recompute(); });

    root.addEventListener('click', async (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      if (action === 'close') return closeModal();
      if (action === 'save-draft' || action === 'submit') {
        const isSubmit = action === 'submit';
        if (isSubmit) {
          if (!ctx.pads?.tech || ctx.pads.tech.isEmpty()) { alert('Technician signature is required.'); return; }
          if (!ctx.pads?.cust || ctx.pads.cust.isEmpty()) { alert('Customer signature is required.'); return; }
          const missing = CHECKLIST.filter(i => !$(`input[name="cond_${i.key}"]:checked`, root)).length;
          if (missing && !confirm(`${missing} checklist item(s) not marked. Submit anyway?`)) return;
        }
        e.target.disabled = true;
        try {
          const row = collect(root, ctx, isSubmit ? 'submitted' : 'draft');
          // Merge component_remarks into components as sibling map (single JSONB column)
          if (row.component_remarks) { row.components = { ...row.components, __remarks: row.component_remarks }; }
          delete row.component_remarks;
          const saved = await saveReport(row);
          if (isSubmit) {
            // Fire-and-forget SMS (server checks sms_settings.inspection_report toggle)
            fetch('/api/notify-report', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reportId: saved.id })
            }).catch(err => console.warn('[IR] notify-report:', err));
          }
          ctx.onSaved?.(saved);
          if (isSubmit) closeModal();
          else e.target.disabled = false;
        } catch (err) {
          console.error('[IR] save failed', err);
          alert('Save failed: ' + (err.message || err));
          e.target.disabled = false;
        }
      }
    });
  }

  // ------------------------------------------------------------- public
  async function openForm(bookingId, opts = {}) {
    if (!window.db) { alert('Database not ready'); return; }
    if (!window.SignaturePad) { alert('Signature library failed to load. Refresh and try again.'); return; }
    const [booking, existing] = await Promise.all([
      loadBooking(bookingId),
      bookingId ? loadReportForBooking(bookingId) : null,
    ]);
    if (!booking) { alert('Booking not found'); return; }
    if (existing && existing.status === 'submitted') {
      return openView(existing.id, { canPrint: true });
    }
    // Unpack embedded component_remarks
    if (existing?.components?.__remarks) {
      existing.component_remarks = existing.components.__remarks;
      delete existing.components.__remarks;
    }
    const ctx = {
      bookingId, booking,
      installerId: opts.installerId,
      installerName: opts.installerName,
      installerPhone: opts.installerPhone,
      scannedSerial: opts.scannedSerial || '',
      existing,
      onSaved: opts.onSaved,
    };
    const root = openModal(tplForm(booking, existing, ctx));
    const el = root.firstElementChild;
    ctx.pads = initSignaturePads(el, {
      tech: existing?.tech_signature,
      cust: existing?.customer_signature,
    });
    wireForm(el, ctx);
  }

  async function openView(reportId, opts = {}) {
    const r = await loadReport(reportId);
    if (!r) { alert('Report not found'); return; }
    if (r?.components?.__remarks) {
      r.component_remarks = r.components.__remarks;
      delete r.components.__remarks;
    }
    const booking = r.booking_id ? await loadBooking(r.booking_id) : null;
    const root = openModal(tplView(booking, r));
    root.addEventListener('click', (e) => {
      const a = e.target?.dataset?.action;
      if (a === 'close') closeModal();
      if (a === 'print' && opts.canPrint !== false) window.print();
    });
  }

  async function exportPDF(reportId) {
    await openView(reportId, { canPrint: true });
    setTimeout(() => window.print(), 400);
  }

  // ------------------------------------------------------------- list row helper
  function rowHTML(report) {
    return `
      <div class="sada-ir-list__item" data-report-id="${esc(report.id)}">
        <div>
          <div class="sada-ir-list__title">${esc(report.customer_name || '—')} · ${esc(report.city_name || '')}</div>
          <div class="sada-ir-list__meta">${fmtDate(report.visit_date || report.submitted_at || report.created_at)} · ${esc(report.customer_phone || '')} · ${esc(VISIT_TYPES.find(v => v.value === report.visit_type)?.label || report.visit_type || '')}</div>
        </div>
        <div style="text-align:right;">
          <div><span class="sada-ir-badge sada-ir-badge--${esc(report.status)}">${esc(report.status)}</span></div>
        </div>
      </div>`;
  }

  return {
    CHECKLIST, VISIT_TYPES,
    openForm, openView, exportPDF,
    list, listByInstaller, listByBooking, listByCustomerPhone,
    rowHTML, close: closeModal,
    // utilities
    rejection, fmtDate,
    // test/preview hooks — safe to expose, pure render, no side effects
    _tplView: tplView, _tplForm: tplForm,
  };
})();
