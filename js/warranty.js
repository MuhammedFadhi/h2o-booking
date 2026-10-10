/* ============================================================================
 * js/warranty.js — SA'DA H2O warranty logic, shared by:
 *     customer/portal.html   (My Units tab)
 *     warranty/claim.html    (QR claim)
 *     admin/dashboard.html   (Warranties + Follow-ups panels)
 *
 * Ports the PHP CRM's rules 1:1:
 *   filter   → 90 days   ("Filter Replacement")
 *   service  → 365 days  ("Annual RO Service")
 *   warranty → 730 days  ("2-Year Warranty")
 * Logging a filter/service job pushes the corresponding date forward, so
 * these behave as "next due" even though the columns are named *_expiry.
 * Column names kept as-is deliberately — renaming buys nothing and breaks
 * every query written against the old CRM.
 *
 * Requires window.db (Supabase anon client).
 * ==========================================================================*/
(function () {
  'use strict';

  var TERMS = { filter: 90, service: 365, warranty: 730 };

  /* ── date helpers ───────────────────────────────────────────────────────
   * Deliberately NOT using toISOString(): it converts to UTC, which in KSA
   * (UTC+3) reports the previous day between local midnight and 03:00. That
   * bug shipped once already (customers could book tomorrow when the rule was
   * D+2). Everything here is local-calendar.                              */
  function localDateISO(d) {
    var y = d.getFullYear(),
        m = String(d.getMonth() + 1).padStart(2, '0'),
        day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function fmtDate(v) {
    if (!v) return '—';
    var d = (typeof v === 'string' && v.length === 10) ? new Date(v + 'T00:00:00') : new Date(v);
    if (isNaN(d)) return '—';
    return String(d.getDate()).padStart(2, '0') + '/' +
           String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
  }

  /** Whole days from local-midnight-today to the target. Negative = overdue. */
  function daysUntil(v) {
    if (!v) return null;
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var t = new Date(v); t.setHours(0, 0, 0, 0);
    return Math.round((t - today) / 86400000);
  }

  /**
   * Mirrors get_milestone_stats() from the old dashboard.php.
   * pct is clamped 0..1 for the gauge; remaining may go negative.
   */
  function milestone(expiry, totalDays) {
    var remaining = daysUntil(expiry);
    if (remaining === null) return { unknown: true, remaining: null, pct: 0, active: false, expiry: null };
    var pct = Math.max(0, Math.min(1, remaining / totalDays));
    return { unknown: false, remaining: remaining, total: totalDays, pct: pct, active: remaining > 0, expiry: expiry };
  }

  /** ok | soon (<=14d) | expired — drives colour everywhere. */
  function statusOf(expiry) {
    var d = daysUntil(expiry);
    if (d === null) return 'unknown';
    if (d < 0) return 'expired';
    if (d <= 14) return 'soon';
    return 'ok';
  }

  var STATUS_COLORS = {
    ok:      { bg: '#DCFCE7', fg: '#166534', bar: '#16A34A' },
    soon:    { bg: '#FEF3C7', fg: '#92400E', bar: '#D97706' },
    expired: { bg: '#FEE2E2', fg: '#991B1B', bar: '#DC2626' },
    unknown: { bg: '#F1F5F9', fg: '#64748B', bar: '#94A3B8' }
  };

  /** "in 34 days" / "today" / "12 days overdue" */
  function humanDays(expiry) {
    var d = daysUntil(expiry);
    if (d === null) return 'Not set';
    if (d === 0) return 'Today';
    if (d < 0) return Math.abs(d) + (Math.abs(d) === 1 ? ' day overdue' : ' days overdue');
    return 'in ' + d + (d === 1 ? ' day' : ' days');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── data access ────────────────────────────────────────────────────────*/

  /**
   * product_models is joined to warranties by NAME, not by a foreign key —
   * deliberately, so that claiming a sticker with an unknown prefix can't fail
   * on an FK violation (the PHP behaved the same way).
   *
   * The consequence: PostgREST CANNOT embed it. `select('*, product_models(..)')`
   * returns PGRST200 "Could not find a relationship ... in the schema cache" and
   * silently yields zero rows. So we fetch the models once and attach them here.
   * Cached for the page's lifetime — it's 8 rows that change ~never.
   */
  var _modelCache = null;
  async function modelMap() {
    if (_modelCache) return _modelCache;
    var r = await window.db.from('product_models').select('model_name, image_url, description');
    _modelCache = {};
    (r.data || []).forEach(function (m) { _modelCache[m.model_name] = m; });
    return _modelCache;
  }

  /** Attach .product_models to each row, mimicking what an embed would have given us. */
  async function attachModels(rows) {
    var models = await modelMap();
    rows.forEach(function (r) { r.product_models = models[r.product_type] || null; });
    return rows;
  }

  /** Resolve a phone to its customers.id. Returns null if absent. */
  async function customerIdForPhone(phone) {
    var r = await window.db.from('customers').select('id').eq('phone', phone).maybeSingle();
    return r.data ? r.data.id : null;
  }

  /** Every unit for a phone, with model image + full service history. */
  async function unitsForPhone(phone) {
    var cid = await customerIdForPhone(phone);
    if (!cid) return [];
    var w = await window.db.from('warranties')
      .select('*')
      .eq('customer_id', cid)
      .order('registration_date', { ascending: false });
    if (w.error) { console.error('unitsForPhone:', w.error); return []; }
    var units = w.data || [];
    if (!units.length) return [];
    await attachModels(units);

    var h = await window.db.from('warranty_service_history')
      .select('*')
      .in('warranty_id', units.map(function (u) { return u.id; }))
      .order('created_at', { ascending: false });

    var byWarranty = {};
    (h.data || []).forEach(function (row) {
      (byWarranty[row.warranty_id] = byWarranty[row.warranty_id] || []).push(row);
    });
    units.forEach(function (u) { u.history = byWarranty[u.id] || []; });
    return units;
  }

  /** Claim state for a QR: available | taken_by_you | taken_by_other | invalid */
  async function qrStatus(pid, phone) {
    if (!pid || !/^[A-Za-z0-9._-]{4,50}$/.test(pid)) return { state: 'invalid' };
    var r = await window.db.from('warranties')
      .select('id, qr_code, product_type, registration_date, customer_id')
      .eq('qr_code', pid).maybeSingle();
    if (!r.data) return { state: 'available', pid: pid, guessedType: pid.slice(0, 4) };
    if (!phone) return { state: 'taken_by_other', warranty: r.data };
    var cid = await customerIdForPhone(phone);
    return {
      state: (cid && cid === r.data.customer_id) ? 'taken_by_you' : 'taken_by_other',
      warranty: r.data
    };
  }

  /* ── rendering ──────────────────────────────────────────────────────────*/

  /** Semicircular gauge, same idea as the old dashboard's SVG. */
  function gauge(pct, color, days) {
    var R = 52, CX = 60, CY = 60;
    var circ = Math.PI * R;                       // half-circle length
    var dash = Math.max(0, Math.min(1, pct)) * circ;
    var label = (days === null) ? '—' : (days < 0 ? '0' : String(days));
    return '' +
      '<svg viewBox="0 0 120 72" style="width:110px;height:66px;">' +
        '<path d="M 8 60 A ' + R + ' ' + R + ' 0 0 1 112 60" fill="none" stroke="#E2E8F0" stroke-width="9" stroke-linecap="round"/>' +
        '<path d="M 8 60 A ' + R + ' ' + R + ' 0 0 1 112 60" fill="none" stroke="' + color + '" stroke-width="9" ' +
              'stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + circ.toFixed(1) + '"/>' +
        '<text x="60" y="52" text-anchor="middle" style="font-size:21px;font-weight:800;fill:#1A2B47;">' + label + '</text>' +
        '<text x="60" y="66" text-anchor="middle" style="font-size:8px;font-weight:700;fill:#607D8B;letter-spacing:.08em;">DAYS LEFT</text>' +
      '</svg>';
  }

  function milestoneCard(title, keyLabel, expiry, totalDays) {
    var m = milestone(expiry, totalDays);
    var st = statusOf(expiry);
    var c = STATUS_COLORS[st];
    return '' +
      '<div style="flex:1 1 150px;min-width:150px;background:#fff;border:1px solid var(--border,#CFD8DC);border-radius:14px;padding:14px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:8px;">' +
          '<span style="font-size:12px;font-weight:700;color:var(--text,#1A2B47);">' + esc(title) + '</span>' +
          '<span style="background:' + c.bg + ';color:' + c.fg + ';font-size:9px;font-weight:800;padding:3px 8px;border-radius:10px;letter-spacing:.06em;">' +
            (m.unknown ? 'NOT SET' : (m.active ? 'ACTIVE' : 'OVERDUE')) + '</span>' +
        '</div>' +
        '<div style="display:flex;justify-content:center;">' + gauge(m.pct, c.bar, m.remaining) + '</div>' +
        '<div style="border-top:1px solid #F1F5F9;margin-top:10px;padding-top:8px;font-size:11px;color:var(--muted,#607D8B);">' +
          '<div style="display:flex;justify-content:space-between;"><span>' + esc(keyLabel) + ' due</span>' +
          '<strong style="color:' + c.fg + ';">' + fmtDate(expiry) + '</strong></div>' +
        '</div>' +
      '</div>';
  }

  var TYPE_META = {
    activation: { icon: '🎉', label: 'Activated',        color: '#1565C0' },
    filter:     { icon: '💧', label: 'Filter Replaced',  color: '#0891B2' },
    service:    { icon: '🔧', label: 'Serviced',         color: '#7C3AED' },
    other:      { icon: '📝', label: 'Note',             color: '#607D8B' }
  };

  function historyList(history) {
    if (!history || !history.length) {
      return '<div style="font-size:12px;color:var(--muted,#607D8B);padding:8px 0;">No service records yet.</div>';
    }
    return history.map(function (h) {
      var t = TYPE_META[h.service_type] || TYPE_META.other;
      return '<div style="display:flex;gap:9px;padding:8px 0;border-bottom:1px solid #F8FAFC;">' +
          '<span style="font-size:14px;line-height:1.2;">' + t.icon + '</span>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-size:12px;font-weight:700;color:' + t.color + ';">' + t.label + '</div>' +
            (h.notes ? '<div style="font-size:11px;color:var(--muted,#607D8B);word-break:break-word;">' + esc(h.notes) + '</div>' : '') +
          '</div>' +
          '<span style="font-size:10px;color:#94A3B8;white-space:nowrap;">' + fmtDate(h.created_at) + '</span>' +
        '</div>';
    }).join('');
  }

  /** Full unit card for the customer portal. */
  // Dark full-ring gauge (per a reference temperature-gauge UI) for the
  // customer portal's Filter/Service "days left" meters. admin/dashboard.html
  // still uses the plain gauge()/milestoneCard() above via W.milestoneCard()
  // directly (openJobOrder's modal) - untouched, this is additive only.
  var _gaugeUid = 0;
  function gaugeCircular(pct, color, days, statusWord) {
    var R = 72, CX = 90, CY = 90, SW = 14;
    var toRad = function (d) { return d * Math.PI / 180; };
    var pt = function (deg, radius) {
      radius = radius || R;
      return { x: CX + radius * Math.cos(toRad(deg)), y: CY + radius * Math.sin(toRad(deg)) };
    };
    var circ = 2 * Math.PI * R;
    var frac = Math.max(0, Math.min(1, pct));
    var dash = frac * circ;
    // Full ring, no gap — progress starts at 12 o'clock (deg 270 in this
    // x=cos/y=sin convention) and sweeps clockwise.
    var knob = pt(270 + frac * 360);
    var label = (days === null) ? '—' : (days < 0 ? '0' : String(days));
    var gid = 'gaugeGrad' + (++_gaugeUid);

    // Static decorative ring of dots around the outside — purely visual,
    // full circle regardless of progress (the reference's "protection
    // circle" look), independent of the actual progress arc inside it.
    var dotR = R + 16, dots = [];
    for (var i = 0; i < 40; i++) {
      var dp = pt(i * 9, dotR);
      // Sits outside the dark disc, on the card's light background — needs
      // real contrast there, not the near-white the reference's dark page
      // got away with.
      dots.push('<circle cx="' + dp.x.toFixed(1) + '" cy="' + dp.y.toFixed(1) + '" r="1.6" fill="rgba(13,59,110,0.3)"/>');
    }

    return '' +
      '<div style="position:relative;width:206px;height:206px;margin:0 auto;">' +
        '<svg viewBox="0 0 220 220" style="width:206px;height:206px;">' +
          '<defs><linearGradient id="' + gid + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
            '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.5"/>' +
            '<stop offset="100%" stop-color="' + color + '"/>' +
          '</linearGradient></defs>' +
          '<g transform="translate(20,20)">' +
            dots.join('') +
            '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="var(--border,#E2E8F0)" stroke-width="' + SW + '"/>' +
            '<circle cx="90" cy="90" r="' + R + '" fill="none" stroke="url(#' + gid + ')" stroke-width="' + SW + '" ' +
              'stroke-linecap="round" stroke-dasharray="' + dash.toFixed(1) + ' ' + circ.toFixed(1) + '" ' +
              'transform="rotate(-90 90 90)"/>' +
            '<circle cx="' + knob.x.toFixed(1) + '" cy="' + knob.y.toFixed(1) + '" r="8" fill="#fff" stroke="' + color + '" stroke-width="2.5"/>' +
          '</g>' +
        '</svg>' +
        '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">' +
          '<div style="font-size:40px;font-weight:800;color:var(--ocean,#0D3B6E);line-height:1;">' + label + '</div>' +
          '<div style="font-size:10px;font-weight:700;color:var(--muted,#607D8B);letter-spacing:.12em;margin-top:6px;">DAYS LEFT</div>' +
          '<div style="margin-top:10px;background:' + color + '26;color:' + color + ';font-size:10px;font-weight:800;padding:4px 13px;border-radius:20px;letter-spacing:.04em;">' + esc(statusWord) + '</div>' +
        '</div>' +
      '</div>';
  }

  function milestoneCardCircular(title, keyLabel, expiry, totalDays) {
    var m = milestone(expiry, totalDays);
    var st = statusOf(expiry);
    var c = STATUS_COLORS[st];
    return '' +
      '<div style="flex:1 1 190px;max-width:220px;margin:0 auto 6px;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#1A2B47);margin-bottom:10px;text-align:center;">' + esc(title) + '</div>' +
        gaugeCircular(m.pct, c.bar, m.remaining, title) +
        '<div style="text-align:center;font-size:11px;color:var(--muted,#607D8B);margin-top:9px;">' + esc(keyLabel) + ' due <strong style="color:' + c.fg + ';">' + fmtDate(expiry) + '</strong></div>' +
      '</div>';
  }

  function unitCard(u, idx, gaugeStyle) {
    // A self-reported row (standalone service visit, no SA'DA install/QR) gets
    // honest framing instead of implying formal SA'DA product coverage: no
    // warranty badge/countdown, "first serviced" instead of "installed".
    var isSelfReported = u.source === 'self_reported';
    // Admin can pause/deactivate a warranty. Reflect that to the customer:
    // a deactivated unit is not covered; a paused one is temporarily suspended.
    var st = u.status || 'active';
    var wc, statusBadge;
    if (isSelfReported) {
      wc = STATUS_COLORS.unknown;
      statusBadge = 'SERVICE TRACKING';
    } else {
      var wSt = statusOf(u.warranty_expiry);
      wc = STATUS_COLORS[wSt];
      statusBadge = (wSt === 'expired') ? 'EXPIRED' : '2-YR WARRANTY';
      if (st === 'deactivated') { wc = STATUS_COLORS.expired; statusBadge = 'NOT COVERED'; }
      else if (st === 'paused') { wc = STATUS_COLORS.soon; statusBadge = 'SUSPENDED'; }
    }
    var img = (u.product_models && u.product_models.image_url) || '/assets/models/purifier-generic.png';
    var desc = (u.product_models && u.product_models.description) || '';
    // Keyed by the warranty's own id (not the loop index) so it stays unique
    // even when My Units and the Service tab both render a card at index 0 —
    // their panels coexist in the DOM at once (one just hidden), and
    // getElementById only ever finds the first match.
    var hid = 'wh-' + (u.id || idx);
    return '' +
    '<div style="background:var(--foam,#E3F2FD);border:1px solid var(--border,#CFD8DC);border-radius:16px;padding:16px;margin-bottom:14px;">' +
      '<div style="display:flex;gap:13px;align-items:flex-start;margin-bottom:13px;">' +
        '<img src="' + esc(img) + '" alt="" loading="lazy" ' +
             'style="width:56px;height:56px;object-fit:contain;background:#fff;border-radius:11px;padding:5px;flex-shrink:0;" ' +
             'onerror="this.src=\'/assets/models/purifier-generic.png\'">' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:15px;font-weight:800;color:var(--ocean,#0D3B6E);word-break:break-word;">' + esc(u.product_type) + '</div>' +
          (u.qr_code ? '<div style="font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted,#607D8B);word-break:break-all;margin-top:2px;">' + esc(u.qr_code) + '</div>' : '') +
          (u.quantity > 1 ? '<div style="font-size:10px;color:#92400E;background:#FEF3C7;display:inline-block;padding:2px 7px;border-radius:8px;margin-top:4px;font-weight:700;">×' + u.quantity + ' units on this record</div>' : '') +
        '</div>' +
        '<span style="background:' + wc.bg + ';color:' + wc.fg + ';font-size:10px;font-weight:800;padding:4px 9px;border-radius:10px;white-space:nowrap;">' +
          statusBadge + '</span>' +
      '</div>' +

      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:' + (isSelfReported ? '4px' : '12px') + ';">' +
        (gaugeStyle === 'circular' ? (
          milestoneCardCircular('Filter Replacement', 'Filter', u.filter_expiry, TERMS.filter) +
          milestoneCardCircular('Annual RO Service', 'Service', u.service_expiry, TERMS.service)
        ) : (
          milestoneCard('Filter Replacement', 'Filter', u.filter_expiry, TERMS.filter) +
          milestoneCard('Annual RO Service', 'Service', u.service_expiry, TERMS.service)
        )) +
      '</div>' +
      (isSelfReported ? '<p style="font-size:10.5px;color:var(--muted,#607D8B);margin:0 0 12px;line-height:1.5;">Estimated from your last SA\'DA visit, not this unit\'s original install date.</p>' : '') +

      '<div style="background:#fff;border-radius:11px;padding:11px 13px;font-size:12px;">' +
        '<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--muted,#607D8B);">' + (isSelfReported ? 'First serviced by SA\'DA' : 'Installed') + '</span><strong>' + fmtDate(u.registration_date) + '</strong></div>' +
        (isSelfReported ? '' : '<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--muted,#607D8B);">Warranty until</span><strong style="color:' + wc.fg + ';">' + fmtDate(u.warranty_expiry) + ' · ' + humanDays(u.warranty_expiry) + '</strong></div>') +
        (u.client_code ? '<div style="display:flex;justify-content:space-between;padding:3px 0;"><span style="color:var(--muted,#607D8B);">Client code</span><strong>' + esc(u.client_code) + '</strong></div>' : '') +
      '</div>' +

      '<button onclick="SADA.Warranty.toggle(\'' + hid + '\',this)" ' +
              'style="width:100%;margin-top:11px;background:none;border:1px solid var(--border,#CFD8DC);color:var(--ocean,#0D3B6E);padding:9px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">' +
        '🛠️ Service history (' + (u.history ? u.history.length : 0) + ')</button>' +
      '<div id="' + hid + '" style="display:none;background:#fff;border-radius:11px;padding:5px 13px;margin-top:9px;">' + historyList(u.history) + '</div>' +

      (desc ? '<details style="margin-top:9px;"><summary style="font-size:11px;color:var(--muted,#607D8B);cursor:pointer;">About this model</summary>' +
              '<p style="font-size:11px;color:var(--muted,#607D8B);line-height:1.6;margin-top:7px;">' + esc(desc) + '</p></details>' : '') +
    '</div>';
  }

  function toggle(id, btn) {
    var el = document.getElementById(id);
    if (!el) return;
    var open = el.style.display !== 'none';
    el.style.display = open ? 'none' : 'block';
    if (btn) btn.style.background = open ? 'none' : '#F1F5F9';
  }

  window.SADA = window.SADA || {};
  window.SADA.Warranty = {
    TERMS: TERMS,
    localDateISO: localDateISO,
    fmtDate: fmtDate,
    daysUntil: daysUntil,
    humanDays: humanDays,
    milestone: milestone,
    statusOf: statusOf,
    STATUS_COLORS: STATUS_COLORS,
    esc: esc,
    customerIdForPhone: customerIdForPhone,
    unitsForPhone: unitsForPhone,
    modelMap: modelMap,
    attachModels: attachModels,
    qrStatus: qrStatus,
    unitCard: unitCard,
    historyList: historyList,
    milestoneCard: milestoneCard,
    milestoneCardCircular: milestoneCardCircular,
    gaugeCircular: gaugeCircular,
    toggle: toggle
  };
})();
