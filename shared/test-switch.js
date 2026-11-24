// Hidden LIVE <-> TEST switch for the installer pages (also works inside the
// installer APK, which simply shows these pages).
//
// Tap the SA'DA logo 6 times within 3 seconds -> confirm -> the installer login
// of the other system opens: LIVE (booking.sadawater.com, real data) or TEST
// (dev-booking.sadawater.com, test data). The address decides the database
// (see shared/supabase.js), so code and data always match.
// Closing and reopening the APK always starts on LIVE again.
(function () {
  var LIVE = 'https://booking.sadawater.com';
  var TEST = 'https://dev-booking.sadawater.com';
  var onTest = location.hostname === 'dev-booking.sadawater.com';

  // Small note on the TEST login page only, so it is clear which system you are on.
  if (onTest) {
    var addNote = function () {
      var badge = document.querySelector('.login-card .badge');
      if (!badge || document.getElementById('dev-server-note')) return;
      var note = document.createElement('div');
      note.id = 'dev-server-note';
      note.textContent = 'Dev server (test data)';
      note.style.cssText = 'margin:8px auto 0;font-size:12px;font-weight:700;color:#B45309;text-align:center;';
      badge.insertAdjacentElement('afterend', note);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addNote); else addNote();
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
