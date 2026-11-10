// ============================================================
// admin/incentives.js — Incentives panel of the admin dashboard.
// Admin-only: awards are entered by hand; no portal shows them.
// Uses the dashboard's globals: dbAdmin, installers, salesUsers,
// loadSales, showToast, openModal, closeModal, logActivity.
// Tables: migrations/v110_incentives.sql
// ============================================================
(function () {
  const GROUPS = [
    { key: 'lead_handler', label: 'Lead Handlers' },
    { key: 'kiosk', label: 'Kiosk Sales' },
    { key: 'h2o_installer', label: "SA'DA H2O Installers" },
    { key: 'ho_installer', label: "SA'DA HO Installers" },
    { key: 'shop', label: "Shop SA'DA H2O" }
  ];
  const RATE_GROUPS = GROUPS.concat([
    { key: 'installer_referral', label: 'Installers Referral Sales' },
    { key: 'demo_sale', label: 'Lead Handler-Referred Demo Sale' }
  ]);
  const ITEMS = [
    { key: 'non_uv', label: 'Non-UV Unit' },
    { key: 'uv', label: 'UV Unit' },
    { key: 'dispenser', label: 'Dispenser' },
    { key: 'filter_replacement', label: 'Filter Replacement' },
    { key: 'penalty', label: 'Penalty' }
  ];
  const INSTALLER_GROUPS = ['h2o_installer', 'ho_installer'];
  const DEMO_GROUPS = ['kiosk', 'shop'];

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  const S = {
    tab: 'entries', month: today.slice(0, 7), person: '', group: '',
    entries: [], rates: [], people: [], payments: [], selected: new Map(), editingId: null
  };

  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const groupLabel = k => (RATE_GROUPS.find(g => g.key === k) || {}).label || 'No group';
  const itemLabel = k => (ITEMS.find(i => i.key === k) || {}).label || k;
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

  function rateFor(group, earnedAs, item) {
    const g = earnedAs === 'referral' ? 'installer_referral' : earnedAs === 'demo' ? 'demo_sale' : group;
    const row = S.rates.find(r => r.group_key === g && r.item_type === item);
    return row ? Number(row.rate) : null;
  }

  function earnedOptions(group) {
    if (INSTALLER_GROUPS.includes(group)) return [['own', 'Installation'], ['referral', 'Referral Sale']];
    if (DEMO_GROUPS.includes(group)) return [['own', 'Sale'], ['demo', 'Demo Referral']];
    return [['own', 'Sale']];
  }
  const earnedLabel = e => ({ own: 'Standard', referral: 'Referral Sale', demo: 'Demo Referral' }[e] || e);

  function filteredEntries() {
    return S.entries.filter(e =>
      (!S.person || personKey(e.person_type, e.person_id) === S.person) &&
      (!S.group || e.group_key === S.group));
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
      dbAdmin.from('incentive_entries').select('*').gte('entry_date', from).lt('entry_date', to)
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
    const groupOpts = GROUPS.map(g => `<option value="${g.key}" ${S.group === g.key ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
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
      ${kpi('Total Earned', t.earned, '#0F766E')}${kpi('Penalties', t.penalties, '#B71C1C')}${kpi('Net Payable', t.net, '#1D4ED8')}
    </div>`;
  }

  function renderEntries() {
    const list = filteredEntries();
    const rows = list.map(e => `
      <tr>
        <td style="white-space:nowrap;">${esc(e.entry_date)}</td>
        <td><div style="font-weight:600;">${esc(e.person_name)}</div>${e.note ? `<div style="font-size:11px;color:var(--muted);">${esc(e.note)}</div>` : ''}</td>
        <td>${esc(groupLabel(e.group_key))}</td>
        <td>${esc(itemLabel(e.item_type))}${e.earned_as !== 'own' ? `<div style="font-size:11px;color:var(--muted);">${esc(earnedLabel(e.earned_as))}</div>` : ''}</td>
        <td>${esc(e.booking_ref || '—')}</td>
        <td>${e.qty}</td>
        <td>${money(e.rate)}</td>
        <td style="font-weight:600;${Number(e.amount) < 0 ? 'color:#B71C1C;' : ''}">${money(e.amount)}</td>
        <td><div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="incOpenEdit('${e.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="incDelete('${e.id}')">Delete</button>
        </div></td>
      </tr>`).join('');
    return filterBar() + kpis(totals(list)) + `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        ${list.length ? `<table><thead><tr><th>Date</th><th>Person</th><th>Group</th><th>Type</th><th>Booking</th><th>Qty</th><th>Rate</th><th>Amount</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
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
        <td>${esc(groupLabel(p.group))}</td>
        <td>${money(p.earned)}</td>
        <td style="color:#B71C1C;">${money(p.penalties)}</td>
        <td style="font-weight:700;">${money(p.net)}</td>
        <td><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;">
          <input type="checkbox" ${p.paid ? 'checked' : ''} onchange="incTogglePaid('${p.key}',this)"> ${p.paid ? 'Paid' : 'Not paid'}</label>
          ${changed ? `<div style="font-size:11px;color:#B71C1C;">Paid SAR ${money(p.paid.amount)}. Entries changed since.</div>` : ''}
        </td>
      </tr>`;
    }).join('');
    return filterBar() + kpis(totals(filteredEntries())) + `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        ${data.length ? `<table><thead><tr><th>Person</th><th>Group</th><th>Earned</th><th>Penalties</th><th>Net Payable</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No incentives for this month yet.</div></div>'}
      </div>`;
  }

  function renderRates() {
    const head = ITEMS.map(i => `<th>${i.label}</th>`).join('');
    const rows = RATE_GROUPS.map(g => `
      <tr><td style="font-weight:600;white-space:nowrap;">${esc(g.label)}</td>
      ${ITEMS.map(i => {
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
        ${people.length ? `<table><thead><tr><th>Person</th><th>Account</th><th>Incentive Group</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No sales users or installers found.</div></div>'}
      </div>`;
  }

  // ---- Add popup ----

  function ensureModals() {
    if ($('inc-modal')) return;
    const itemOpts = ITEMS.map(i => `<option value="${i.key}">${i.label}</option>`).join('');
    const groupOpts = GROUPS.map(g => `<option value="${g.key}">${esc(g.label)}</option>`).join('');
    const errBox = id => `<div id="${id}" style="display:none;background:#FEF2F2;border:1px solid #FECACA;color:#B71C1C;padding:12px;border-radius:10px;font-size:13px;margin-top:8px;"></div>`;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="inc-modal">
        <div class="modal" style="max-width:820px;width:100%;max-height:92vh;overflow-y:auto;">
          <h2 class="modal-title">Add Incentive</h2>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 12px;">
            <div class="form-group"><label>Type</label><select class="form-input" id="inc-item" onchange="incCommonChanged()">${itemOpts}</select></div>
            <div class="form-group"><label>Quantity</label><input type="number" min="1" step="1" class="form-input" id="inc-qty" value="1" oninput="incCommonChanged()"></div>
            <div class="form-group"><label>Date</label><input type="date" class="form-input" id="inc-date"></div>
            <div class="form-group"><label>Booking Ref <span style="color:var(--muted);font-weight:400;">(optional)</span></label><input type="text" class="form-input" id="inc-ref"></div>
          </div>
          <div class="form-group"><label>Note <span style="color:var(--muted);font-weight:400;">(optional)</span></label><input type="text" class="form-input" id="inc-note"></div>
          <div class="form-group"><label>Select People</label>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
              <input type="text" class="form-input" style="flex:1;min-width:150px;" id="inc-search" placeholder="Search name..." oninput="incRenderPicker()">
              <select class="form-input" style="flex:1;min-width:150px;" id="inc-group-filter" onchange="incRenderPicker()"><option value="">All groups</option>${groupOpts}</select>
              <button class="btn btn-ghost btn-sm" onclick="incSelectShown()">Select all shown</button>
            </div>
            <div id="inc-picker" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:6px;max-height:150px;overflow-y:auto;border:1px solid var(--border,#E5E7EB);border-radius:10px;padding:10px;"></div>
          </div>
          <div id="inc-lines" style="overflow-x:auto;"></div>
          ${errBox('inc-error')}
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="closeModal('inc-modal')">Cancel</button>
            <button class="btn btn-primary" id="inc-save" onclick="incSaveAll()">Save All</button>
          </div>
        </div>
      </div>
      <div class="modal-overlay" id="inc-edit-modal">
        <div class="modal">
          <h2 class="modal-title" id="inc-edit-title">Edit Incentive</h2>
          <div class="form-group"><label>Date</label><input type="date" class="form-input" id="inc-edit-date"></div>
          <div class="form-group"><label>Quantity</label><input type="number" min="1" step="1" class="form-input" id="inc-edit-qty"></div>
          <div class="form-group"><label>Rate (SAR)</label><input type="number" step="0.01" class="form-input" id="inc-edit-rate"></div>
          <div class="form-group"><label>Booking Ref</label><input type="text" class="form-input" id="inc-edit-ref"></div>
          <div class="form-group"><label>Note</label><input type="text" class="form-input" id="inc-edit-note"></div>
          ${errBox('inc-edit-error')}
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="closeModal('inc-edit-modal')">Cancel</button>
            <button class="btn btn-primary" id="inc-edit-save" onclick="incSaveEdit()">Save</button>
          </div>
        </div>
      </div>`);
  }

  function showError(id, msg) { const el = $(id); el.textContent = msg; el.style.display = 'block'; }
  function clearError(id) { $(id).style.display = 'none'; }

  function openAdd() {
    ensureModals();
    S.selected = new Map();
    $('inc-item').value = 'non_uv';
    $('inc-qty').value = 1;
    $('inc-date').value = today;
    $('inc-ref').value = '';
    $('inc-note').value = '';
    $('inc-search').value = '';
    $('inc-group-filter').value = '';
    clearError('inc-error');
    renderPicker();
    renderLines();
    openModal('inc-modal');
  }

  function shownPeople() {
    const q = $('inc-search').value.trim().toLowerCase();
    const g = $('inc-group-filter').value;
    return roster().filter(p => (!q || String(p.name).toLowerCase().includes(q)) && (!g || p.group === g));
  }

  function renderPicker() {
    const list = shownPeople();
    $('inc-picker').innerHTML = list.length ? list.map(p => `
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;cursor:pointer;">
        <input type="checkbox" ${S.selected.has(p.key) ? 'checked' : ''} onchange="incTogglePerson('${p.key}',this.checked)">
        <span>${esc(p.name)}</span>
      </label>`).join('') : '<div style="font-size:13px;color:var(--muted);">No people found.</div>';
  }

  function addLine(p) {
    const item = $('inc-item').value;
    S.selected.set(p.key, { ...p, earned: 'own', rate: rateFor(p.group, 'own', item), qty: parseInt($('inc-qty').value, 10) || 1 });
  }

  function togglePerson(key, on) {
    if (on) { const p = roster().find(x => x.key === key); if (p) addLine(p); }
    else S.selected.delete(key);
    renderLines();
  }

  function selectShown() {
    shownPeople().forEach(p => { if (!S.selected.has(p.key)) addLine(p); });
    renderPicker();
    renderLines();
  }

  function removeLine(key) { S.selected.delete(key); renderPicker(); renderLines(); }

  function commonChanged() {
    const item = $('inc-item').value;
    const qty = parseInt($('inc-qty').value, 10) || 1;
    S.selected.forEach(l => {
      if (item === 'penalty') l.earned = 'own';
      l.rate = rateFor(l.group, l.earned, item);
      l.qty = qty;
    });
    renderLines();
  }

  function setLine(key, field, value) {
    const l = S.selected.get(key);
    if (!l) return;
    if (field === 'earned') {
      l.earned = value;
      l.rate = rateFor(l.group, value, $('inc-item').value);
      renderLines();
      return;
    }
    l[field] = value === '' ? null : Number(value);
    updateLineTotals();
  }

  const lineAmount = l => (l.rate == null || !l.qty) ? null : l.qty * effectiveRate(l.rate);
  const effectiveRate = r => $('inc-item').value === 'penalty' ? -Math.abs(r) : r;

  function updateLineTotals() {
    let total = 0;
    S.selected.forEach(l => {
      const a = lineAmount(l);
      if (a != null) total += a;
      const cell = document.querySelector(`[data-line-amount="${l.key}"]`);
      if (cell) cell.textContent = a == null ? '—' : money(a);
    });
    const t = $('inc-lines-total');
    if (t) t.textContent = `Total for ${S.selected.size} ${S.selected.size === 1 ? 'person' : 'people'}: SAR ${money(total)}`;
  }

  function renderLines() {
    const lines = [...S.selected.values()];
    const box = $('inc-lines');
    if (!lines.length) { box.innerHTML = '<div style="font-size:13px;color:var(--muted);padding:6px 0;">Tick the people above to add them.</div>'; return; }
    const isPenalty = $('inc-item').value === 'penalty';
    box.innerHTML = `
      <table>
        <thead><tr><th>Person</th><th>Group</th><th>Earned As</th><th>Rate</th><th>Qty</th><th>Amount</th><th></th></tr></thead>
        <tbody>${lines.map(l => {
          const opts = earnedOptions(l.group);
          const earned = opts.length > 1 && !isPenalty
            ? `<select class="form-input" style="min-width:130px;" onchange="incSetLine('${l.key}','earned',this.value)" aria-label="Earned as">${opts.map(([v, t]) => `<option value="${v}" ${l.earned === v ? 'selected' : ''}>${t}</option>`).join('')}</select>`
            : esc(isPenalty ? 'Penalty' : opts[0][1]);
          return `<tr>
            <td style="font-weight:600;">${esc(l.name)}</td>
            <td style="font-size:12px;">${esc(groupLabel(l.group))}</td>
            <td>${earned}</td>
            <td><input type="number" step="0.01" class="form-input" style="width:90px;" value="${l.rate == null ? '' : l.rate}" placeholder="Enter" oninput="incSetLine('${l.key}','rate',this.value)" aria-label="Rate"></td>
            <td><input type="number" min="1" step="1" class="form-input" style="width:70px;" value="${l.qty}" oninput="incSetLine('${l.key}','qty',this.value)" aria-label="Quantity"></td>
            <td data-line-amount="${l.key}" style="font-weight:600;white-space:nowrap;"></td>
            <td><button class="btn btn-sm btn-ghost" onclick="incRemoveLine('${l.key}')" aria-label="Remove ${esc(l.name)}">✕</button></td>
          </tr>`;
        }).join('')}</tbody>
      </table>
      <div id="inc-lines-total" style="font-weight:700;margin-top:10px;text-align:right;"></div>`;
    updateLineTotals();
  }

  async function userEmail() {
    try { const { data } = await dbAdmin.auth.getSession(); return data.session?.user?.email || null; }
    catch (e) { return null; }
  }

  async function saveAll() {
    clearError('inc-error');
    const lines = [...S.selected.values()];
    const date = $('inc-date').value;
    const item = $('inc-item').value;
    if (!date) return showError('inc-error', 'Please choose a date.');
    if (!lines.length) return showError('inc-error', 'Please select at least one person.');
    for (const l of lines) {
      if (l.rate == null || !isFinite(l.rate) || l.rate === 0) return showError('inc-error', `Please enter a rate for ${l.name}.`);
      if (!Number.isInteger(l.qty) || l.qty < 1) return showError('inc-error', `Please enter a whole-number quantity for ${l.name}.`);
    }
    const btn = $('inc-save');
    btn.disabled = true;
    try {
      const created_by = await userEmail();
      const ref = $('inc-ref').value.trim() || null;
      const note = $('inc-note').value.trim() || null;
      const rows = lines.map(l => ({
        entry_date: date, person_type: l.type, person_id: l.id, person_name: l.name,
        group_key: l.group || null, earned_as: l.earned, item_type: item,
        qty: l.qty, rate: effectiveRate(l.rate), booking_ref: ref, note, created_by
      }));
      const { error } = await dbAdmin.from('incentive_entries').insert(rows);
      if (error) throw error;
      closeModal('inc-modal');
      showToast(`Saved incentives for ${rows.length} ${rows.length === 1 ? 'person' : 'people'}`);
      try { logActivity('incentive_added', `Added ${itemLabel(item)} incentive for ${rows.length} people`, 'incentive', null); } catch (e) { /* log only */ }
      S.month = date.slice(0, 7);
      await fetchMonth();
      render();
    } catch (e) {
      showError('inc-error', 'Could not save: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Edit / delete ----

  function openEdit(id) {
    const e = S.entries.find(x => x.id === id);
    if (!e) return;
    ensureModals();
    S.editingId = id;
    $('inc-edit-title').textContent = `Edit: ${e.person_name} (${itemLabel(e.item_type)})`;
    $('inc-edit-date').value = e.entry_date;
    $('inc-edit-qty').value = e.qty;
    $('inc-edit-rate').value = Number(e.rate);
    $('inc-edit-ref').value = e.booking_ref || '';
    $('inc-edit-note').value = e.note || '';
    clearError('inc-edit-error');
    openModal('inc-edit-modal');
  }

  async function saveEdit() {
    clearError('inc-edit-error');
    const e = S.entries.find(x => x.id === S.editingId);
    if (!e) return;
    const date = $('inc-edit-date').value;
    const qty = Number($('inc-edit-qty').value);
    let rate = Number($('inc-edit-rate').value);
    if (!date) return showError('inc-edit-error', 'Please choose a date.');
    if (!Number.isInteger(qty) || qty < 1) return showError('inc-edit-error', 'Please enter a whole-number quantity.');
    if (!rate) return showError('inc-edit-error', 'Please enter a rate.');
    if (e.item_type === 'penalty') rate = -Math.abs(rate);
    const btn = $('inc-edit-save');
    btn.disabled = true;
    try {
      const { error } = await dbAdmin.from('incentive_entries').update({
        entry_date: date, qty, rate,
        booking_ref: $('inc-edit-ref').value.trim() || null,
        note: $('inc-edit-note').value.trim() || null
      }).eq('id', S.editingId);
      if (error) throw error;
      closeModal('inc-edit-modal');
      showToast('Incentive updated');
      await fetchMonth();
      render();
    } catch (err) {
      showError('inc-edit-error', 'Could not save: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  async function del(id) {
    const e = S.entries.find(x => x.id === id);
    if (!e || !confirm(`Delete this incentive for ${e.person_name} (SAR ${money(e.amount)})?`)) return;
    const { error } = await dbAdmin.from('incentive_entries').delete().eq('id', id);
    if (error) return showToast('Could not delete: ' + error.message, 'error');
    showToast('Incentive deleted');
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
      let rate = Number(i.value);
      if (!isFinite(rate)) { bad = true; return; }
      if (row.item_type === 'penalty') rate = -Math.abs(rate);
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
    const lines = [['Date', 'Person', 'Group', 'Type', 'Earned As', 'Booking Ref', 'Qty', 'Rate', 'Amount', 'Note'].map(cell).join(',')];
    list.slice().reverse().forEach(e => lines.push([
      e.entry_date, e.person_name, groupLabel(e.group_key), itemLabel(e.item_type), earnedLabel(e.earned_as),
      e.booking_ref, Number(e.qty), Number(e.rate), Number(e.amount), e.note
    ].map(cell).join(',')));
    lines.push('');
    lines.push(['Person', 'Group', 'Earned', 'Penalties', 'Net Payable', 'Status'].map(cell).join(','));
    summaryRows().forEach(p => lines.push([p.name, groupLabel(p.group), p.earned, p.penalties, p.net, p.paid ? 'Paid' : 'Not paid'].map(cell).join(',')));
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
    incOpenAdd: openAdd, incCommonChanged: commonChanged, incRenderPicker: renderPicker,
    incSelectShown: selectShown, incTogglePerson: togglePerson, incSetLine: setLine, incRemoveLine: removeLine,
    incSaveAll: saveAll, incOpenEdit: openEdit, incSaveEdit: saveEdit, incDelete: del,
    incTogglePaid: togglePaid, incSaveRates: saveRates, incSetPersonGroup: setPersonGroup, incExport: exportCsv
  });
})();
