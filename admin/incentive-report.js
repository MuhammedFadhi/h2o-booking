// ============================================================
// admin/incentive-report.js — Incentive Report panel (admin only).
// Same layout as the Sales Report: filters, tiles, chart by day, details,
// PDF. Reads incentive_earnings (migrations/v116_incentive_auto_earnings.sql),
// which fills itself when a booking is completed.
// Uses the dashboard's globals: dbAdmin, showToast, localDateISO,
// salesReportChartSVG.
// ============================================================
(function () {
  const GROUPS = [['sales', 'Sales Team'], ['installer', 'Installers']];
  const ROLES = { sales: 'Sales agent', installer: 'Installer' };
  const PALETTE = [
    ['#DBEAFE', '#1E40AF'], ['#DCFCE7', '#166534'], ['#FEF3C7', '#92400E'], ['#FCE7F3', '#9D174D'],
    ['#EDE9FE', '#5B21B6'], ['#CFFAFE', '#155E75'], ['#FFE4E6', '#9F1239'], ['#E0E7FF', '#3730A3']
  ];
  const R = { rows: [] };

  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dmy = d => d ? String(d).split('-').reverse().join('/') : '—';
  const idLabel = n => n == null ? '—' : `INC-${String(n).padStart(4, '0')}`;
  const personKey = r => `${r.person_type}:${r.person_id}`;
  const hashOf = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const chip = text => {
    const [bg, fg] = PALETTE[hashOf(text) % PALETTE.length];
    return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:3px 10px;margin:2px;font-size:12px;font-weight:600;white-space:nowrap;">${esc(text)}</span>`;
  };
  const label = t => `<label style="display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin-bottom:4px;">${t}</label>`;
  const sum = list => list.reduce((s, r) => s + Number(r.amount || 0), 0);

  // From/To start empty, which shows all time; picking dates narrows it.
  function shell() {
    $('panel-increport').innerHTML = `
      <div class="card" style="margin-bottom:16px;overflow:visible;">
        <div class="card-header">
          <span class="card-title">Filters</span>
          <button class="btn btn-primary btn-sm" onclick="irPdf()" style="white-space:nowrap;">⬇ Download PDF</button>
        </div>
        <div style="padding:20px 24px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;">
          <div>${label('From')}<input type="date" id="ir-from" class="form-input" onchange="irFetch()"></div>
          <div>${label('To')}<input type="date" id="ir-to" class="form-input" onchange="irFetch()"></div>
          <div>${label('Person')}<select id="ir-person" class="form-input" onchange="irRender()"><option value="">All people</option></select></div>
          <div>${label('Product')}<select id="ir-product" class="form-input" onchange="irRender()"><option value="">All products</option></select></div>
          <div>${label('Group')}<select id="ir-group" class="form-input" onchange="irRender()"><option value="">All groups</option>
            ${GROUPS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
          <div>${label('Status')}<select id="ir-status" class="form-input" onchange="irRender()"><option value="">All</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option></select></div>
        </div>
      </div>
      <div id="ir-body"></div>`;
  }

  async function loadIncentiveReport() {
    if (!$('ir-from')) shell();
    await fetchRows();
  }

  async function fetchRows() {
    const body = $('ir-body');
    body.innerHTML = '<div class="loading"><div class="spinner"></div> Loading incentives...</div>';
    const from = $('ir-from').value, to = $('ir-to').value;
    // Read in pages of 1000 rows (the most the server returns per request).
    const data = [];
    let error = null;
    for (let start = 0; ; start += 1000) {
      let q = dbAdmin.from('incentive_earnings')
        .select('*, bookings(booking_reference, customer_name), incentive_payouts(payout_no)')
        .order('earned_on', { ascending: false }).order('id').range(start, start + 999);
      if (from) q = q.gte('earned_on', from);
      if (to) q = q.lte('earned_on', to);
      const res = await q;
      if (res.error) { error = res.error; break; }
      data.push(...(res.data || []));
      if (!res.data || res.data.length < 1000) break;
    }
    if (error) {
      body.innerHTML = `<div class="card"><div class="empty-state">Could not load incentives: ${esc(error.message)}
        <div style="font-size:12px;color:var(--muted);margin-top:6px;">If this is a new setup, run migrations/v116_incentive_auto_earnings.sql and v117_incentive_payouts.sql first.</div></div></div>`;
      return;
    }
    R.rows = data || [];
    fillOptions();
    render();
  }

  // Keep a chosen person/product only while it still appears in this date range.
  function fillOptions() {
    const fill = (id, all, pairs) => {
      const el = $(id), keep = el.value;
      el.innerHTML = `<option value="">${all}</option>` + pairs.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
      if (pairs.some(([v]) => v === keep)) el.value = keep;
    };
    const people = new Map();
    R.rows.forEach(r => people.set(personKey(r), r.person_name));
    fill('ir-person', 'All people', [...people].sort((a, b) => String(a[1]).localeCompare(String(b[1]))));
    fill('ir-product', 'All products', [...new Set(R.rows.map(r => r.product_name))].sort().map(p => [p, p]));
  }

  function filtered() {
    const person = $('ir-person').value, product = $('ir-product').value, group = $('ir-group').value;
    const status = $('ir-status').value;
    return R.rows.filter(r =>
      (!status || (status === 'paid') === !!r.payout_id) &&
      (!person || personKey(r) === person) &&
      (!product || r.product_name === product) &&
      (!group || r.person_type === group));
  }

  function kpiValues(rows) {
    return {
      total: sum(rows),
      paid: sum(rows.filter(r => r.payout_id)),
      due: sum(rows.filter(r => !r.payout_id)),
      bookings: new Set(rows.map(r => r.booking_id)).size,
      people: new Set(rows.map(personKey)).size
    };
  }

  function dayRows(rows) {
    const byDay = {};
    rows.forEach(r => { byDay[r.earned_on] = (byDay[r.earned_on] || 0) + Number(r.amount || 0); });
    // No dates picked: run from the first to the last day with incentives.
    const keys = Object.keys(byDay).sort();
    const from = $('ir-from').value || keys[0], to = $('ir-to').value || keys[keys.length - 1];
    const days = [];
    if (from && to) {
      const end = new Date(to + 'T00:00:00');
      for (let d = new Date(from + 'T00:00:00'); d <= end; d.setDate(d.getDate() + 1)) {
        const key = localDateISO(d);
        days.push({ date: key, total: Math.round(byDay[key] || 0) });
      }
    } else {
      Object.keys(byDay).sort().forEach(k => days.push({ date: k, total: Math.round(byDay[k]) }));
    }
    return days;
  }

  function byPerson(rows) {
    const map = new Map();
    rows.forEach(r => {
      const k = personKey(r);
      if (!map.has(k)) map.set(k, { name: r.person_name, type: r.person_type, bookings: new Set(), units: 0, amount: 0, paid: 0 });
      const p = map.get(k);
      if (r.booking_id) p.bookings.add(r.booking_id);
      if (!r.adjustment) p.units += Number(r.qty || 0);
      p.amount += Number(r.amount || 0);
      if (r.payout_id) p.paid += Number(r.amount || 0);
    });
    return [...map.values()].sort((a, b) => b.amount - a.amount);
  }

  const groupLabel = t => (GROUPS.find(g => g[0] === t) || [, t])[1];

  function personTable(rows, forPrint) {
    const list = byPerson(rows);
    if (!list.length) return '<div class="empty-state">No incentives in this range.</div>';
    return `<table style="width:100%;"><thead><tr><th>Person</th><th>Group</th><th>Bookings</th><th>Units</th><th>Earned</th><th>Paid</th><th>Balance Due</th></tr></thead><tbody>
      ${list.map(p => `<tr><td>${forPrint ? esc(p.name) : chip(p.name)}</td><td>${esc(groupLabel(p.type))}</td><td>${p.bookings.size}</td><td>${p.units}</td><td style="white-space:nowrap;">SAR ${money(p.amount)}</td><td style="white-space:nowrap;">SAR ${money(p.paid)}</td><td style="white-space:nowrap;font-weight:700;">SAR ${money(p.amount - p.paid)}</td></tr>`).join('')}
    </tbody></table>`;
  }

  function detailTable(rows, forPrint) {
    if (!rows.length) return '<div class="empty-state">No incentives in this range.</div>';
    return `<table style="width:100%;"><thead><tr><th>Date</th><th>Booking</th><th>Customer</th><th>Person</th><th>Role</th><th>Product</th><th>Qty</th><th>Per Unit</th><th>Amount</th><th>Rule</th><th>Status</th></tr></thead><tbody>
      ${rows.map(r => `<tr>
        <td style="white-space:nowrap;">${dmy(r.earned_on)}</td>
        <td style="white-space:nowrap;">${esc(r.bookings?.booking_reference || '—')}</td>
        <td>${esc(r.bookings?.customer_name || '—')}</td>
        <td>${forPrint ? esc(r.person_name) : chip(r.person_name)}</td>
        <td>${esc(ROLES[r.role] || r.role)}</td>
        <td>${forPrint ? esc(r.product_name) : chip(r.product_name)}${r.adjustment ? ' <span style="font-size:11px;color:var(--muted);">(correction)</span>' : ''}</td>
        <td>${r.qty}</td>
        <td style="white-space:nowrap;">SAR ${money(r.rate)}</td>
        <td style="white-space:nowrap;font-weight:700;">SAR ${money(r.amount)}</td>
        <td style="white-space:nowrap;">${idLabel(r.batch_no)}</td>
        <td style="white-space:nowrap;">${r.payout_id ? `Paid · PAY-${String(r.incentive_payouts?.payout_no ?? '').padStart(4, '0')}` : '<span style="color:#D97706;font-weight:600;">Unpaid</span>'}</td>
      </tr>`).join('')}
    </tbody></table>`;
  }

  function render() {
    const rows = filtered();
    const k = kpiValues(rows);
    // Own gradient id: the Sales Report's chart uses srBarGrad too, and when its
    // panel is hidden the browser draws bars that point at it as invisible.
    const svg = rows.length ? salesReportChartSVG(dayRows(rows)).svg.replace(/srBarGrad/g, 'irBarGrad')
      : '<div class="empty-state">No incentives in this range.</div>';
    const kpi = (text, value, color) => `
      <div class="stat-card" style="border-top:3px solid ${color};">
        <div class="stat-value" style="color:${color};">${value}</div>
        <div class="stat-label">${text}</div>
      </div>`;
    const section = (title, html) => `
      <div class="card" style="padding:20px;margin-bottom:20px;">
        <div style="font-size:13px;font-weight:700;color:var(--text);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px;">${title}</div>
        <div style="overflow-x:auto;">${html}</div>
      </div>`;
    $('ir-body').innerHTML = `
      <div class="stat-grid stat-grid-5" style="margin-bottom:20px;">
        ${kpi('Earned', `SAR ${money(k.total)}`, '#0F766E')}
        ${kpi('Paid', `SAR ${money(k.paid)}`, '#2563EB')}
        ${kpi('Balance Due', `SAR ${money(k.due)}`, '#D97706')}
        ${kpi('Bookings', k.bookings, '#16A34A')}
        ${kpi('People', k.people, '#94A3B8')}
      </div>
      ${section('Incentives by day (SAR)', svg)}
      ${section('Totals by person', personTable(rows))}
      ${section('Incentive details', detailTable(rows))}`;
  }

  function pdf() {
    const rows = filtered();
    const k = kpiValues(rows);
    const from = $('ir-from').value, to = $('ir-to').value;
    const pick = id => $(id).selectedOptions[0]?.textContent || '';
    const info = [
      ['Reporting period', from && to ? `${dmy(from)} – ${dmy(to)}` : 'All time'],
      ['Person', pick('ir-person')], ['Product', pick('ir-product')], ['Group', pick('ir-group')], ['Status', pick('ir-status')],
      ['Generated on', new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })]
    ];
    const w = window.open('', '_blank');
    if (!w) { showToast('Please allow pop-ups to download the PDF', 'error'); return; }
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>SA'DA H2O — Incentive Report</title>
<style>
  *{box-sizing:border-box;} body{font-family:Arial,sans-serif;color:#0A1628;margin:0;background:#fff;}
  .topbar{position:fixed;top:0;left:0;right:0;background:#0D3B6E;color:#fff;padding:16px 32px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;}
  .btn-gold{background:#C9A84C;color:#0A1628;border:none;padding:10px 18px;border-radius:8px;font-weight:700;cursor:pointer;font-size:14px;}
  .btn-outline{background:transparent;color:#fff;border:1.5px solid rgba(255,255,255,.5);padding:10px 18px;border-radius:8px;font-weight:600;cursor:pointer;font-size:14px;}
  .page-body{margin-top:88px;padding:32px;} h1{font-size:28px;color:#0D3B6E;margin:0 0 20px;font-weight:800;}
  .info-bar{background:#F0F6FC;border-radius:12px;padding:16px 24px;display:flex;gap:28px;flex-wrap:wrap;margin-bottom:24px;}
  .info-label{font-size:10px;color:#607D8B;text-transform:uppercase;letter-spacing:.4px;font-weight:700;} .info-value{font-size:14px;font-weight:700;margin-top:2px;}
  .kpis{display:flex;gap:16px;margin-bottom:24px;flex-wrap:wrap;} .kpi{border:1px solid #E2E8F0;border-radius:10px;padding:14px 18px;flex:1 1 110px;}
  .kpi .v{font-size:20px;font-weight:800;color:#0D3B6E;} .kpi .l{font-size:11px;color:#607D8B;text-transform:uppercase;font-weight:700;margin-top:2px;}
  .section-title{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 8px;}
  table{width:100%;border-collapse:collapse;font-size:12px;} th,td{border-bottom:1px solid #EEF2F6;padding:8px 6px;text-align:left;}
  th{color:#607D8B;text-transform:uppercase;font-size:10px;letter-spacing:.4px;}
  @page{size:A4 portrait;margin:12mm 10mm;}
  @media print{.topbar{display:none;} .page-body{margin-top:0;padding:0;} table{font-size:9px;} th,td{padding:4px 3px;word-break:break-word;}}
</style></head><body>
  <div class="topbar"><div><b>SA'DA H2O</b> | Incentive report</div>
    <div><button class="btn-gold" onclick="window.print()">⬇ Save as PDF / Print</button> <button class="btn-outline" onclick="window.close()">Close</button></div></div>
  <div class="page-body">
    <h1>Incentive Report</h1>
    <div class="info-bar">${info.map(([l, v]) => `<div><div class="info-label">${l}</div><div class="info-value">${esc(v)}</div></div>`).join('')}</div>
    <div class="kpis">
      <div class="kpi"><div class="v">SAR ${money(k.total)}</div><div class="l">Earned</div></div>
      <div class="kpi"><div class="v">SAR ${money(k.paid)}</div><div class="l">Paid</div></div>
      <div class="kpi"><div class="v">SAR ${money(k.due)}</div><div class="l">Balance Due</div></div>
      <div class="kpi"><div class="v">${k.bookings}</div><div class="l">Bookings</div></div>
      <div class="kpi"><div class="v">${k.people}</div><div class="l">People</div></div>
    </div>
    <div class="section-title">Totals by person</div>${personTable(rows, true)}
    <div class="section-title">Incentive details</div>${detailTable(rows, true)}
  </div>
</body></html>`);
    w.document.close();
  }

  Object.assign(window, { loadIncentiveReport, irFetch: fetchRows, irRender: render, irPdf: pdf });
})();
