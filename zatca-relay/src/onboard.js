'use strict';
// Onboarding CLI:  npm run onboard
// Walks the three ZATCA steps and writes the issued credentials to CERT_DIR.
// Requires a fresh OTP from the Fatoora portal in ZATCA_OTP (valid ~1 hour).
//
//   1. generate key + CSR
//   2. compliance CSID (uses OTP)
//   3. compliance invoice checks  (prints result; must PASS for your invoice types)
//   4. production CSID            (writes production-csid.json + cert.pem)
//
// Step 3's sample invoices must match your declared invoice types; a simplified
// (B2C) EGS must pass the simplified invoice + its credit/debit notes. This script
// runs the calls; iterate here against the sandbox until every check is PASS.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { generateKeyAndCsr } = require('./csr');
const zatca = require('./zatca');
const { signInvoice } = require('./server');

function write(name, content) {
  const p = path.join(config.certDir, name);
  fs.writeFileSync(p, content);
  console.log(`  wrote ${p}`);
}
function certPemFromToken(binarySecurityToken) {
  // The binarySecurityToken IS the certificate, Base64 (no PEM armour).
  const b64 = Buffer.from(binarySecurityToken, 'base64').toString('utf8').includes('BEGIN')
    ? Buffer.from(binarySecurityToken, 'base64').toString('utf8')
    : `-----BEGIN CERTIFICATE-----\n${binarySecurityToken.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return b64;
}

async function main() {
  console.log(`ZATCA onboarding — env: ${config.envName}`);
  if (!config.otp) throw new Error('Set ZATCA_OTP (fresh OTP from the Fatoora portal) in .env');

  console.log('\n1) Generating key + CSR…');
  const { csrBase64 } = generateKeyAndCsr();

  console.log('2) Requesting compliance CSID…');
  const comp = await zatca.requestComplianceCsid(csrBase64, config.otp);
  write('cert.pem', certPemFromToken(comp.binarySecurityToken)); // compliance cert for step 3 signing
  write('compliance-csid.json', JSON.stringify({
    requestId: comp.requestID, token: comp.binarySecurityToken, secret: comp.secret,
  }, null, 2));
  console.log(`   compliance CSID ok (requestID ${comp.requestID})`);

  console.log('3) Compliance invoice checks…');
  // A representative simplified invoice signed with the COMPLIANCE cert.
  const sample = signInvoice({
    invoiceNumber: 'INV-COMPLIANCE-001', icv: 1,
    pih: 'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZj79979b2hhbA==',
    invoiceType: 'simplified',
    seller: { vatNumber: config.egs.orgIdentifier, name: config.egs.orgName, city: config.egs.location, countryCode: 'SA' },
    buyer: { name: 'Compliance Check' },
    lines: [{ name: 'RO Purifier', qty: 1, unitPriceInclVat: 115 }],
    totalInclVat: 115,
  });
  const sampleB64 = Buffer.from(sample.finalXml, 'utf8').toString('base64');
  try {
    const chk = await zatca.checkComplianceInvoice(
      { invoiceBase64: sampleB64, invoiceHash: sample.hash, uuid: sample.uuid },
      comp.token || comp.binarySecurityToken, comp.secret);
    console.log('   compliance check:', JSON.stringify(chk.validationResults?.status || chk, null, 2));
  } catch (e) {
    console.error('   compliance check FAILED:', e.message);
    console.error('   Fix the signed-invoice output against the sandbox, then re-run. Not proceeding to production CSID.');
    process.exit(1);
  }

  console.log('4) Requesting production CSID…');
  const prod = await zatca.requestProductionCsid(comp.requestID, comp.binarySecurityToken, comp.secret);
  write('cert.pem', certPemFromToken(prod.binarySecurityToken)); // overwrite with PRODUCTION cert
  write('production-csid.json', JSON.stringify({
    requestId: prod.requestID, token: prod.binarySecurityToken, secret: prod.secret,
  }, null, 2));
  console.log('\nDone. Production CSID + cert written to', config.certDir);
  console.log('Keep these secret and backed up. The relay (npm start) can now sign live invoices.');
}

main().catch((e) => { console.error('\nOnboarding error:', e.message); process.exit(1); });
