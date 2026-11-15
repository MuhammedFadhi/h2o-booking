// My Wallet — shared by the sales portal and the installer portal.
// Read only: shows the signed-in person's incentives and the payments they
// received. Data comes from the database function my_incentive_wallet()
// (migration v118), which only ever returns the caller's own rows.
//
//   await Wallet.load()          fetch; returns the Balance Due (number) or null
//   Wallet.render(element)       draw the wallet into a page element
(function () {
  const S = { data: null, month: '', tab: 'earn', el: null };
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const dmy = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '';
  const payNo = n => 'PAY-' + String(n).padStart(4, '0');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const monthLabel = ym => MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);

  const css = `
    .wl-card { background:#fff; border-radius:10px; padding:18px; box-shadow:0 3px 12px rgba(47,43,61,.08); margin-bottom:14px; }
    .wl-head { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; margin-bottom:14px; }
    .wl-head h2 { margin:0; font-size:18px; }
    .wl-head select { padding:7px 10px; border:1.5px solid #d5dde3; border-radius:9px; font-size:13px; background:#fff; color:inherit; }
    .wl-tiles { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:14px; }
    .wl-tile { border-radius:10px; padding:12px; text-align:center; background:#F8FAFC; }
    .wl-tile b { display:block; font-size:20px; line-height:1.2; }
    .wl-tile span { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:.3px; color:#64748B; }
    .wl-tabs { display:flex; gap:6px; margin-bottom:10px; }
    .wl-tabs button { flex:1; padding:8px; border:1.5px solid #d5dde3; background:#fff; border-radius:9px; font-weight:600; font-size:13px; cursor:pointer; color:inherit; }
    .wl-tabs button.on { background:#0F3B6E; border-color:#0F3B6E; color:#fff; }
    .wl-row { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:10px 2px; border-bottom:1px solid #EEF1F4; font-size:13px; }
    .wl-row:last-child { border-bottom:0; }
    .wl-sub { color:#64748B; font-size:12px; margin-top:2px; }
    .wl-amt { font-weight:700; white-space:nowrap; text-align:right; }
    .wl-paid { color:#15803D; font-size:11px; font-weight:600; }
    .wl-due { color:#D97706; font-size:11px; font-weight:600; }
    .wl-empty { text-align:center; color:#64748B; padding:24px 0; font-size:13px; }
    @media (max-width:480px) { .wl-tile b { font-size:16px; } }`;
  function addStyle() {
    if (document.getElementById('wl-style')) return;
    const s = document.createElement('style');
    s.id = 'wl-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  async function load() {
    const { data, error } = await window.db.rpc('my_incentive_wallet');
    if (error) { S.data = null; S.error = error.message; return null; }
    S.data = data || { earnings: [], payouts: [] };
    S.error = null;
    return S.data.earnings.filter(e => !e.paid_on).reduce((t, e) => t + Number(e.amount || 0), 0);
  }

  function draw() {
    const el = S.el;
    if (!el) return;
    if (!S.data) {
      el.innerHTML = `<div class="wl-card"><div class="wl-empty">Wallet is not available right now.${S.error ? '<br>' + esc(S.error) : ''}</div></div>`;
      return;
    }
    const all = S.data.earnings, pays = S.data.payouts;
    const months = [...new Set([...all.map(e => String(e.earned_on).slice(0, 7)), ...pays.map(p => String(p.paid_on).slice(0, 7))])].sort().reverse();
    if (S.month && !months.includes(S.month)) S.month = '';
    const inMonth = d => !S.month || String(d).slice(0, 7) === S.month;
    const earn = all.filter(e => inMonth(e.earned_on));
    const paidList = pays.filter(p => inMonth(p.paid_on));
    const sum = list => list.reduce((t, x) => t + Number(x.amount || 0), 0);
    const earned = sum(earn), paidOfThese = sum(earn.filter(e => e.paid_on));

    const rows = S.tab === 'earn'
      ? (earn.length ? earn.map(e => `
          <div class="wl-row">
            <div><div>${esc(e.product)}${e.adjustment ? ' (correction)' : ` × ${esc(e.qty)}`}</div>
              <div class="wl-sub">${dmy(e.earned_on)}${e.booking ? ' · ' + esc(e.booking) : ''}</div></div>
            <div class="wl-amt">SAR ${money(e.amount)}<br>${e.paid_on
              ? `<span class="wl-paid">Paid ${dmy(e.paid_on)} · ${payNo(e.payout_no)}</span>`
              : '<span class="wl-due">Unpaid</span>'}</div>
          </div>`).join('') : '<div class="wl-empty">No incentives yet.</div>')
      : (paidList.length ? paidList.map(p => `
          <div class="wl-row">
            <div><div>${payNo(p.payout_no)}</div><div class="wl-sub">${dmy(p.paid_on)} · ${p.method === 'bank' ? 'Bank transfer' : 'Cash'}</div></div>
            <div class="wl-amt">SAR ${money(p.amount)}</div>
          </div>`).join('') : '<div class="wl-empty">No payments received yet.</div>');

    el.innerHTML = `
      <div class="wl-card">
        <div class="wl-head"><h2>My Wallet</h2>
          <select onchange="Wallet._month(this.value)">
            <option value="">All time</option>
            ${months.map(m => `<option value="${m}" ${m === S.month ? 'selected' : ''}>${monthLabel(m)}</option>`).join('')}
          </select></div>
        <div class="wl-tiles">
          <div class="wl-tile"><b style="color:#0F766E;">SAR ${money(earned)}</b><span>Earned</span></div>
          <div class="wl-tile"><b style="color:#2563EB;">SAR ${money(paidOfThese)}</b><span>Paid</span></div>
          <div class="wl-tile"><b style="color:#D97706;">SAR ${money(earned - paidOfThese)}</b><span>Balance Due</span></div>
        </div>
        <div class="wl-tabs">
          <button class="${S.tab === 'earn' ? 'on' : ''}" onclick="Wallet._tab('earn')">Earnings</button>
          <button class="${S.tab === 'pay' ? 'on' : ''}" onclick="Wallet._tab('pay')">Payments received</button>
        </div>
        ${rows}
      </div>`;
  }

  async function render(el) {
    addStyle();
    S.el = el;
    el.innerHTML = '<div class="wl-card"><div class="wl-empty">Loading…</div></div>';
    const due = await load();
    draw();
    return due;
  }

  window.Wallet = {
    load, render,
    _month(v) { S.month = v; draw(); },
    _tab(v) { S.tab = v; draw(); }
  };
})();
