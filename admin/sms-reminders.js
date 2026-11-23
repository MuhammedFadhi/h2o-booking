// ============================================================
// admin/sms-reminders.js — "SMS Reminders" panel (admin only).
// Reminds customers 7 days before a unit's filter change, annual service or
// warranty end. Each reminder (unit + type + due date) is sent only once;
// every send, failure and skip is saved in reminder_sms_log
// (migrations/v123_reminder_sms_log.sql).
// Manual for now ("Send now"); the same list can later be sent by a daily job.
// Uses the dashboard's globals: dbAdmin, showToast, showInfoModal,
// sendAdminSMS, isSMSEnabled, logActivity, window.SADA.Warranty.
// ============================================================
(function () {
  const DAYS_BEFORE = 7;
  const KINDS = {
    filter:   { label: 'Filter change',  icon: '🔧', field: 'filter_expiry',   bg: '#DBEAFE', fg: '#1E40AF' },
    service:  { label: 'Annual service', icon: '🛠', field: 'service_expiry',  bg: '#EDE9FE', fg: '#5B21B6' },
    warranty: { label: 'Warranty ends',  icon: '🛡', field: 'warranty_expiry', bg: '#FEF3C7', fg: '#92400E' }
  };
  // SMS text per type. {name} {unit} {date} are filled in. (Final wording to come from the client.)
  const TEXTS = {
    filter:   "SA'DA H₂O: Dear {name}, the filter of your {unit} is due for change on {date}. Call 920022569 to book a visit.",
    service:  "SA'DA H₂O: Dear {name}, the annual service of your {unit} is due on {date}. Call 920022569 to book a visit.",
    warranty: "SA'DA H₂O: Dear {name}, the warranty of your {unit} ends on {date}. Call 920022569 for service plans."
  };

  const S = { tab: 'send', show: 'today', kind: '', q: '', rows: [], done: new Set(), today: [], selected: new Set(), busy: false,
              hist: [], hFrom: '', hTo: '', hKind: '', hStatus: '',
              hView: 'campaigns', camps: [], hCamp: null };
  const campNo = n => n == null ? '—' : `CMP-${String(n).padStart(4, '0')}`;
  const $ = id => document.getElementById(id);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dmy = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';
  // Due day as a local calendar date (dates stored with a time can fall on the
  // next day in Saudi time), and whole days from today to it.
  const pad = n => String(n).padStart(2, '0');
  const localDay = v => {
    if (!v) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return String(v);
    const d = new Date(v);
    return isNaN(d) ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  const todayDay = () => localDay(new Date().toISOString());
  const daysUntil = day => day ? Math.round((new Date(day + 'T00:00:00') - new Date(todayDay() + 'T00:00:00')) / 86400000) : null;
  const plusDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return localDay(d.toISOString()); };
  const keyOf = (id, kind, due) => `${id}|${kind}|${String(due).slice(0, 10)}`;
  const kindChip = k => `<span style="display:inline-block;background:${KINDS[k].bg};color:${KINDS[k].fg};border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;white-space:nowrap;">${KINDS[k].icon} ${KINDS[k].label}</span>`;
  const statusChip = s => ({
    sent: '<span style="color:#15803D;font-weight:700;">✅ Sent</span>',
    failed: '<span style="color:#B91C1C;font-weight:700;">❌ Failed</span>',
    skipped: '<span style="color:#64748B;font-weight:700;">⏭ Skipped</span>'
  }[s] || esc(s));
  const textFor = r => TEXTS[r.kind]
    .replace('{name}', r.name || 'Customer').replace('{unit}', r.product || 'RO unit').replace('{date}', dmy(r.due));
  const localMidnightISO = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

  async function pages(build) {
    const out = [];
    for (let start = 0; ; start += 1000) {
      const { data, error } = await build().range(start, start + 999);
      if (error) throw error;
      out.push(...(data || []));
      if (!data || data.length < 1000) return out;
    }
  }

  // Everything due: active units, not opted out, each type with a date, not already sent/skipped.
  async function fetchToSend() {
    const [units, done, today] = await Promise.all([
      pages(() => dbAdmin.from('warranties')
        .select('id, product_type, status, service_opted_out, filter_expiry, service_expiry, warranty_expiry, customers(name, phone)')
        .eq('status', 'active').order('id')),
      pages(() => dbAdmin.from('reminder_sms_log').select('warranty_id, kind, due_date').in('status', ['sent', 'skipped']).order('id')),
      pages(() => dbAdmin.from('reminder_sms_log').select('status').gte('created_at', localMidnightISO()).order('id'))
    ]);
    S.done = new Set(done.map(d => keyOf(d.warranty_id, d.kind, d.due_date)));
    S.today = today;
    S.rows = [];
    units.forEach(u => {
      if (u.service_opted_out) return;
      Object.keys(KINDS).forEach(kind => {
        const due = localDay(u[KINDS[kind].field]);
        const days = daysUntil(due);
        if (days === null || days > DAYS_BEFORE * 2) return;
        const key = keyOf(u.id, kind, due);
        if (S.done.has(key)) return;
        // today = due in exactly 7 days (the normal send day); due = 0–6 days, missed;
        // overdue = date passed, never reminded; next = 8–14 days, not yet.
        S.rows.push({ key, id: u.id, kind, due, days, product: u.product_type || '',
          name: u.customers?.name || '', phone: u.customers?.phone || '',
          bucket: days < 0 ? 'overdue' : days === DAYS_BEFORE ? 'today' : days < DAYS_BEFORE ? 'due' : 'next' });
      });
    });
    S.rows.sort((a, b) => a.days - b.days);
    // Ticked by default: everything due within 7 days that has a phone.
    S.selected = new Set(S.rows.filter(r => r.bucket === 'today' && r.phone).map(r => r.key));
    setBadge(S.rows.filter(r => r.bucket === 'today' && r.phone).length);
  }

  function setBadge(n) {
    const el = $('nav-reminders-count');
    if (!el) return;
    el.textContent = n || '';
    el.style.display = n ? '' : 'none';
  }

  function shownRows() {
    const q = S.q.trim().toLowerCase();
    return S.rows.filter(r =>
      (S.show === 'week' ? (r.bucket === 'today' || r.bucket === 'due') : r.bucket === S.show) &&
      (!S.kind || r.kind === S.kind) &&
      (!q || `${r.name} ${r.phone} ${r.product}`.toLowerCase().includes(q)));
  }

  function tiles() {
    const c = b => S.rows.filter(r => r.bucket === b && (b === 'next' || r.phone)).length;
    const noPhone = S.rows.filter(r => r.bucket !== 'next' && !r.phone).length;
    const t = s => S.today.filter(r => r.status === s).length;
    const tile = (n, label, color, show) => `
      <div class="stat-card" style="border-top:3px solid ${color};${show ? 'cursor:pointer;' : ''}" ${show ? `onclick="remShow('${show}')"` : ''}>
        <div class="stat-value" style="color:${color};font-size:24px;">${n}</div><div class="stat-label">${label}</div>
      </div>`;
    return `<div class="stat-grid" style="padding:16px 20px 0;margin-bottom:0;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));">
      ${tile(c('today'), `To send today (due ${dmy(plusDays(DAYS_BEFORE))})`, '#0F766E', 'today')}
      ${tile(c('due'), 'Due within 7 days, not reminded', '#7C3AED', 'week')}
      ${tile(c('overdue'), 'Overdue, never reminded', '#B91C1C', 'overdue')}
      ${tile(t('sent'), 'Sent today', '#2563EB')}
      ${tile(t('failed'), 'Failed today', '#DC2626')}
      ${tile(t('skipped'), 'Skipped today', '#64748B')}
      ${tile(c('next'), 'Coming in next 7 days', '#D97706', 'next')}
    </div>
    ${noPhone ? `<div style="padding:8px 20px 0;font-size:12px;color:#B91C1C;">${noPhone} reminder(s) can't be sent: no phone number. Add the phone in Customers, or Skip them.</div>` : ''}`;
  }

  function sendTab() {
    const rows = shownRows();
    const sel = rows.filter(r => S.selected.has(r.key));
    const allOn = rows.length && rows.filter(r => r.phone).every(r => S.selected.has(r.key));
    const body = rows.map(r => `
      <tr>
        <td><input type="checkbox" ${S.selected.has(r.key) ? 'checked' : ''} ${r.phone ? '' : 'disabled'} onchange="remPick('${esc(r.key)}',this.checked)"></td>
        <td style="font-weight:600;">${esc(r.name || '—')}</td>
        <td style="white-space:nowrap;">${r.phone ? esc(r.phone) : '<span style="color:#B91C1C;">No phone</span>'}</td>
        <td>${esc(r.product || '—')}</td>
        <td>${kindChip(r.kind)}</td>
        <td style="white-space:nowrap;">${dmy(r.due)}</td>
        <td style="white-space:nowrap;font-weight:700;color:${r.days < 0 ? '#B91C1C' : r.days <= DAYS_BEFORE ? '#0F766E' : '#D97706'};">${r.days < 0 ? `${-r.days}d late` : r.days === 0 ? 'Today' : `${r.days}d`}</td>
        <td><div style="display:flex;gap:6px;">
          ${r.phone && r.bucket !== 'next' ? `<button class="btn btn-sm btn-ghost" onclick="remSendOne('${esc(r.key)}')">Send</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="remSkip('${esc(r.key)}')">Skip</button>
        </div></td>
      </tr>`).join('');
    const preview = textFor(sel[0] || rows[0] || { kind: S.kind || 'filter', name: 'Customer', product: 'RO unit', due: '' });
    return `
      <div class="filter-bar" style="padding:16px 20px 0;">
        <select class="form-input" style="max-width:240px;" onchange="remShow(this.value)" aria-label="Show">
          <option value="today" ${S.show === 'today' ? 'selected' : ''}>Send today: due on ${dmy(plusDays(DAYS_BEFORE))}</option>
          <option value="week" ${S.show === 'week' ? 'selected' : ''}>Due from today to ${dmy(plusDays(DAYS_BEFORE))}</option>
          <option value="overdue" ${S.show === 'overdue' ? 'selected' : ''}>Overdue, never reminded</option>
          <option value="next" ${S.show === 'next' ? 'selected' : ''}>Coming in next 7 days (not yet)</option>
        </select>
        <select class="form-input" style="max-width:180px;" onchange="remKind(this.value)" aria-label="Type">
          <option value="">All types</option>
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${S.kind === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}
        </select>
        <input class="form-input" style="max-width:220px;" placeholder="Search name / phone / unit" value="${esc(S.q)}" oninput="remSearch(this.value)">
        <button class="btn btn-primary btn-sm" id="rem-send-btn" ${sel.length && !S.busy ? '' : 'disabled'} onclick="remSendSelected()">📨 Send now (${sel.length})</button>
      </div>
      <div style="padding:12px 20px 0;font-size:12px;color:var(--muted);">
        Each reminder is sent only once. Units opted out of reminders are not listed.
        <div style="margin-top:6px;background:var(--bg,#F8FAFC);border-radius:8px;padding:8px 12px;color:var(--text);"><b>Message preview:</b> ${esc(preview)}</div>
      </div>
      <div style="padding:12px 20px 20px;overflow-x:auto;">
        ${rows.length ? `<table><thead><tr>
          <th><input type="checkbox" ${allOn ? 'checked' : ''} onchange="remPickAll(this.checked)" title="Select all"></th>
          <th>Customer</th><th>Phone</th><th>Unit</th><th>Reminder</th><th>Due date</th><th>Days</th><th>Actions</th>
        </tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty-state"><div>Nothing to send here. 🎉</div></div>'}
      </div>`;
  }

  async function fetchHistory() {
    if (S.hView === 'campaigns') {
      let c = dbAdmin.from('reminder_sms_campaign_summary').select('*').order('created_at', { ascending: false }).limit(500);
      if (S.hFrom) c = c.gte('created_at', new Date(S.hFrom + 'T00:00:00').toISOString());
      if (S.hTo) { const t = new Date(S.hTo + 'T00:00:00'); t.setDate(t.getDate() + 1); c = c.lt('created_at', t.toISOString()); }
      const { data, error } = await c;
      if (error) throw error;
      S.camps = data || [];
      return;
    }
    let q = dbAdmin.from('reminder_sms_log').select('*, reminder_sms_campaigns(campaign_no)').order('created_at', { ascending: false }).limit(1000);
    if (S.hCamp) q = q.eq('campaign_id', S.hCamp.id);
    if (S.hFrom) q = q.gte('created_at', new Date(S.hFrom + 'T00:00:00').toISOString());
    if (S.hTo) { const t = new Date(S.hTo + 'T00:00:00'); t.setDate(t.getDate() + 1); q = q.lt('created_at', t.toISOString()); }
    if (S.hKind) q = q.eq('kind', S.hKind);
    if (S.hStatus) q = q.eq('status', S.hStatus);
    const { data, error } = await q;
    if (error) throw error;
    S.hist = data || [];
  }

  const when = s => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  // History, view 1: one line per press of Send (a campaign).
  function campaignsView() {
    const mix = c => [['filter', c.filter_count], ['service', c.service_count], ['warranty', c.warranty_count]]
      .filter(([, n]) => n > 0).map(([k, n]) => `${KINDS[k].icon} ${KINDS[k].label} ×${n}`).join(', ') || '—';
    const body = S.camps.map((c, i) => `
      <tr>
        <td style="font-weight:700;white-space:nowrap;">${campNo(c.campaign_no)}</td>
        <td style="white-space:nowrap;">${when(c.created_at)}</td>
        <td>${esc(mix(c))}</td>
        <td>${c.total}</td>
        <td style="color:#15803D;font-weight:700;">${c.sent}</td>
        <td style="color:${c.failed ? '#B91C1C' : 'inherit'};font-weight:700;">${c.failed}</td>
        <td>${esc(c.sent_by || '—')}</td>
        <td><button class="btn btn-sm btn-ghost" onclick="remOpenCamp(${i})">View</button></td>
      </tr>`).join('');
    return `
      <div class="filter-bar" style="padding:16px 20px 0;">
        <input type="date" class="form-input" style="max-width:160px;" value="${S.hFrom}" onchange="remHist('hFrom',this.value)" aria-label="From">
        <input type="date" class="form-input" style="max-width:160px;" value="${S.hTo}" onchange="remHist('hTo',this.value)" aria-label="To">
      </div>
      <div style="padding:12px 20px 20px;overflow-x:auto;">
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">One line each time Send was pressed. View shows every SMS in it.</div>
        ${S.camps.length ? `<table><thead><tr><th>Campaign</th><th>Sent on</th><th>Reminders</th><th>Total</th><th>Sent</th><th>Failed</th><th>By</th><th></th></tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty-state"><div>No campaigns yet.</div></div>'}
      </div>`;
  }

  function historyTab() {
    const switcher = `<div style="display:flex;gap:6px;padding:16px 20px 0;">
        <button class="btn btn-sm ${S.hView === 'campaigns' ? 'btn-primary' : 'btn-ghost'}" onclick="remHView('campaigns')">By campaign</button>
        <button class="btn btn-sm ${S.hView === 'each' ? 'btn-primary' : 'btn-ghost'}" onclick="remHView('each')">Each SMS</button>
      </div>`;
    if (S.hView === 'campaigns') return switcher + campaignsView();
    return switcher + eachView();
  }

  // History, view 2: every single SMS (optionally only one campaign's).
  function eachView() {
    const body = S.hist.map((h, i) => `
      <tr style="cursor:pointer;" onclick="remShowMsg(${i})">
        <td style="white-space:nowrap;">${when(h.created_at)}</td>
        <td style="font-weight:600;">${esc(h.customer_name || '—')}</td>
        <td style="white-space:nowrap;">${esc(h.phone || '—')}</td>
        <td>${esc(h.product || '—')}</td>
        <td>${KINDS[h.kind] ? kindChip(h.kind) : esc(h.kind)}</td>
        <td style="white-space:nowrap;">${dmy(h.due_date)}</td>
        <td style="white-space:nowrap;">${statusChip(h.status)}${h.reason ? `<div style="font-size:11px;color:var(--muted);">${esc(h.reason)}</div>` : ''}</td>
        <td style="white-space:nowrap;">${campNo(h.reminder_sms_campaigns?.campaign_no)}</td>
        <td>${esc(h.sent_by || '—')}</td>
      </tr>`).join('');
    return `
      <div class="filter-bar" style="padding:16px 20px 0;">
        <input type="date" class="form-input" style="max-width:160px;" value="${S.hFrom}" onchange="remHist('hFrom',this.value)" aria-label="From">
        <input type="date" class="form-input" style="max-width:160px;" value="${S.hTo}" onchange="remHist('hTo',this.value)" aria-label="To">
        <select class="form-input" style="max-width:180px;" onchange="remHist('hKind',this.value)" aria-label="Type">
          <option value="">All types</option>
          ${Object.entries(KINDS).map(([k, v]) => `<option value="${k}" ${S.hKind === k ? 'selected' : ''}>${v.icon} ${v.label}</option>`).join('')}
        </select>
        <select class="form-input" style="max-width:150px;" onchange="remHist('hStatus',this.value)" aria-label="Status">
          <option value="">All status</option>
          ${['sent', 'failed', 'skipped'].map(s => `<option value="${s}" ${S.hStatus === s ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}
        </select>
        <button class="btn btn-ghost btn-sm" onclick="remExport()">⬇ Excel</button>
      </div>
      <div style="padding:12px 20px 20px;overflow-x:auto;">
        ${S.hCamp ? `<div style="margin-bottom:8px;font-weight:700;">Showing ${campNo(S.hCamp.campaign_no)} only · <a href="#" onclick="remOpenCamp(-1);return false;">show all SMS</a></div>` : ''}
        <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">Newest first (up to 1000). Click a row to see the exact message.</div>
        ${S.hist.length ? `<table><thead><tr><th>Date</th><th>Customer</th><th>Phone</th><th>Unit</th><th>Reminder</th><th>Due date</th><th>Status</th><th>Campaign</th><th>By</th></tr></thead><tbody>${body}</tbody></table>`
        : '<div class="empty-state"><div>No reminder SMS yet.</div></div>'}
      </div>`;
  }

  function render() {
    const panel = $('panel-reminders');
    if (!panel) return;
    panel.innerHTML = `<div class="card">
      <div class="card-header"><span class="card-title">SMS Reminders</span>
        <button class="btn btn-ghost btn-sm" onclick="loadSmsReminders()">⟳ Refresh</button></div>
      <div style="display:flex;gap:6px;padding:16px 20px 0;">
        <button class="btn btn-sm ${S.tab === 'send' ? 'btn-primary' : 'btn-ghost'}" onclick="remTab('send')">To send</button>
        <button class="btn btn-sm ${S.tab === 'history' ? 'btn-primary' : 'btn-ghost'}" onclick="remTab('history')">History</button>
      </div>
      ${tiles()}
      ${S.tab === 'send' ? sendTab() : historyTab()}
    </div>`;
  }

  async function load() {
    const panel = $('panel-reminders');
    if (panel) panel.innerHTML = '<div class="card"><div class="loading"><div class="spinner"></div> Loading reminders...</div></div>';
    try {
      await fetchToSend();
      if (S.tab === 'history') await fetchHistory();
      render();
    } catch (e) {
      if (panel) panel.innerHTML = `<div class="card"><div class="empty-state">⚠️ Could not load reminders: ${esc(e.message)}<br>
        If this is a new setup, run migrations/v123_reminder_sms_log.sql first.</div></div>`;
    }
  }

  async function save(r, status, extra) {
    const row = {
      warranty_id: r.id, customer_name: r.name || null, phone: r.phone || null, product: r.product || null,
      kind: r.kind, due_date: r.due, message: extra.message || null, status, reason: extra.reason || null
    };
    if (extra.campaign) row.campaign_id = extra.campaign;
    const { error } = await dbAdmin.from('reminder_sms_log').insert(row);
    // 23505 = someone already sent/skipped this one (e.g. two admins at once) — fine.
    if (error && error.code !== '23505') throw error;
  }

  async function send(keys) {
    if (S.busy) return;
    const list = S.rows.filter(r => keys.includes(r.key) && r.phone);
    if (!list.length) return;
    if (!(await isSMSEnabled('service_due'))) return showToast('The "Service Due Reminder" SMS is turned off in SMS Settings', 'error');
    if (!confirm(`Send ${list.length} reminder SMS now?`)) return;
    S.busy = true;
    let sent = 0, failed = 0, done = 0;
    const btn = () => $('rem-send-btn');
    try {
      // One campaign record per press of Send (v124). If that table is missing,
      // SMS still go out and are recorded, just without a campaign.
      let campaign = null, campaignNo = null;
      const { data: camp, error: campErr } = await dbAdmin.from('reminder_sms_campaigns').insert({ planned: list.length }).select('id, campaign_no').single();
      if (!campErr && camp) { campaign = camp.id; campaignNo = camp.campaign_no; }
      for (let i = 0; i < list.length; i += 5) {
        await Promise.all(list.slice(i, i + 5).map(async r => {
          const message = textFor(r);
          const res = await sendAdminSMS(r.phone, message).catch(() => ({ ok: false, status: 0 }));
          const ok = res && res.ok !== false;
          if (ok) sent++; else failed++;
          await save(r, ok ? 'sent' : 'failed', { message, campaign,
            reason: ok ? null : (res && res.error) || (res && res.status === 0 ? 'No answer from SMS server' : `SMS error ${res && res.status || ''}`.trim()) });
          done++;
          if (btn()) btn().textContent = `Sending ${done} / ${list.length}…`;
        }));
      }
      try { logActivity('reminder.batch', `Reminder SMS ${campNo(campaignNo)}: ${sent} sent${failed ? `, ${failed} failed` : ''}`, 'warranty', null); } catch (e) { /* log only */ }
      showToast(`${sent} sent${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
    } catch (e) {
      showToast('Stopped: ' + e.message, 'error');
    } finally {
      S.busy = false;
      await load();
    }
  }

  async function skip(key) {
    const r = S.rows.find(x => x.key === key);
    if (!r) return;
    const reason = prompt(`Skip this reminder for ${r.name || 'this customer'}? Reason (optional):`, r.phone ? '' : 'No phone number');
    if (reason === null) return;
    try { await save(r, 'skipped', { reason: reason || null }); showToast('Skipped', 'success'); await load(); }
    catch (e) { showToast(e.message, 'error'); }
  }

  function exportCsv() {
    if (!S.hist.length) return showToast('Nothing to download.', 'error');
    const cell = v => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return `"${s.replace(/"/g, '""')}"`; };
    const lines = [['Date', 'Customer', 'Phone', 'Unit', 'Reminder', 'Due date', 'Status', 'Reason', 'By', 'Message'].map(cell).join(',')];
    S.hist.forEach(h => lines.push([new Date(h.created_at).toLocaleString('en-GB'), h.customer_name, h.phone, h.product,
      KINDS[h.kind] ? KINDS[h.kind].label : h.kind, dmy(h.due_date), h.status, h.reason, h.sent_by, h.message].map(cell).join(',')));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    a.download = 'sms-reminders.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  Object.assign(window, {
    loadSmsReminders: load,
    remHView: async v => { S.hView = v; S.hCamp = null; try { await fetchHistory(); } catch (e) { showToast(e.message, 'error'); } render(); },
    remOpenCamp: async i => { S.hView = 'each'; S.hCamp = i >= 0 ? S.camps[i] : null; try { await fetchHistory(); } catch (e) { showToast(e.message, 'error'); } render(); },
    remTab: async t => { S.tab = t; if (t === 'history') { try { await fetchHistory(); } catch (e) { showToast(e.message, 'error'); } } render(); },
    remShow: v => { S.tab = 'send'; S.show = v; render(); },
    remKind: v => { S.kind = v; render(); },
    remSearch: v => { S.q = v; const pos = document.activeElement && document.activeElement.selectionStart; render();
      const box = document.querySelector('#panel-reminders input[placeholder^="Search"]'); if (box) { box.focus(); try { box.setSelectionRange(pos, pos); } catch (e) {} } },
    remPick: (k, on) => { if (on) S.selected.add(k); else S.selected.delete(k); render(); },
    remPickAll: on => { shownRows().filter(r => r.phone).forEach(r => on ? S.selected.add(r.key) : S.selected.delete(r.key)); render(); },
    remSendSelected: () => send(shownRows().filter(r => S.selected.has(r.key)).map(r => r.key)),
    remSendOne: k => send([k]),
    remSkip: skip,
    remHist: async (f, v) => { S[f] = v; try { await fetchHistory(); } catch (e) { showToast(e.message, 'error'); } render(); },
    remShowMsg: i => { const h = S.hist[i]; if (h) showInfoModal(`${KINDS[h.kind] ? KINDS[h.kind].label : h.kind} · ${esc(h.customer_name || '')}`,
      `<div style="white-space:pre-wrap;">${esc(h.message || '(no message — skipped)')}</div>`); },
    remExport: exportCsv,
    // Sidebar badge on dashboard start (quietly ignored if not signed in or table missing).
    refreshReminderBadge: async () => { try { await fetchToSend(); } catch (e) { /* badge only */ } }
  });
})();
