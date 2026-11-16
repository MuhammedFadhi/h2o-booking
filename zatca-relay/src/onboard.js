'use strict';
// Onboarding CLI:  npm run onboard
// Same steps as the dashboard's "Onboard" button (see onboarding.js); handy on
// the server itself. Needs a fresh OTP from the Fatoora portal in ZATCA_OTP
// (valid ~1 hour) unless a compliance certificate was already issued.
const config = require('./config');
const { onboard } = require('./onboarding');
const { signInvoice } = require('./server');

console.log(`ZATCA onboarding — env: ${config.envName}`);
onboard({ otp: config.otp, log: (m) => console.log('  ' + m) }, signInvoice)
  .then(() => {
    console.log('\nDone. Keep the secrets folder private and backed up.');
    process.exit(0);
  })
  .catch((e) => {
    console.error('\nOnboarding error:', e.message);
    if (e.zatca) console.error(JSON.stringify(e.zatca, null, 2));
    process.exit(1);
  });
