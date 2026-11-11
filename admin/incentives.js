// ============================================================
// admin/incentives.js — Incentives panel of the admin dashboard.
// Admin-only: awards are entered by hand; no portal shows them.
// Uses the dashboard's globals: dbAdmin, installers, salesUsers,
// loadSales, showToast, openModal, closeModal, logActivity.
// Tables: migrations/v110_incentives.sql, v111, v112, v114_incentive_batches.sql
// ============================================================
(function () {
  const GROUPS = [
    { key: 'lead_handler', label: 'Lead Handlers' },
    { key: 'kiosk', label: 'Kiosk Sales' },
    { key: 'h2o_installer', label: "SA'DA H2O Installers" },
    { key: 'ho_installer', label: "SA'DA HO Installers" },
    { key: 'shop', label: "Shop SA'DA H2O" }
  ];
  // Same names as the User Management page.
  const ACCOUNTS = [
    { key: 'installer', label: 'Installers' },
    { key: 'sales', label: 'Sales Team' }
  ];
  const ITEMS = [
    { key: 'non_uv', label: 'Non-UV Unit' },
    { key: 'uv', label: 'UV Unit' },
    { key: 'dispenser', label: 'Dispenser' },
    { key: 'filter_replacement', label: 'Filter Replacement' },
    { key: 'penalty', label: 'Penalty' }
  ];
  // The only products offered in the Add popup. item is the chart column whose
  // rate applies; commercial systems have no chart rate, so the admin types it.
  const PRODUCTS = [
    { name: '7 stage RO - A100', item: 'non_uv' },
    { name: '7 stage RO - A1UV', item: 'uv' },
    { name: 'Smart RO (6 stage) - SRO6', item: 'non_uv' },
    { name: 'Smart RO (7 stage) - SRO7', item: 'non_uv' },
    { name: '200 GPD Commercial RO System', item: 'commercial' },
    { name: '400 GPD Commercial RO System', item: 'commercial' },
    { name: 'RO Water Dispenser (Hot/Cold)', item: 'dispenser' }
  ];
  const RATE_ITEMS = ITEMS.filter(i => ['non_uv', 'uv', 'dispenser'].includes(i.key));

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const S = {
    tab: 'entries', month: today.slice(0, 7), person: '', group: '',
    entries: [], rates: [], people: [], payments: [], selected: new Map(), products: new Set(), editingBatch: null,
    amountMode: 'sar', amountValue: null, catalog: new Map()
  };

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const accountLabel = t => (ACCOUNTS.find(a => a.key === t) || {}).label || t;
  const itemLabel = k => (ITEMS.find(i => i.key === k) || {}).label || k;
  const typeLabel = e => e.product_name || itemLabel(e.item_type);
  const percentOf = (price, percent) => price > 0 && percent > 0 ? Math.round((price * percent / 100 + Number.EPSILON) * 100) / 100 : null;
  const percentNote = e => e.percent == null ? '' : `${Number(e.percent)}% of ${Number(e.base_price).toLocaleString('en-US')}`;
  const personKey = (type, id) => `${type}:${id}`;
  const $ = id => document.getElementById(id);

  function monthRange(month) {
    const [y, m] = month.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
    return { from: `${month}-01`, to: next };
  }

  function roster() {
    const groupOf = {};
    S.people.forEach(p => { groupOf[personKey(p.person_type, p.person_id)] = p.group_key; });
    const list = [];
    (salesUsers || []).filter(s => s.is_active !== false).forEach(s =>
      list.push({ key: personKey('sales', s.id), type: 'sales', id: s.id, name: s.name, group: groupOf[personKey('sales', s.id)] || '' }));
    (installers || []).filter(i => i.is_active !== false).forEach(i =>
      list.push({ key: personKey('installer', i.id), type: 'installer', id: i.id, name: i.name, group: groupOf[personKey('installer', i.id)] || '' }));
    return list.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function filteredEntries() {
    return S.entries.filter(e =>
      (!S.person || personKey(e.person_type, e.person_id) === S.person) &&
      (!S.group || e.person_type === S.group));
  }

  function totals(list) {
    let earned = 0, penalties = 0;
    list.forEach(e => { const a = Number(e.amount); if (a < 0) penalties += a; else earned += a; });
    return { earned, penalties, net: earned + penalties };
  }

  async function ensureStaffLoaded() {
    if (!salesUsers || !salesUsers.length) { try { await loadSales(); } catch (e) { /* shown as an empty list */ } }
  }

  async function fetchSetup() {
    const [rates, people] = await Promise.all([
      dbAdmin.from('incentive_rates').select('*'),
      dbAdmin.from('incentive_people').select('*')
    ]);
    if (rates.error) throw rates.error;
    if (people.error) throw people.error;
    S.rates = rates.data || [];
    S.people = people.data || [];
  }

  async function fetchMonth() {
    const { from, to } = monthRange(S.month);
    const [entries, payments] = await Promise.all([
      dbAdmin.from('incentive_entries').select('*').gte('period_date', from).lt('period_date', to)
        .order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      dbAdmin.from('incentive_payments').select('*').eq('month', from)
    ]);
    if (entries.error) throw entries.error;
    if (payments.error) throw payments.error;
    S.entries = entries.data || [];
    S.payments = payments.data || [];
  }

  async function loadIncentives() {
    ensureModals();
    const panel = $('panel-incentives');
    panel.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div> Loading incentives...</div></div>';
    try {
      await ensureStaffLoaded();
      await Promise.all([fetchSetup(), fetchMonth()]);
      render();
    } catch (e) {
      panel.innerHTML = `<div class="card"><div class="empty-state"><div>Could not load incentives: ${esc(e.message)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px;">If this is a new setup, run migrations/v110_incentives.sql first.</div></div></div>`;
    }
  }

  function render() {
    const tabs = [['entries', 'Entries'], ['summary', 'Monthly Summary'], ['rates', 'Rates'], ['people', 'People']];
    const tabBtns = tabs.map(([k, l]) =>
      `<button class="btn btn-sm ${S.tab === k ? 'btn-primary' : 'btn-ghost'}" onclick="incSetTab('${k}')">${l}</button>`).join('');
    const body = { entries: renderEntries, summary: renderSummary, rates: renderRates, people: renderPeople }[S.tab]();
    $('panel-incentives').innerHTML = `
      <div class="card">
        <div class="card-header"><span class="card-title">Incentives</span>
          <button class="btn btn-primary btn-sm" onclick="incOpenAdd()">+ Add Incentive</button>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;padding:12px 20px 0;">${tabBtns}</div>
        ${body}
      </div>`;
  }

  function filterBar() {
    const seen = new Map();
    roster().forEach(p => seen.set(p.key, p.name));
    S.entries.forEach(e => { const k = personKey(e.person_type, e.person_id); if (!seen.has(k)) seen.set(k, e.person_name); });
    const personOpts = [...seen.entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1])))
      .map(([k, n]) => `<option value="${esc(k)}" ${S.person === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const groupOpts = ACCOUNTS.map(g => `<option value="${g.key}" ${S.group === g.key ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
    return `
      <div class="filter-bar" style="padding:16px 20px 0;">
        <input type="month" class="form-input" style="max-width:170px;" value="${S.month}" onchange="incSetMonth(this.value)" aria-label="Month">
        <select class="form-input" style="max-width:200px;" onchange="incSetFilter('person',this.value)" aria-label="Person"><option value="">All people</option>${personOpts}</select>
        <select class="form-input" style="max-width:220px;" onchange="incSetFilter('group',this.value)" aria-label="Group"><option value="">All groups</option>${groupOpts}</select>
        <button class="btn btn-ghost btn-sm" onclick="incExport()">Download Excel</button>
      </div>`;
  }

  function kpis(t) {
    const kpi = (label, value, color) => `
      <div class="stat-card" style="border-top:3px solid ${color};">
        <div class="stat-value" style="color:${color};font-size:22px;">SAR ${money(value)}</div>
        <div class="stat-label">${label}</div>
      </div>`;
    return `<div class="stat-grid" style="padding:16px 20px 0;margin-bottom:0;">
      ${kpi('Total Incentives', t.net, '#0F766E')}
    </div>`;
  }

  // Bubble colours: [background, text].
  const PALETTE = [
    ['#DBEAFE', '#1E40AF'], ['#DCFCE7', '#166534'], ['#FEF3C7', '#92400E'], ['#FCE7F3', '#9D174D'],
    ['#EDE9FE', '#5B21B6'], ['#CFFAFE', '#155E75'], ['#FFE4E6', '#9F1239'], ['#E0E7FF', '#3730A3']
  ];
  const hashOf = s => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const chip = (text, colorIndex) => {
    const [bg, fg] = PALETTE[colorIndex % PALETTE.length];
    return `<span style="display:inline-block;background:${bg};color:${fg};border-radius:999px;padding:3px 10px;margin:2px;font-size:12px;font-weight:600;white-space:nowrap;">${esc(text)}</span>`;
  };
  const personChip = name => chip(name, hashOf(name));
  const productChip = name => { const i = PRODUCTS.findIndex(p => p.name === name); return chip(name, i < 0 ? hashOf(name) : i + 3); };
  // Shown as dd/mm/yyyy; stored as yyyy-mm-dd.
  const dmy = d => d ? String(d).split('-').reverse().join('/') : '—';
  const idLabel = n => n == null ? '—' : `INC-${String(n).padStart(4, '0')}`;
  // Entries saved together share batch_no (v114). Before v114 they still share created_at.
  const batchKeyOf = e => e.batch_no != null ? String(e.batch_no) : `t${e.created_at}`;

  function findBatch(key) {
    const entries = S.entries.filter(e => batchKeyOf(e) === key);
    return entries.length ? { key, no: entries[0].batch_no ?? null, entries } : null;
  }

  function amountLabel(list) {
    const first = list[0];
    if (first.percent != null) return list.every(e => Number(e.percent) === Number(first.percent)) ? `${Number(first.percent)}%` : 'Mixed';
    return list.every(e => e.percent == null && Number(e.rate) === Number(first.rate)) ? `SAR ${money(first.rate)}` : 'Mixed';
  }

  // One row per Save. With a person or group filter, Total is only their share.
  function batches() {
    const shown = new Set(filteredEntries().map(e => e.id));
    const keys = [...new Set(S.entries.map(batchKeyOf))];
    const uniq = list => [...new Set(list)];
    return keys.map(findBatch).map(b => {
      const mine = b.entries.filter(e => shown.has(e.id));
      return {
        ...b, mine,
        from: b.entries[0].entry_date, to: b.entries[0].end_date,
        people: uniq(b.entries.map(e => e.person_name)),
        products: uniq(b.entries.map(typeLabel)),
        amount: amountLabel(b.entries),
        total: totals(mine).net
      };
    }).filter(b => b.mine.length);
  }

  function renderEntries() {
    const list = batches();
    const rows = list.map(b => `
      <tr>
        <td style="font-weight:700;white-space:nowrap;">${idLabel(b.no)}</td>
        <td style="white-space:nowrap;">${dmy(b.from)}</td>
        <td style="white-space:nowrap;">${dmy(b.to)}</td>
        <td style="min-width:180px;">${b.people.map(personChip).join('')}</td>
        <td style="min-width:200px;">${b.products.map(productChip).join('')}</td>
        <td style="white-space:nowrap;">${esc(b.amount)}</td>
        <td style="font-weight:700;white-space:nowrap;${b.total < 0 ? 'color:#B71C1C;' : ''}">SAR ${money(b.total)}</td>
        <td><div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="incView('${esc(b.key)}')">View</button>
          <button class="btn btn-sm btn-ghost" onclick="incOpenEdit('${esc(b.key)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="incDelete('${esc(b.key)}')">Delete</button>
        </div></td>
      </tr>`).join('');
    return filterBar() + kpis(totals(filteredEntries())) + `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        ${list.length ? `<table><thead><tr><th>ID</th><th>From</th><th>To</th><th>People</th><th>Products</th><th>Amount</th><th>Total</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No incentives for this month yet.</div></div>'}
      </div>`;
  }
  function summaryRows() {
    const byPerson = new Map();
    filteredEntries().forEach(e => {
      const k = personKey(e.person_type, e.person_id);
      if (!byPerson.has(k)) byPerson.set(k, { key: k, type: e.person_type, id: e.person_id, name: e.person_name, group: e.group_key, list: [] });
      byPerson.get(k).list.push(e);
    });
    return [...byPerson.values()].map(p => {
      const t = totals(p.list);
      const paid = S.payments.find(x => personKey(x.person_type, x.person_id) === p.key);
      return { ...p, ...t, paid };
    }).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function renderSummary() {
    const data = summaryRows();
    const rows = data.map(p => {
      const changed = p.paid && Number(p.paid.amount) !== p.net;
      return `<tr>
        <td style="font-weight:600;">${esc(p.name)}</td>
        <td>${esc(accountLabel(p.type))}</td>
        <td style="font-weight:700;">${money(p.net)}</td>
        <td><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" ${p.paid ? 'checked' : ''} onchange="incTogglePaid('${p.key}',this)"> ${p.paid ? 'Paid' : 'Not paid'}</label>
          ${changed ? `<div style="font-size:11px;color:#B71C1C;">Paid SAR ${money(p.paid.amount)}. Entries changed since.</div>` : ''}
        </td>
      </tr>`;
    }).join('');
    return filterBar() + kpis(totals(filteredEntries())) + `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        ${data.length ? `<table><thead><tr><th>Person</th><th>Group</th><th>Total</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No incentives for this month yet.</div></div>'}
      </div>`;
  }

  function renderRates() {
    const head = RATE_ITEMS.map(i => `<th>${i.label}</th>`).join('');
    const rows = GROUPS.map(g => `
      <tr><td style="font-weight:600;white-space:nowrap;">${esc(g.label)}</td>
      ${RATE_ITEMS.map(i => {
        const r = S.rates.find(x => x.group_key === g.key && x.item_type === i.key);
        return `<td><input type="number" step="0.01" class="form-input inc-rate" style="min-width:84px;" data-group="${g.key}" data-item="${i.key}" value="${r ? Number(r.rate) : ''}" aria-label="${esc(g.label)} ${i.label}"></td>`;
      }).join('')}</tr>`).join('');
    return `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        <table><thead><tr><th>Group</th>${head}</tr></thead><tbody>${rows}</tbody></table>
        <div style="font-size:12px;color:var(--muted);margin-top:10px;">Leave a box empty if that group has no rate for it. Changing a rate does not change incentives already saved.</div>
        <div style="margin-top:12px;"><button class="btn btn-primary" id="inc-rates-save" onclick="incSaveRates()">Save Rates</button></div>
      </div>`;
  }

  function renderPeople() {
    const people = roster();
    const rows = people.map(p => `
      <tr>
        <td style="font-weight:600;">${esc(p.name)}</td>
        <td>${p.type === 'sales' ? 'Sales' : 'Installer'}</td>
        <td><select class="form-input" style="max-width:240px;" onchange="incSetPersonGroup('${p.key}',this.value)" aria-label="Group for ${esc(p.name)}">
          <option value="">No group</option>
          ${GROUPS.map(g => `<option value="${g.key}" ${p.group === g.key ? 'selected' : ''}>${esc(g.label)}</option>`).join('')}
        </select></td>
      </tr>`).join('');
    return `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        ${people.length ? `<table><thead><tr><th>Person</th><th>Account</th><th>Rate Group</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No sales users or installers found.</div></div>'}
      </div>`;
  }

  // ---- Add popup ----

  function ensureModals() {
    if ($('inc-modal')) return;

    const groupOpts = ACCOUNTS.map(g => `<option value="${g.key}">${esc(g.label)}</option>`).join('');
    const errBox = id => `<div id="${id}" style="display:none;background:#FEF2F2;border:1px solid #FECACA;color:#B71C1C;padding:12px;border-radius:10px;font-size:13px;margin-top:8px;"></div>`;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="inc-modal">
        <div class="modal" style="max-width:820px;width:100%;max-height:92vh;overflow-y:auto;">
          <h2 class="modal-title" id="inc-modal-title">Add Incentive</h2>
          <div class="form-group"><label>Type</label>
            <div id="inc-products"></div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 12px;">
            <div class="form-group"><label>From</label><input type="date" class="form-input" id="inc-date"></div>
            <div class="form-group"><label>To <span style="color:var(--muted);font-weight:400;">(optional)</span></label><input type="date" class="form-input" id="inc-end"></div>
          </div>
          <div class="form-group"><label>Select People</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
              <input type="text" class="form-input" style="flex:1;min-width:150px;" id="inc-search" placeholder="Search name..." oninput="incRenderPicker()">
              <select class="form-input" style="flex:1;min-width:150px;" id="inc-group-filter" onchange="incRenderPicker()"><option value="">All groups</option>${groupOpts}</select>
              <button class="btn btn-ghost btn-sm" onclick="incSelectShown()">Select all shown</button>
            </div>
            <div id="inc-picker" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;max-height:150px;overflow-y:auto;border:1px solid var(--border,#E5E7EB);border-radius:10px;padding:10px;"></div>
          </div>
          <div class="form-group"><label>Amount</label>
            <div style="display:flex;gap:8px;">
              <select class="form-input" style="width:90px;flex:none;" id="inc-amount-mode" onchange="incSetAmountMode(this.value)" aria-label="Amount in"><option value="sar">SAR</option><option value="percent">%</option></select>
              <input type="number" min="0" step="0.01" class="form-input" style="flex:1;min-width:0;" id="inc-amount" placeholder="Enter amount" oninput="incSetAmount(this.value)" aria-label="Amount">
            </div>
          </div>
          <div id="inc-lines" style="overflow-x:auto;"></div>
          ${errBox('inc-error')}
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="closeModal('inc-modal')">Cancel</button>
            <button class="btn btn-primary" id="inc-save" onclick="incSaveAll()">Save All</button>
          </div>
        </div>
      </div>
`);
  }

  function showError(id, msg) { const el = $(id); el.textContent = msg; el.style.display = 'block'; }
  function clearError(id) { $(id).style.display = 'none'; }

  // Read fresh each time a popup opens, so a price changed on the Products
  // page is used straight away.
  async function loadPrices() {
    try {
      const { data, error } = await dbAdmin.from('product_models').select('model_name, price_sar');
      if (error) throw error;
      S.catalog = new Map((data || []).map(p => [p.model_name, p.price_sar == null ? null : Number(p.price_sar)]));
    } catch (e) {
      showToast('Could not load product prices.', 'error');
    }
  }

  async function prepareForm() {
    ensureModals();
    await loadPrices();
    S.selected = new Map();
    S.products = new Set();
    S.amountMode = 'sar';
    S.amountValue = null;
    S.editingBatch = null;
  }

  function fillForm(title, button, from, to) {
    $('inc-modal-title').textContent = title;
    $('inc-save').textContent = button;
    $('inc-amount-mode').value = S.amountMode;
    $('inc-amount').value = S.amountValue == null ? '' : S.amountValue;
    $('inc-date').value = from;
    $('inc-end').value = to;
    $('inc-search').value = '';
    $('inc-group-filter').value = '';
    clearError('inc-error');
    renderProducts();
    renderPicker();
    renderLines();
    openModal('inc-modal');
  }

  async function openAdd() {
    await prepareForm();
    fillForm('Add Incentive', 'Save All', today, '');
  }
  function shownPeople() {
    const q = $('inc-search').value.trim().toLowerCase();
    const g = $('inc-group-filter').value;
    return roster().filter(p => (!q || String(p.name).toLowerCase().includes(q)) && (!g || p.type === g));
  }

  function renderPicker() {
    const list = shownPeople();
    $('inc-picker').innerHTML = list.length ? list.map(p => `
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" ${S.selected.has(p.key) ? 'checked' : ''} onchange="incTogglePerson('${p.key}',this.checked)">
        <span>${esc(p.name)}</span>
      </label>`).join('') : '<div style="font-size:13px;color:var(--muted);">No people found.</div>';
  }

  function renderProducts() {
    const chosen = PRODUCTS.map((p, i) => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;border:1px solid var(--border,#E5E7EB);border-radius:10px;padding:8px 12px;margin-bottom:8px;">
        <span style="font-size:14px;font-weight:600;">${esc(p.name)}</span>
        <button type="button" class="btn btn-sm btn-danger" onclick="incRemoveProduct(${i})" aria-label="Remove ${esc(p.name)}">🗑</button>
      </div>`).filter((_, i) => S.products.has(i)).join('');
    const options = PRODUCTS.map((p, i) => S.products.has(i) ? '' : `<option value="${i}">${esc(p.name)}</option>`).join('');
    $('inc-products').innerHTML = (chosen || '<div style="font-size:13px;color:var(--muted);margin-bottom:8px;">No products yet — add one below.</div>') +
      (options ? `<div style="display:flex;gap:8px;">
        <select class="form-input" style="flex:1;min-width:0;" id="inc-product-select" aria-label="Product">${options}</select>
        <button type="button" class="btn btn-ghost" onclick="incAddProduct()">+ Add</button>
      </div>` : '');
  }

  function addProduct() {
    toggleProduct(Number($('inc-product-select').value), true);
    renderProducts();
  }

  function removeProduct(i) {
    toggleProduct(i, false);
    renderProducts();
  }

  const chosenProducts = () => PRODUCTS.filter((_, i) => S.products.has(i));

  // One saved entry per selected person per selected product, all from the
  // one Amount box. SAR is the same on every product; % uses each product's price.
  function buildLines() {
    const out = [];
    const pct = S.amountMode === 'percent';
    S.selected.forEach(person => chosenProducts().forEach(product => {
      const price = pct ? (S.catalog.get(product.name) ?? null) : null;
      out.push({
        person, product, mode: S.amountMode, percent: pct ? S.amountValue : null, price,
        rate: pct ? percentOf(price, S.amountValue) : S.amountValue
      });
    }));
    return out;
  }

  function missingPrices() {
    if (S.amountMode !== 'percent') return [];
    return chosenProducts().filter(p => !(S.catalog.get(p.name) > 0)).map(p => p.name);
  }

  function toggleProduct(i, on) {
    if (on) S.products.add(i); else S.products.delete(i);
    renderLines();
  }

  function togglePerson(key, on) {
    if (on) { const p = roster().find(x => x.key === key); if (p) S.selected.set(p.key, p); }
    else S.selected.delete(key);
    renderLines();
  }

  function selectShown() {
    shownPeople().forEach(p => S.selected.set(p.key, p));
    renderPicker();
    renderLines();
  }

  function setAmount(value) {
    S.amountValue = value === '' ? null : Number(value);
    renderLines();
  }

  function setAmountMode(mode) {
    S.amountMode = mode;
    renderLines();
  }

  function renderLines() {
    const box = $('inc-lines');
    const products = chosenProducts().map(p => p.name);
    const people = [...S.selected.values()].map(p => p.name);
    if (!products.length || !people.length) {
      box.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:6px 0;">Select the products and people to see the total.</div>';
      return;
    }
    const total = buildLines().reduce((sum, l) => sum + (l.rate || 0), 0);
    const value = S.amountValue;
    const amount = !(value > 0) ? '—' : S.amountMode === 'percent' ? `${value}%` : `SAR ${money(value)}`;
    const missing = missingPrices();
    const names = (label, chips) => `<div style="margin-top:8px;"><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:2px;">${label}</div>${chips}</div>`;
    box.innerHTML = `
      <table>
        <thead><tr><th>Products</th><th>People</th><th>Amount</th><th>Each Person Gets</th><th>Total</th></tr></thead>
        <tbody><tr>
          <td>${products.length}</td>
          <td>${people.length}</td>
          <td>${esc(amount)}</td>
          <td style="font-weight:600;">SAR ${money(total / people.length)}</td>
          <td style="font-weight:700;">SAR ${money(total)}</td>
        </tr></tbody>
      </table>
      ${names('Products', products.map(productChip).join(''))}
      ${names('People', people.map(personChip).join(''))}
      ${missing.length ? `<div style="font-size:12px;color:#B71C1C;margin-top:6px;">No price found for: ${esc(missing.join(', '))}</div>` : ''}`;
  }

  async function userEmail() {
    try { const { data } = await dbAdmin.auth.getSession(); return data.session?.user?.email || null; }
    catch (e) { return null; }
  }

  async function saveAll() {
    clearError('inc-error');
    const lines = buildLines();
    const date = $('inc-date').value;
    const end = $('inc-end').value || null;
    if (!date) return showError('inc-error', 'Please choose a From date.');
    if (end && end < date) return showError('inc-error', 'To date cannot be before the From date.');
    if (!S.products.size) return showError('inc-error', 'Please select at least one product.');
    if (!lines.length) return showError('inc-error', 'Please select at least one person.');
    if (!(S.amountValue > 0)) return showError('inc-error', 'Please enter an amount.');
    if (S.amountMode === 'percent' && S.amountValue > 100) return showError('inc-error', 'Percent cannot be more than 100.');
    const noPrice = missingPrices();
    if (noPrice.length) return showError('inc-error', `No price found for ${noPrice.join(', ')}. Please set it on the Products page.`);
    if (lines.some(l => !(l.rate > 0))) return showError('inc-error', 'Please enter a larger amount.');
    const btn = $('inc-save');
    btn.disabled = true;
    try {
      const created_by = await userEmail();
      const rows = lines.map(l => ({
        entry_date: date, end_date: end, person_type: l.person.type, person_id: l.person.id, person_name: l.person.name,
        group_key: l.person.group || null, item_type: l.product.item,
        product_name: l.product.name, qty: 1, rate: l.rate, created_by,
        percent: l.mode === 'percent' ? l.percent : null,
        base_price: l.mode === 'percent' ? l.price : null
      }));
      const editing = S.editingBatch != null;
      const { data: no, error } = await dbAdmin.rpc('save_incentive_batch', { p_batch_no: S.editingBatch, p_rows: rows });
      if (error) throw error;
      closeModal('inc-modal');
      showToast(`${editing ? 'Updated' : 'Saved'} ${idLabel(no)}`);
      try { logActivity(editing ? 'incentive_updated' : 'incentive_added', `${editing ? 'Updated' : 'Added'} ${idLabel(no)} (${rows.length} entries)`, 'incentive', String(no)); } catch (e) { /* log only */ }
      S.month = (end || date).slice(0, 7);
      await fetchMonth();
      render();
    } catch (e) {
      showError('inc-error', 'Could not save: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- View / edit / delete: always a whole Save ----

  function view(key) {
    const b = findBatch(key);
    if (!b) return;
    const rows = b.entries.map(e => `<tr><td>${personChip(e.person_name)}</td><td>${productChip(typeLabel(e))}</td>
      <td style="white-space:nowrap;">SAR ${money(e.amount)}${e.percent != null ? `<div style="font-size:11px;color:var(--muted);">${esc(percentNote(e))}</div>` : ''}</td></tr>`).join('');
    showInfoModal(`${idLabel(b.no)} · ${dmy(b.entries[0].entry_date)}`, `
      <div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Person</th><th>Product</th><th>Amount</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div style="font-weight:700;text-align:right;margin-top:10px;">Total: SAR ${money(totals(b.entries).net)}</div>`);
  }

  // Opens the Add popup filled with this Save; saving replaces its entries.
  async function openEdit(key) {
    const b = findBatch(key);
    if (!b) return;
    if (b.no == null) return showToast('Please run migration v114 before editing.', 'error');
    const products = new Set(b.entries.map(e => PRODUCTS.findIndex(p => p.name === e.product_name)));
    if (products.has(-1)) return showToast('This older entry cannot be edited here. Please delete it and add it again.', 'error');
    await prepareForm();
    const current = new Map(roster().map(p => [p.key, p]));
    b.entries.forEach(e => {
      const k = personKey(e.person_type, e.person_id);
      if (!S.selected.has(k)) S.selected.set(k, current.get(k) || { key: k, type: e.person_type, id: e.person_id, name: e.person_name, group: e.group_key || '' });
    });
    const first = b.entries[0];
    S.products = products;
    S.amountMode = first.percent != null ? 'percent' : 'sar';
    S.amountValue = Number(first.percent != null ? first.percent : first.rate);
    S.editingBatch = b.no;
    fillForm(`Edit Incentive ${idLabel(b.no)}`, 'Save Changes', first.entry_date, first.end_date || '');
  }

  async function del(key) {
    const b = findBatch(key);
    if (!b) return;
    const n = b.entries.length;
    if (!confirm(`Delete ${idLabel(b.no)} (${n} ${n === 1 ? 'entry' : 'entries'}, SAR ${money(totals(b.entries).net)})? This cannot be undone.`)) return;
    const { error } = await dbAdmin.from('incentive_entries').delete().in('id', b.entries.map(e => e.id));
    if (error) return showToast('Could not delete: ' + error.message, 'error');
    showToast(`Deleted ${idLabel(b.no)}`);
    try { logActivity('incentive_deleted', `Deleted ${idLabel(b.no)} (${n} entries)`, 'incentive', b.no == null ? null : String(b.no)); } catch (e) { /* log only */ }
    await fetchMonth();
    render();
  }
  // ---- Paid tick, rates, people ----

  async function togglePaid(key, box) {
    const p = summaryRows().find(x => x.key === key);
    if (!p) return;
    const month = monthRange(S.month).from;
    const match = { person_type: p.type, person_id: p.id, month };
    box.disabled = true;
    const { error } = box.checked
      ? await dbAdmin.from('incentive_payments').upsert({ ...match, amount: p.net, paid_at: new Date().toISOString(), paid_by: await userEmail() })
      : await dbAdmin.from('incentive_payments').delete().match(match);
    if (error) showToast('Could not update: ' + error.message, 'error');
    await fetchMonth();
    render();
  }

  async function saveRates() {
    const btn = $('inc-rates-save');
    const upserts = [], removals = [];
    let bad = false;
    document.querySelectorAll('.inc-rate').forEach(i => {
      const row = { group_key: i.dataset.group, item_type: i.dataset.item };
      if (i.value === '') { removals.push(row); return; }
      const rate = Number(i.value);
      if (!isFinite(rate)) { bad = true; return; }
      upserts.push({ ...row, rate, updated_at: new Date().toISOString() });
    });
    if (bad) return showToast('Please check the rates: one is not a number.', 'error');
    btn.disabled = true;
    try {
      if (upserts.length) {
        const { error } = await dbAdmin.from('incentive_rates').upsert(upserts);
        if (error) throw error;
      }
      for (const r of removals) {
        if (!S.rates.some(x => x.group_key === r.group_key && x.item_type === r.item_type)) continue;
        const { error } = await dbAdmin.from('incentive_rates').delete().match(r);
        if (error) throw error;
      }
      showToast('Rates saved');
      await fetchSetup();
      render();
    } catch (e) {
      showToast('Could not save rates: ' + e.message, 'error');
      btn.disabled = false;
    }
  }

  async function setPersonGroup(key, group) {
    const [person_type, person_id] = key.split(':');
    const { error } = group
      ? await dbAdmin.from('incentive_people').upsert({ person_type, person_id, group_key: group })
      : await dbAdmin.from('incentive_people').delete().match({ person_type, person_id });
    if (error) showToast('Could not update: ' + error.message, 'error');
    else showToast('Group updated');
    await fetchSetup();
    render();
  }

  // ---- Excel download (CSV, which Excel opens directly) ----

  function exportCsv() {
    const list = filteredEntries();
    if (!list.length) return showToast('Nothing to download for this month.', 'error');
    // Prefix text cells so Excel never evaluates a typed note as a formula.
    const cell = v => {
      let s = String(v == null ? '' : v);
      if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = "'" + s;
      return `"${s.replace(/"/g, '""')}"`;
    };
    const lines = [['ID', 'From', 'To', 'Person', 'Group', 'Type', 'Percent', 'Amount'].map(cell).join(',')];
    list.slice().reverse().forEach(e => lines.push([
      idLabel(e.batch_no), e.entry_date, e.end_date, e.person_name, accountLabel(e.person_type), typeLabel(e), percentNote(e), Number(e.amount)
    ].map(cell).join(',')));
    lines.push('');
    lines.push(['Person', 'Group', 'Total', 'Status'].map(cell).join(','));
    summaryRows().forEach(p => lines.push([p.name, accountLabel(p.type), p.net, p.paid ? 'Paid' : 'Not paid'].map(cell).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `incentives-${S.month}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  Object.assign(window, {
    loadIncentives,
    incSetTab: t => { S.tab = t; render(); },
    incSetMonth: async m => { if (!m) return; S.month = m; try { await fetchMonth(); render(); } catch (e) { showToast(e.message, 'error'); } },
    incSetFilter: (k, v) => { S[k] = v; render(); },
    incOpenAdd: openAdd, incAddProduct: addProduct, incRemoveProduct: removeProduct, incRenderPicker: renderPicker,
    incSelectShown: selectShown, incTogglePerson: togglePerson,
    incSetAmount: setAmount, incSetAmountMode: setAmountMode,
    incSaveAll: saveAll, incOpenEdit: openEdit, incView: view, incDelete: del,
    incTogglePaid: togglePaid, incSaveRates: saveRates, incSetPersonGroup: setPersonGroup, incExport: exportCsv
  });
})();
