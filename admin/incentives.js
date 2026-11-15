// ============================================================
// admin/incentives.js — Incentives panel of the admin dashboard.
// Admin-only: awards are entered by hand; no portal shows them.
// Uses the dashboard's globals: dbAdmin, installers, salesUsers,
// loadSales, showToast, openModal, closeModal, logActivity.
// Tables: migrations/v110_incentives.sql, v111, v112, v114_incentive_batches.sql,
// v116_incentive_auto_earnings.sql, v117_incentive_payouts.sql. A Save is a rule; money is earned in
// incentive_earnings when a booking is completed (see v116).
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
    entries: [], earnings: [], rates: [], people: [], payments: [], balances: [], payouts: [], paySel: new Set(), selected: new Map(), products: new Set(), editingBatch: null,
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

  function filteredEarnings() {
    return S.earnings.filter(e =>
      (!S.person || personKey(e.person_type, e.person_id) === S.person) &&
      (!S.group || e.person_type === S.group));
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
    // Rules whose From..To touches this month, and money earned in this month.
    const [entries, payments, earnings] = await Promise.all([
      dbAdmin.from('incentive_entries').select('*').gte('period_date', from).lt('entry_date', to)
        .order('entry_date', { ascending: false }).order('created_at', { ascending: false }),
      dbAdmin.from('incentive_payments').select('*').eq('month', from),
      dbAdmin.from('incentive_earnings').select('*').gte('earned_on', from).lt('earned_on', to)
    ]);
    if (entries.error) throw entries.error;
    if (payments.error) throw payments.error;
    if (earnings.error) throw earnings.error;
    S.entries = entries.data || [];
    S.earnings = earnings.data || [];
    S.payments = payments.data || [];
  }

  async function loadIncentives() {
    ensureModals();
    const panel = $('panel-incentives');
    panel.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div> Loading incentives...</div></div>';
    try {
      await ensureStaffLoaded();
      await Promise.all([fetchSetup(), fetchMonth()]);
      if (S.tab === 'balances' || S.tab === 'payouts') await fetchMoney();
      render();
    } catch (e) {
      panel.innerHTML = `<div class="card"><div class="empty-state"><div>Could not load incentives: ${esc(e.message)}</div>
        <div style="font-size:12px;color:var(--muted);margin-top:6px;">If this is a new setup, run migrations/v110_incentives.sql first.</div></div></div>`;
    }
  }

  function render() {
    // Rates, People and the old Monthly Summary are hidden (client request). To
    // show them again add: ['summary', 'Monthly Summary'], ['rates', 'Rates'], ['people', 'People']
    const tabs = [['entries', 'Rules'], ['balances', 'Balances'], ['payouts', 'Payouts']];
    if (!tabs.some(([k]) => k === S.tab)) S.tab = 'entries';
    const tabBtns = tabs.map(([k, l]) =>
      `<button class="btn btn-sm ${S.tab === k ? 'btn-primary' : 'btn-ghost'}" onclick="incSetTab('${k}')">${l}</button>`).join('');
    const body = {
      entries: renderEntries, summary: renderSummary, rates: renderRates, people: renderPeople,
      balances: renderBalances, payouts: renderPayouts
    }[S.tab]();
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
    const earned = new Map();
    filteredEarnings().forEach(x => earned.set(x.batch_no, (earned.get(x.batch_no) || 0) + Number(x.amount)));
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
        total: earned.get(b.no) || 0
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
    return filterBar() + kpis(totals(filteredEarnings())) + `
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Each row is a rule. Earned is added automatically when a booking with these products is completed between From and To.</div>
        ${list.length ? `<table><thead><tr><th>ID</th><th>From</th><th>To</th><th>People</th><th>Products</th><th>Per Unit Sold</th><th>Earned</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No incentives for this month yet.</div></div>'}
      </div>`;
  }
  function summaryRows() {
    const byPerson = new Map();
    filteredEarnings().forEach(e => {
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
    return filterBar() + kpis(totals(filteredEarnings())) + `
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

  // ---- Balances and payouts (v117) ----
  // Earnings are never deleted: a Pay Out links the unpaid ones to a payout,
  // so the balance starts again from zero and the history stays.

  const payLabel = n => n == null ? '—' : `PAY-${String(n).padStart(4, '0')}`;
  const METHODS = { cash: 'Cash', bank: 'Bank' };

  async function fetchMoney() {
    const [bal, pays] = await Promise.all([
      dbAdmin.from('incentive_balances').select('*'),
      dbAdmin.from('incentive_payouts').select('*, incentive_payout_lines(*)').order('payout_no', { ascending: false })
    ]);
    if (bal.error) throw bal.error;
    if (pays.error) throw pays.error;
    S.balances = (bal.data || []).map(b => ({ ...b, key: personKey(b.person_type, b.person_id) }));
    S.payouts = pays.data || [];
    S.paySel = new Set([...S.paySel].filter(k => S.balances.some(b => b.key === k && Number(b.balance) > 0)));
  }

  const tile = (text, value, color) => `
    <div class="stat-card" style="border-top:3px solid ${color};">
      <div class="stat-value" style="color:${color};font-size:22px;">SAR ${money(value)}</div>
      <div class="stat-label">${text}</div>
    </div>`;

  function shownBalances() {
    return S.balances.filter(b => !S.group || b.person_type === S.group)
      .sort((a, b) => String(a.person_name).localeCompare(String(b.person_name)));
  }

  function renderBalances() {
    const list = shownBalances();
    const sum = k => list.reduce((s, b) => s + Number(b[k] || 0), 0);
    const chosen = list.filter(b => S.paySel.has(b.key));
    const groupOpts = ACCOUNTS.map(g => `<option value="${g.key}" ${S.group === g.key ? 'selected' : ''}>${esc(g.label)}</option>`).join('');
    const rows = list.map(b => {
      const due = Number(b.balance);
      return `<tr>
        <td>${due > 0 ? `<input type="checkbox" ${S.paySel.has(b.key) ? 'checked' : ''} onchange="incPickPay('${esc(b.key)}',this.checked)" aria-label="Pay ${esc(b.person_name)}">` : ''}</td>
        <td><a href="#" onclick="incHistory('${esc(b.key)}');return false;" style="text-decoration:none;" title="See history">${personChip(b.person_name)}</a></td>
        <td>${esc(accountLabel(b.person_type))}</td>
        <td style="white-space:nowrap;">SAR ${money(b.earned)}</td>
        <td style="white-space:nowrap;">SAR ${money(b.paid)}</td>
        <td style="white-space:nowrap;font-weight:700;${due < 0 ? 'color:#B71C1C;' : ''}">SAR ${money(due)}</td>
      </tr>`;
    }).join('');
    return `
      <div class="filter-bar" style="padding:16px 20px 0;">
        <select class="form-input" style="max-width:220px;" onchange="incSetGroup(this.value)" aria-label="Group"><option value="">All groups</option>${groupOpts}</select>
        <button class="btn btn-ghost btn-sm" onclick="incPickAllDue()">Select all with balance</button>
        <button class="btn btn-primary btn-sm" onclick="incOpenPay()" ${chosen.length ? '' : 'disabled'}>Pay Out${chosen.length ? ` (${chosen.length})` : ''}</button>
      </div>
      <div class="stat-grid" style="padding:16px 20px 0;margin-bottom:0;">
        ${tile('Earned', sum('earned'), '#0F766E')}${tile('Paid', sum('paid'), '#2563EB')}${tile('Balance Due', sum('balance'), '#D97706')}
      </div>
      <div style="padding:16px 20px 20px;overflow-x:auto;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">All time. Click a name to see their history. After paying people, tick them and press Pay Out.</div>
        ${list.length ? `<table><thead><tr><th></th><th>Person</th><th>Group</th><th>Earned</th><th>Paid</th><th>Balance Due</th></tr></thead><tbody>${rows}</tbody></table>`
        : '<div class="empty-state"><div>No incentives earned yet.</div></div>'}
      </div>`;
  }

  function pickPay(key, on) { if (on) S.paySel.add(key); else S.paySel.delete(key); render(); }

  function pickAllDue() {
    shownBalances().forEach(b => { if (Number(b.balance) > 0) S.paySel.add(b.key); });
    render();
  }

  async function history(key) {
    const b = S.balances.find(x => x.key === key);
    if (!b) return;
    const { data, error } = await dbAdmin.from('incentive_earnings')
      .select('earned_on, product_name, qty, rate, amount, adjustment, payout_id, bookings(booking_reference)')
      .eq('person_type', b.person_type).eq('person_id', b.person_id).order('earned_on', { ascending: false });
    if (error) return showToast('Could not load history: ' + error.message, 'error');
    const payNo = id => (S.payouts.find(p => p.id === id) || {}).payout_no;
    const rows = (data || []).map(e => `<tr>
      <td style="white-space:nowrap;">${dmy(e.earned_on)}</td>
      <td style="white-space:nowrap;">${esc(e.bookings?.booking_reference || '—')}</td>
      <td>${esc(e.product_name)}${e.adjustment ? ' <span style="font-size:11px;color:var(--muted);">(correction)</span>' : ''}</td>
      <td style="white-space:nowrap;font-weight:600;">SAR ${money(e.amount)}</td>
      <td style="white-space:nowrap;">${e.payout_id ? `Paid · ${payLabel(payNo(e.payout_id))}` : '<span style="color:#D97706;font-weight:600;">Unpaid</span>'}</td>
    </tr>`).join('');
    showInfoModal(`${b.person_name} · Balance due SAR ${money(b.balance)}`, rows
      ? `<div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Date</th><th>Booking</th><th>Product</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`
      : '<div class="empty-state">No incentives yet.</div>');
  }

  function ensurePayModal() {
    if ($('inc-pay-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div class="modal-overlay" id="inc-pay-modal">
        <div class="modal" style="max-width:560px;width:100%;max-height:92vh;overflow-y:auto;">
          <h2 class="modal-title">Pay Out Incentives</h2>
          <div id="inc-pay-list" style="overflow-x:auto;"></div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:0 12px;margin-top:12px;">
            <div class="form-group"><label>Paid On</label><input type="date" class="form-input" id="inc-pay-date"></div>
            <div class="form-group"><label>Method</label><select class="form-input" id="inc-pay-method"><option value="cash">Cash</option><option value="bank">Bank</option></select></div>
          </div>
          <div class="form-group"><label>Note <span style="color:var(--muted);font-weight:400;">(optional)</span></label><input type="text" class="form-input" id="inc-pay-note" maxlength="300"></div>
          <div id="inc-pay-error" style="display:none;background:#FEF2F2;border:1px solid #FECACA;color:#B71C1C;padding:12px;border-radius:10px;font-size:13px;margin-top:8px;"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="closeModal('inc-pay-modal')">Cancel</button>
            <button class="btn btn-primary" id="inc-pay-save" onclick="incSavePay()">Confirm Pay Out</button>
          </div>
        </div>
      </div>`);
  }

  const payChosen = () => S.balances.filter(b => S.paySel.has(b.key) && Number(b.balance) > 0);

  function openPay() {
    const chosen = payChosen();
    if (!chosen.length) return showToast('Tick at least one person with a balance.', 'error');
    ensurePayModal();
    const total = chosen.reduce((s, b) => s + Number(b.balance), 0);
    $('inc-pay-list').innerHTML = `<table style="width:100%;"><thead><tr><th>Person</th><th>Group</th><th>Amount</th></tr></thead><tbody>
      ${chosen.map(b => `<tr><td>${personChip(b.person_name)}</td><td>${esc(accountLabel(b.person_type))}</td><td style="font-weight:600;white-space:nowrap;">SAR ${money(b.balance)}</td></tr>`).join('')}
      </tbody></table><div style="font-weight:700;text-align:right;margin-top:8px;">Total: SAR ${money(total)}</div>`;
    $('inc-pay-date').value = today;
    $('inc-pay-method').value = 'cash';
    $('inc-pay-note').value = '';
    clearError('inc-pay-error');
    openModal('inc-pay-modal');
  }

  async function savePay() {
    clearError('inc-pay-error');
    const chosen = payChosen();
    const date = $('inc-pay-date').value;
    if (!chosen.length) return showError('inc-pay-error', 'Nobody to pay.');
    if (!date) return showError('inc-pay-error', 'Please choose the date paid.');
    const btn = $('inc-pay-save');
    btn.disabled = true;
    try {
      const { data: no, error } = await dbAdmin.rpc('create_incentive_payout', {
        p_people: chosen.map(b => ({ person_type: b.person_type, person_id: b.person_id })),
        p_paid_on: date, p_method: $('inc-pay-method').value, p_note: $('inc-pay-note').value
      });
      if (error) throw error;
      closeModal('inc-pay-modal');
      showToast(`Saved ${payLabel(no)}`);
      try { logActivity('incentive_paid', `Paid out ${payLabel(no)} to ${chosen.length} people`, 'incentive', String(no)); } catch (e) { /* log only */ }
      S.paySel = new Set();
      await fetchMoney();
      render();
    } catch (e) {
      showError('inc-pay-error', 'Could not save: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  }

  function renderPayouts() {
    const rows = S.payouts.map(p => {
      const lines = p.incentive_payout_lines || [];
      const off = !!p.cancelled_at;
      return `<tr style="${off ? 'opacity:.55;' : ''}">
        <td style="font-weight:700;white-space:nowrap;">${payLabel(p.payout_no)}</td>
        <td style="white-space:nowrap;">${dmy(p.paid_on)}</td>
        <td style="min-width:180px;">${lines.map(l => personChip(l.person_name)).join('')}</td>
        <td style="font-weight:700;white-space:nowrap;">SAR ${money(p.amount)}</td>
        <td>${esc(METHODS[p.method] || p.method)}</td>
        <td style="font-size:12px;">${esc(p.paid_by || '—')}</td>
        <td>${off ? '<span style="color:#B71C1C;font-weight:600;">Cancelled</span>' : '<span style="color:#166534;font-weight:600;">Paid</span>'}</td>
        <td><div style="display:flex;gap:6px;">
          <button class="btn btn-sm btn-ghost" onclick="incViewPay(${Number(p.payout_no)})">View</button>
          ${off ? '' : `<button class="btn btn-sm btn-ghost" onclick="incPrintPay(${Number(p.payout_no)})">Print Slip</button>
          <button class="btn btn-sm btn-danger" onclick="incCancelPay(${Number(p.payout_no)})">Cancel</button>`}
        </div></td>
      </tr>`;
    }).join('');
    return `<div style="padding:16px 20px 20px;overflow-x:auto;">
      ${S.payouts.length ? `<table><thead><tr><th>Payout</th><th>Date</th><th>People</th><th>Amount</th><th>Method</th><th>Paid By</th><th>Status</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<div class="empty-state"><div>No payouts yet. Use the Balances tab to pay people.</div></div>'}
    </div>`;
  }

  const findPay = no => S.payouts.find(x => Number(x.payout_no) === Number(no));

  function viewPay(no) {
    const p = findPay(no);
    if (!p) return;
    const lines = p.incentive_payout_lines || [];
    showInfoModal(`${payLabel(no)} · ${dmy(p.paid_on)} · ${METHODS[p.method] || p.method}`, `
      <table class="data-table" style="width:100%;"><thead><tr><th>Person</th><th>Group</th><th>Amount</th></tr></thead><tbody>
        ${lines.map(l => `<tr><td>${personChip(l.person_name)}</td><td>${esc(accountLabel(l.person_type))}</td><td style="font-weight:600;white-space:nowrap;">SAR ${money(l.amount)}</td></tr>`).join('')}
      </tbody></table>
      <div style="font-weight:700;text-align:right;margin-top:10px;">Total: SAR ${money(p.amount)}</div>
      ${p.note ? `<div style="margin-top:8px;font-size:13px;"><strong>Note:</strong> ${esc(p.note)}</div>` : ''}
      <div style="margin-top:8px;font-size:12px;color:var(--muted);">Paid by ${esc(p.paid_by || '—')}${p.cancelled_at ? ` · Cancelled by ${esc(p.cancelled_by || '—')}` : ''}</div>`);
  }

  async function cancelPay(no) {
    const p = findPay(no);
    if (!p) return;
    if (!confirm(`Cancel ${payLabel(no)} (SAR ${money(p.amount)})? Its incentives become unpaid again. It stays in the list as Cancelled.`)) return;
    const { error } = await dbAdmin.rpc('cancel_incentive_payout', { p_payout_no: Number(no) });
    if (error) return showToast('Could not cancel: ' + error.message, 'error');
    showToast(`Cancelled ${payLabel(no)}`);
    try { logActivity('incentive_payout_cancelled', `Cancelled ${payLabel(no)}`, 'incentive', String(no)); } catch (e) { /* log only */ }
    await fetchMoney();
    render();
  }

  async function printPay(no) {
    const p = findPay(no);
    if (!p) return;
    const w = window.open('', '_blank');   // open before waiting, so it is not blocked as a pop-up
    if (!w) return showToast('Please allow pop-ups to print the slip', 'error');
    const { data, error } = await dbAdmin.from('incentive_earnings')
      .select('person_type, person_id, earned_on, product_name, qty, amount, adjustment, bookings(booking_reference)')
      .eq('payout_id', p.id).order('earned_on');
    if (error) { w.close(); return showToast('Could not load the slip: ' + error.message, 'error'); }
    const blocks = (p.incentive_payout_lines || []).map(l => {
      const mine = (data || []).filter(e => e.person_type === l.person_type && e.person_id === l.person_id);
      return `<div class="person">
        <h2>${esc(l.person_name)} <span>${esc(accountLabel(l.person_type))}</span></h2>
        <table><thead><tr><th>Date</th><th>Booking</th><th>Product</th><th>Qty</th><th>Amount</th></tr></thead><tbody>
          ${mine.map(e => `<tr><td>${dmy(e.earned_on)}</td><td>${esc(e.bookings?.booking_reference || '—')}</td><td>${esc(e.product_name)}${e.adjustment ? ' (correction)' : ''}</td><td>${e.qty}</td><td>SAR ${money(e.amount)}</td></tr>`).join('')}
        </tbody></table>
        <div class="total">Total received: SAR ${money(l.amount)}</div>
        <div class="sign"><div>Received by: ____________________</div><div>Signature: ____________________</div><div>Date: ____________</div></div>
      </div>`;
    }).join('');
    w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${payLabel(no)} — Incentive Slip</title>
<style>
  body{font-family:Arial,sans-serif;color:#0A1628;margin:24px;} h1{color:#0D3B6E;margin:0 0 4px;font-size:22px;}
  .meta{color:#607D8B;font-size:13px;margin-bottom:16px;} .actions{margin-bottom:16px;}
  .actions button{background:#0D3B6E;color:#fff;border:none;padding:8px 16px;border-radius:8px;font-weight:700;cursor:pointer;margin-right:8px;}
  .person{border:1px solid #E2E8F0;border-radius:10px;padding:14px 16px;margin-bottom:16px;page-break-inside:avoid;}
  h2{font-size:16px;margin:0 0 8px;} h2 span{font-size:12px;color:#607D8B;font-weight:400;}
  table{width:100%;border-collapse:collapse;font-size:12px;} th,td{border-bottom:1px solid #EEF2F6;padding:6px;text-align:left;}
  th{color:#607D8B;font-size:10px;text-transform:uppercase;} .total{font-weight:700;text-align:right;margin:8px 0;}
  .sign{display:flex;gap:24px;flex-wrap:wrap;margin-top:18px;font-size:13px;}
  @media print{.actions{display:none;} body{margin:10mm;}}
</style></head><body>
  <div class="actions"><button onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button></div>
  <h1>SA'DA H2O — Incentive Payment ${payLabel(no)}</h1>
  <div class="meta">Paid on ${dmy(p.paid_on)} · ${esc(METHODS[p.method] || p.method)} · Total SAR ${money(p.amount)}${p.note ? ' · ' + esc(p.note) : ''}</div>
  ${blocks}
</body></html>`);
    w.document.close();
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
            <div class="form-group"><label>To</label><input type="date" class="form-input" id="inc-end"></div>
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
    const value = S.amountValue;
    const amount = !(value > 0) ? '—' : S.amountMode === 'percent' ? `${value}%` : `SAR ${money(value)}`;
    const missing = missingPrices();
    const names = (label, chips) => `<div style="margin-top:8px;"><div style="font-size:12px;color:var(--muted);font-weight:600;margin-bottom:2px;">${label}</div>${chips}</div>`;
    box.innerHTML = `
      <table>
        <thead><tr><th>Products</th><th>People</th><th>Per Unit Sold</th></tr></thead>
        <tbody><tr>
          <td>${products.length}</td>
          <td>${people.length}</td>
          <td style="font-weight:700;">${esc(amount)}</td>
        </tr></tbody>
      </table>
      ${S.amountMode === 'percent' && value > 0 ? names('Per unit sold, from list price', chosenProducts().map((p, i) => {
        const r = percentOf(S.catalog.get(p.name), value);
        return chip(`${p.name}: ${r == null ? 'no price' : 'SAR ' + money(r)}`, PRODUCTS.indexOf(p) + 3);
      }).join('')) : ''}
      <div style="font-size:12px;color:var(--muted);margin-top:8px;">Each person earns this for every unit they sell or install, when the booking is completed between From and To.</div>
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
    if (!end) return showError('inc-error', 'Please choose a To date.');
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
      <div style="overflow-x:auto;"><table class="data-table" style="width:100%;"><thead><tr><th>Person</th><th>Product</th><th>Per Unit Sold</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div style="font-weight:700;text-align:right;margin-top:10px;">Earned this month: SAR ${money(totals(S.earnings.filter(x => x.batch_no === b.no)).net)}</div>`);
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
    if (!confirm(`Delete rule ${idLabel(b.no)} (${n} ${n === 1 ? 'entry' : 'entries'})? Incentives it earned will be removed too. This cannot be undone.`)) return;
    // Deleting a rule also removes what it earned (v116 recalculates bookings).
    const { error } = b.no == null
      ? await dbAdmin.from('incentive_entries').delete().in('id', b.entries.map(e => e.id))
      : await dbAdmin.rpc('delete_incentive_batch', { p_batch_no: b.no });
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
    const lines = [['ID', 'From', 'To', 'Person', 'Group', 'Type', 'Percent', 'Per Unit Sold'].map(cell).join(',')];
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
    incSetTab: async t => {
      S.tab = t;
      if (t === 'balances' || t === 'payouts') {
        try { await fetchMoney(); } catch (e) { showToast('Could not load: ' + e.message + '. Run migration v117_incentive_payouts.sql first.', 'error'); S.tab = 'entries'; }
      }
      render();
    },
    incSetGroup: g => { S.group = g; render(); },
    incPickPay: pickPay, incPickAllDue: pickAllDue, incOpenPay: openPay, incSavePay: savePay, incHistory: history,
    incViewPay: viewPay, incPrintPay: printPay, incCancelPay: cancelPay,
    incSetMonth: async m => { if (!m) return; S.month = m; try { await fetchMonth(); render(); } catch (e) { showToast(e.message, 'error'); } },
    incSetFilter: (k, v) => { S[k] = v; render(); },
    incOpenAdd: openAdd, incAddProduct: addProduct, incRemoveProduct: removeProduct, incRenderPicker: renderPicker,
    incSelectShown: selectShown, incTogglePerson: togglePerson,
    incSetAmount: setAmount, incSetAmountMode: setAmountMode,
    incSaveAll: saveAll, incOpenEdit: openEdit, incView: view, incDelete: del,
    incTogglePaid: togglePaid, incSaveRates: saveRates, incSetPersonGroup: setPersonGroup, incExport: exportCsv
  });
})();
