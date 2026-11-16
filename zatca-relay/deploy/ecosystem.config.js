// PM2 process definition for the ZATCA signing relay (same manager as the SMS relay).
//   pm2 startOrReload deploy/ecosystem.config.js --update-env
// Settings come from ../.env (read by src/env.js), so nothing secret lives here.
const path = require('path');

module.exports = {
  apps: [{
    name: 'zatca-relay',
    script: 'src/server.js',
    cwd: path.join(__dirname, '..'),
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
