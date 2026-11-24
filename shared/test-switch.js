// Hidden LIVE <-> TEST switch for the installer pages (also works inside the
// installer APK, which simply shows these pages).
//
// Tap the SA'DA logo 6 times within 3 seconds -> confirm -> the installer login
// of the other system opens: LIVE (booking.sadawater.com, real data) or TEST
// (dev-booking.sadawater.com, test data). The address decides the database
// (see shared/supabase.js), so code and data always match.
// On the TEST site a red "TEST SYSTEM" tag stays on screen. Closing and
// reopening the APK always starts on LIVE again.
(function () {
  var LIVE = 'https://booking.sadawater.com';
  var TEST = 'https://dev-booking.sadawater.com';
  var onTest = location.hostname === 'dev-booking.sadawater.com';

  if (onTest) {
    var tag = document.createElement('div');
    tag.textContent = '🧪 TEST SYSTEM — not real data';
    tag.setAttribute('role', 'status');
    tag.style.cssText = 'position:fixed;left:50%;bottom:calc(10px + env(safe-area-inset-bottom));transform:translateX(-50%);' +
      'z-index:99999;background:#DC2626;color:#fff;font:700 12px/1 "Public Sans",sans-serif;padding:7px 14px;' +
      'border-radius:999px;box-shadow:0 4px 12px rgba(0,0,0,.25);pointer-events:none;white-space:nowrap;';
    var add = function () { document.body.appendChild(tag); };
    if (document.body) add(); else document.addEventListener('DOMContentLoaded', add);
  }

  var taps = [];
  document.addEventListener('click', function (e) {
    var logo = e.target.closest && e.target.closest('img.logo, header img');
    if (!logo) return;
    var now = Date.now();
    taps = taps.filter(function (t) { return now - t < 3000; });
    taps.push(now);
    if (taps.length < 6) return;
    taps = [];
    var toTest = !onTest;
    var ok = confirm(toTest
      ? 'Switch to the TEST system?\n\nIt uses TEST data, not real jobs. Log in with a test account. Close and reopen the app to come back to LIVE.'
      : 'Switch back to the LIVE system (real jobs)?');
    if (ok) location.href = (toTest ? TEST : LIVE) + '/installer/login.html';
  }, true);
})();
