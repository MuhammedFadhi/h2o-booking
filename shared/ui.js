/* ============================================================
   SA'DA H2O — Shared UI Utilities (v22)
   Vanilla ES module-style — attached to window.SW
   ============================================================ */
(function () {
  const SW = window.SW = window.SW || {};

  // -------- Toast --------
  function ensureToastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }
  const ICONS = { success: '✓', error: '⚠', warning: '⚠', info: 'ℹ' };
  SW.toast = function (msg, type = 'info', ttl = 4200) {
    const host = ensureToastHost();
    const t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('data-type', type);
    t.innerHTML = `
      <div class="toast-icon">${ICONS[type] || 'ℹ'}</div>
      <div class="toast-body"></div>
      <button class="toast-close" aria-label="Close">×</button>`;
    t.querySelector('.toast-body').textContent = msg;
    t.querySelector('.toast-close').addEventListener('click', () => close());
    function close() {
      t.classList.add('closing');
      setTimeout(() => t.remove(), 200);
    }
    host.appendChild(t);
    if (ttl > 0) setTimeout(close, ttl);
    return { close };
  };
  SW.confirm = function (msg, opts = {}) {
    return new Promise((resolve) => {
      const scrim = document.createElement('div');
      scrim.className = 'modal-scrim';
      scrim.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="cf-title">
          <div class="modal-header"><div class="modal-title" id="cf-title">${opts.title || 'Confirm'}</div></div>
          <div class="modal-body"><div style="font-size:14px;line-height:1.5;color:var(--text-2)"></div></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-action="cancel">${opts.cancelText || 'Cancel'}</button>
            <button class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'}" data-action="ok">${opts.okText || 'OK'}</button>
          </div>
        </div>`;
      scrim.querySelector('.modal-body div').textContent = msg;
      document.body.appendChild(scrim);
      const done = (v) => { scrim.remove(); resolve(v); };
      scrim.addEventListener('click', (e) => { if (e.target === scrim) done(false); });
      scrim.querySelector('[data-action="cancel"]').onclick = () => done(false);
      scrim.querySelector('[data-action="ok"]').onclick = () => done(true);
      const esc = (e) => { if (e.key === 'Escape') { done(false); document.removeEventListener('keydown', esc); } };
      document.addEventListener('keydown', esc);
      scrim.querySelector('[data-action="ok"]').focus();
    });
  };

  // -------- Modal (imperative) --------
  SW.openModal = function ({ title, body, footer, size }) {
    const scrim = document.createElement('div');
    scrim.className = 'modal-scrim';
    scrim.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="${size==='lg'?'width:min(760px,100%)':''}">
        <div class="modal-header"><div class="modal-title"></div><button class="btn btn-icon btn-ghost" data-close aria-label="Close">✕</button></div>
        <div class="modal-body"></div>
        ${footer ? '<div class="modal-footer"></div>' : ''}
      </div>`;
    scrim.querySelector('.modal-title').textContent = title || '';
    if (typeof body === 'string') scrim.querySelector('.modal-body').innerHTML = body;
    else if (body instanceof Node) scrim.querySelector('.modal-body').appendChild(body);
    if (footer) {
      const f = scrim.querySelector('.modal-footer');
      if (typeof footer === 'string') f.innerHTML = footer;
      else if (footer instanceof Node) f.appendChild(footer);
    }
    const close = () => scrim.remove();
    scrim.addEventListener('click', (e) => { if (e.target === scrim) close(); });
    scrim.querySelector('[data-close]').onclick = close;
    const esc = (e) => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
    document.body.appendChild(scrim);
    return { close, root: scrim.querySelector('.modal') };
  };

  // -------- Skeleton --------
  SW.skeleton = function (kind = 'list', count = 5) {
    const wrap = document.createElement('div');
    if (kind === 'table') {
      wrap.innerHTML = Array.from({ length: count }).map(() => `
        <div class="row gap-16" style="padding:12px 0;border-bottom:1px solid var(--hairline)">
          <div class="skeleton sk-avatar"></div>
          <div class="grow"><div class="skeleton sk-title"></div><div class="skeleton sk-line" style="width:60%"></div></div>
          <div class="skeleton sk-line" style="width:80px"></div>
        </div>`).join('');
    } else if (kind === 'cards') {
      wrap.style.display = 'grid';
      wrap.style.gap = '12px';
      wrap.innerHTML = Array.from({ length: count }).map(() => `
        <div class="card"><div class="skeleton sk-title"></div><div class="skeleton sk-line"></div><div class="skeleton sk-line" style="width:70%"></div></div>`).join('');
    } else {
      wrap.innerHTML = Array.from({ length: count }).map(() => `<div class="skeleton sk-line"></div>`).join('');
    }
    return wrap;
  };

  // -------- HTTP --------
  SW.http = {
    async json(url, opts = {}) {
      const r = await fetch(url, opts);
      const txt = await r.text();
      let body; try { body = JSON.parse(txt); } catch { body = txt; }
      if (!r.ok) throw Object.assign(new Error(body?.error || r.statusText), { status: r.status, body });
      return body;
    }
  };

  // -------- Formatters --------
  SW.fmt = {
    hour(h) {
      if (h == null) return '-';
      const p = h >= 12 ? 'PM' : 'AM';
      const h12 = ((h + 11) % 12) + 1;
      return `${h12}:00 ${p}`;
    },
    hourRange(h) {
      if (h == null) return '-';
      return `${SW.fmt.hour(h)} – ${SW.fmt.hour((h + 1) % 24)}`;
    },
    dateShort(s) {
      if (!s) return '-';
      const d = new Date(s + 'T00:00:00');
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    },
    dateFull(s) {
      if (!s) return '-';
      const d = new Date(s + 'T00:00:00');
      return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
    },
    money(n) { return `SAR ${Number(n).toFixed(2)}`; },
    phone(p) {
      if (!p) return '';
      const s = String(p).replace(/\D/g, '');
      if (s.length === 12 && s.startsWith('966')) return `+${s.slice(0,3)} ${s.slice(3,5)} ${s.slice(5,8)} ${s.slice(8)}`;
      return p;
    },
    statusLabel(s) {
      return { upcoming: 'Upcoming', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' }[s] || s;
    },
    typeLabel(t) {
      return { installation: 'Installation', maintenance: 'Maintenance', repair: 'Repair', relocation: 'Relocation' }[t] || t;
    },
    escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
    }
  };

  // -------- Validation --------
  SW.isSaudiPhone = (p) => /^9665\d{8}$/.test(String(p).replace(/\D/g, ''));
  SW.formatSaudiPhone = (p) => {
    let s = String(p).replace(/\D/g, '');
    if (s.startsWith('00966')) s = s.slice(2);
    else if (s.startsWith('0')) s = '966' + s.slice(1);
    else if (!s.startsWith('966')) s = '966' + s;
    return s;
  };

  // -------- CSV export --------
  SW.exportCSV = function (filename, rows) {
    if (!rows.length) return;
    const cols = Object.keys(rows[0]);
    const escape = (v) => {
      if (v == null) return '';
      const s = String(v);
      return /["\n,]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(','), ...rows.map(r => cols.map(c => escape(r[c])).join(','))].join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  // -------- Debounce --------
  SW.debounce = (fn, ms = 200) => {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  };

  // -------- Booking lead time --------
  SW.MIN_LEAD_DAYS = 2;
  SW.minBookableDate = function () {
    const d = new Date();
    d.setDate(d.getDate() + SW.MIN_LEAD_DAYS);
    return d.toISOString().split('T')[0];
  };
  SW.bookableDates = function (span = 7) {
    const out = [];
    for (let i = SW.MIN_LEAD_DAYS; i < SW.MIN_LEAD_DAYS + span; i++) {
      const d = new Date(); d.setDate(d.getDate() + i);
      out.push(d.toISOString().split('T')[0]);
    }
    return out;
  };
})();
