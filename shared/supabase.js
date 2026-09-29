// ============================================================
// shared/supabase.js
// Anon Supabase client + shared helpers.
// SERVICE ROLE KEY is NOT here — it lives only in serverless env vars.
// The whole file is wrapped in an IIFE so no top-level `const supabase`
// collides with the CDN's `window.supabase` global.
// Exposes:  window.db  (the anon client)
//           window.formatHour / formatDate / formatDateFull / getStatusColor / getStatusLabel
//           window.checkAdminAuth / checkInstallerAuth
// ============================================================
(function () {
  const SUPABASE_URL = 'https://ykgtrloptgazeqjgxney.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlrZ3RybG9wdGdhemVxamd4bmV5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY4NjAxODEsImV4cCI6MjA5MjQzNjE4MX0.4yr-4mlvQQSw7R6qNUYmDfLA4ITVC09Iei2k3JB6M4A';

  const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  window.db = db;

  // Formats a slot as "8:00 AM - 9:00 AM". minute/durationMinutes are optional —
  // omitted (as every call site did before slots could be anything but a flat
  // 1-hour block) they default to :00 and 60, so old callers and old slot rows
  // format exactly as they always have. New slots pass their real minute
  // (0 or 30) and duration (e.g. 90) to get e.g. "10:30 AM - 12:00 PM".
  // Fixes v21 edge cases: h=11 → "11:00 AM - 12:00 PM" (was AM); h=23 → "11:00 PM - 12:00 AM" (was 24:00 PM).
  window.formatHour = function (hour, minute, durationMinutes) {
    const h = parseInt(hour, 10);
    if (isNaN(h) || h < 0 || h > 23) return String(hour);
    const m = (minute === 30) ? 30 : 0;
    const dur = (Number.isFinite(durationMinutes) && durationMinutes > 0) ? durationMinutes : 60;
    const label = (totalMin) => {
      totalMin = ((totalMin % 1440) + 1440) % 1440; // wrap into 0..1439
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      const period = hh >= 12 ? 'PM' : 'AM';
      const twelve = hh % 12 === 0 ? 12 : hh % 12;
      return `${twelve}:${String(mm).padStart(2, '0')} ${period}`;
    };
    const startMin = h * 60 + m;
    return `${label(startMin)} - ${label(startMin + dur)}`;
  };

  window.formatDate = function (dateStr) {
    // dd/mm/yyyy for consistent global format
    const d = new Date(dateStr + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  // YYYY-MM-DD in the LOCAL calendar — never in UTC.
  // Do NOT use `d.toISOString().split('T')[0]` for this: in KSA (UTC+3) that
  // reports the previous day for anything from local midnight to 03:00, which
  // silently exposes tomorrow's slots to customers as "today+2".
  window.localDateISO = function (d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Convenience: today, tomorrow, D+N in local YYYY-MM-DD.
  window.todayLocalISO = function () {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    return window.localDateISO(t);
  };
  window.localDatePlus = function (days) {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    t.setDate(t.getDate() + days);
    return window.localDateISO(t);
  };

  // ── Customer slot availability ─────────────────────────────────────────────
  // Slots are Saudi wall-clock times (slot_hour 14 = 2:00–3:00 PM in Riyadh), so
  // "has it started yet?" must be answered in Saudi time — not the visitor's
  // device timezone, which would hide/show the wrong slots for anyone abroad.
  window.ksaNow = function (now) {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(now || new Date());
    const g = (t) => parts.find((p) => p.type === t).value;
    return { dateISO: `${g('year')}-${g('month')}-${g('day')}`, minutes: Number(g('hour')) * 60 + Number(g('minute')) };
  };

  // Customers may book any slot that has not started yet. Raise this to require
  // notice (e.g. 60 = the slot must start at least an hour from now).
  window.SLOT_MIN_LEAD_MINUTES = 0;

  // slotMinute is optional (defaults to :00, matching every slot before
  // variable-duration slots existed) — pass it for accurate gating on a slot
  // that starts on the half-hour (e.g. 10:30), not just the hour.
  window.slotIsBookable = function (slotDate, slotHour, slotMinute, now) {
    const k = window.ksaNow(now);
    if (slotDate > k.dateISO) return true;
    if (slotDate < k.dateISO) return false;
    const startMin = Number(slotHour) * 60 + (slotMinute === 30 ? 30 : 0);
    return startMin > k.minutes + window.SLOT_MIN_LEAD_MINUTES;
  };

  window.formatDateFull = function (dateStr) {
    // dd/mm/yyyy + weekday for at-a-glance context
    const d = new Date(dateStr + 'T00:00:00');
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    const weekday = d.toLocaleDateString('en-US', { weekday: 'long' });
    return `${weekday}, ${dd}/${mm}/${yyyy}`;
  };

  window.getStatusColor = function (status) {
    return ({ upcoming: '#2563EB', in_progress: '#D97706', completed: '#16A34A', cancelled: '#DC2626' })[status] || '#6B7280';
  };

  window.getStatusLabel = function (status) {
    return ({ upcoming: 'Upcoming', in_progress: 'In Progress', completed: 'Completed', cancelled: 'Cancelled' })[status] || status;
  };

  window.checkAdminAuth = async function () {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = '../admin/login.html'; return false; }
    // A valid Supabase Auth session only proves the login/password matched —
    // installers authenticate through the same auth.users pool. Admin console
    // access requires the email to also be in admin_emails (is_admin()).
    const { data: isAdmin } = await db.rpc('is_admin');
    if (!isAdmin) { await db.auth.signOut(); window.location.href = '../admin/login.html'; return false; }
    return session;
  };

  window.checkInstallerAuth = async function () {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = '../installer/login.html'; return false; }
    return session;
  };
})();
