// PM2 process definition for the ZATCA signing relay (same manager as the SMS relay).
//   pm2 startOrReload deploy/ecosystem.config.js --update-env
// Settings come from ../.env (read by src/env.js), so nothing secret lives here.
//
// Two copies can run side by side on one server (simulation for dev, core for
// production), each in its own folder with its own .env, port and secrets. The
// PM2 name is taken from that folder's .env so they never replace each other:
//   RELAY_NAME if set, else zatca-relay-prod for ZATCA_ENV=core, else zatca-relay.
const fs = require('fs');
const path = require('path');

const appDir = path.join(__dirname, '..');
function envValue(key) {
  try {
    const m = fs.readFileSync(path.join(appDir, '.env'), 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'));
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}
const zatcaEnv = envValue('ZATCA_ENV');
const name = envValue('RELAY_NAME') || (zatcaEnv === 'core' ? 'zatca-relay-prod' : 'zatca-relay');

module.exports = {
  apps: [{
    name,
    script: 'src/server.js',
    cwd: appDir,
    instances: 1,            // ONE process: onboarding and the invoice hash chain must not run twice at once
    exec_mode: 'fork',
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    max_memory_restart: '300M',
    time: true,              // timestamps in pm2 logs
    env: { NODE_ENV: 'production' },
  }],
};
