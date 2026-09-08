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

  // Formats a slot hour (0..23) as "8:00 AM - 9:00 AM".
  // Fixes v21 edge cases: h=11 → "11:00 AM - 12:00 PM" (was AM); h=23 → "11:00 PM - 12:00 AM" (was 24:00 PM).
  window.formatHour = function (hour) {
    const h = parseInt(hour, 10);
    if (isNaN(h) || h < 0 || h > 23) return String(hour);
    const next = (h + 1) % 24;
    const label = (n) => {
      const period = n >= 12 && n < 24 ? 'PM' : 'AM';
      const twelve = n % 12 === 0 ? 12 : n % 12;
      return `${twelve}:00 ${period}`;
    };
    return `${label(h)} - ${label(next)}`;
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
    return session;
  };

  window.checkInstallerAuth = async function () {
    const { data: { session } } = await db.auth.getSession();
    if (!session) { window.location.href = '../installer/login.html'; return false; }
    return session;
  };
})();
