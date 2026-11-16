'use strict';
// Loads zatca-relay/.env into process.env (no dependency). Values already set in
// the real environment win, so PM2 / systemd / the shell can still override.
// Supports KEY=value, quoted values, blank lines and # comments (including a
// trailing "  # comment" after an unquoted value).
const fs = require('fs');
const path = require('path');

function loadEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, '');   // trailing comment
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  return true;
}

module.exports = { loadEnv };
