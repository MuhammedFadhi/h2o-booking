'use strict';
// Central config + ZATCA environment endpoints. All ZATCA APIs live on one host
// (gw-fatoora.zatca.gov.sa) under a per-environment base path.
const path = require('path');
require('./env').loadEnv();   // zatca-relay/.env -> process.env (real env vars win)

const ENVS = {
  'developer-portal': 'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal', // sandbox
  'simulation':       'https://gw-fatoora.zatca.gov.sa/e-invoicing/simulation',       // pre-prod
  'core':             'https://gw-fatoora.zatca.gov.sa/e-invoicing/core',             // PRODUCTION
};

const envName = process.env.ZATCA_ENV || 'developer-portal';
if (!ENVS[envName]) throw new Error(`Unknown ZATCA_ENV "${envName}". Use one of: ${Object.keys(ENVS).join(', ')}`);
// ZATCA_TEST_BASE_URL points a non-production relay at a local mock of the
// Fatoora API (automated tests). Ignored for core, so production always talks to ZATCA.
const base = (envName !== 'core' && process.env.ZATCA_TEST_BASE_URL) || ENVS[envName];

module.exports = {
  envName,
  base,
  // Onboarding + document endpoints (relative to base).
  endpoints: {
    complianceCsid:   `${base}/compliance`,            // POST CSR -> binary security token (compliance CSID)
    complianceInvoice:`${base}/compliance/invoices`,   // POST a signed sample -> pass/fail per invoice type
    productionCsid:   `${base}/production/csids`,       // POST compliance-request-id -> production CSID
    reportingSingle:  `${base}/invoices/reporting/single`, // POST simplified (B2C) invoice -> reported
    clearanceSingle:  `${base}/invoices/clearance/single`,  // POST standard (B2B) invoice -> cleared
  },
  relayApiKey: process.env.RELAY_API_KEY || '',
  port: Number(process.env.PORT || 8791),
  // Listen on localhost only by default: nginx in front terminates HTTPS.
  host: process.env.HOST || '127.0.0.1',
  certDir: path.resolve(process.env.CERT_DIR || './secrets'),
  egs: {
    commonName:   process.env.EGS_COMMON_NAME || 'SADA-H2O-EGS-001',
    serialNumber: process.env.EGS_SERIAL_NUMBER || '1-SADA|2-H2O|3-0001',
    orgIdentifier:process.env.EGS_ORG_IDENTIFIER || '',
    orgUnitName:  process.env.EGS_ORG_UNIT_NAME || process.env.EGS_ORG_IDENTIFIER || '',
    orgName:      process.env.EGS_ORG_NAME || 'Saadat Alarab Company For Trading',
    country:      process.env.EGS_COUNTRY || 'SA',
    invoiceType:  process.env.EGS_INVOICE_TYPE || '0100',
    location:     process.env.EGS_LOCATION || 'Al Khobar',
    industry:     process.env.EGS_INDUSTRY || 'Water purification',
  },
  otp: process.env.ZATCA_OTP || '',
};
