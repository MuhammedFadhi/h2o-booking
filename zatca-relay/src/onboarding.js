'use strict';
// ZATCA onboarding (shared by the CLI `npm run onboard` and the dashboard's
// "Onboard" button via POST /onboard).
//
//   1. generate the EGS private key + CSR
//   2. compliance CSID   (needs the one-time OTP from the Fatoora portal)
//   3. compliance checks (sign + submit a sample invoice, credit note and debit
//                         note for every invoice type the EGS declares)
//   4. production CSID   (the certificate live invoices are signed with)
//
// Like Al Amanah's integration it resumes: if a compliance certificate already
// exists (step 2 done, a later step failed) it continues from step 3 without a
// new OTP. Once a production certificate exists it refuses to run again, so a
// working certificate is never replaced by accident.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { generateKeyAndCsr } = require('./csr');
const zatca = require('./zatca');

const SEED_PIH = crypto.createHash('sha256').update('0').digest('base64');

function filePath(name) { return path.join(config.certDir, name); }
function readJson(name) {
  const p = filePath(name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}
function write(name, content) {
  fs.mkdirSync(config.certDir, { recursive: true });
  fs.writeFileSync(filePath(name), content, { mode: 0o600 });
}
// The binarySecurityToken is the certificate, Base64 of either PEM text or raw Base64 DER.
function certPemFromToken(token) {
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  if (decoded.includes('BEGIN CERTIFICATE')) return decoded;
  const b64 = /^[A-Za-z0-9+/=\s]+$/.test(decoded) && decoded.length > 100 ? decoded.replace(/\s+/g, '') : token;
  return `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

// What the dashboard's ZATCA page shows.
function status() {
  const prod = readJson('production-csid.json');
  const comp = readJson('compliance-csid.json');
  let cert = null;
  try {
    if (fs.existsSync(filePath('cert.pem'))) {
      const x = new crypto.X509Certificate(fs.readFileSync(filePath('cert.pem'), 'utf8'));
      cert = { validTo: new Date(x.validTo).toISOString(), subject: x.subject.replace(/\n/g, ', ') };
    }
  } catch (e) { cert = { error: 'cert.pem could not be read: ' + e.message }; }
  return {
    environment: config.envName,
    onboarded: !!(prod && prod.token && prod.secret),
    hasCompliance: !!(comp && comp.token && comp.secret),
    onboardedAt: prod?.issuedAt || null,
    certificate: cert,
    // What the CERTIFICATE allows (recorded at onboarding); older records fall
    // back to the current setting.
    invoiceTypes: prod?.invoiceTypes || config.egs.invoiceType,
    egs: { commonName: config.egs.commonName, serialNumber: config.egs.serialNumber },
  };
}

// The documents ZATCA's compliance step must see for the declared invoice
// types (EGS_INVOICE_TYPE: position 1 = standard, position 2 = simplified).
function complianceDocs(invoiceTypes) {
  const t = String(invoiceTypes || '0100');
  const kinds = [];
  if (t[0] === '1') kinds.push('standard');
  if (t[1] === '1') kinds.push('simplified');
  const docs = [];
  for (const kind of kinds) {
    for (const docType of ['invoice', 'credit', 'debit']) docs.push({ kind, docType });
  }
  return docs;
}

// seller: { vatNumber, name, crNumber, street, building, plot, district, city, postalZone }
// signInvoice is passed in (from server.js) to avoid a require cycle.
async function onboard({ otp, seller = {}, log = () => {} }, signInvoice) {
  const st = status();
  if (st.onboarded) {
    throw new Error(`Already onboarded for ${config.envName}. To re-onboard (e.g. after the certificate expires), move the files in the secrets folder aside first.`);
  }
  const steps = [];
  const step = (msg) => { steps.push(msg); log(msg); };

  let comp = readJson('compliance-csid.json');
  if (comp && comp.token && comp.secret) {
    step('Compliance certificate already issued — continuing from the compliance checks.');
  } else {
    if (!otp || !/^\d{4,10}$/.test(String(otp).trim())) {
      throw new Error('Enter the OTP from the Fatoora portal (digits only, valid for 1 hour).');
    }
    step('Generating the private key and CSR…');
    const { csrBase64 } = generateKeyAndCsr({ orgIdentifier: seller.vatNumber, orgName: seller.nameEn || seller.name, location: seller.city });
    step('Requesting the compliance certificate (CSID)…');
    let res;
    try {
      res = await zatca.requestComplianceCsid(csrBase64, String(otp).trim());
    } catch (e) {
      if (e.status === 400 || e.status === 401) {
        const err = new Error('ZATCA refused the OTP: it may be wrong, already used, or older than 1 hour. Generate a new one in the Fatoora portal and try again.');
        err.zatca = e.body; err.steps = steps; throw err;
      }
      e.steps = steps; throw e;
    }
    comp = { requestId: res.requestID, token: res.binarySecurityToken, secret: res.secret, issuedAt: new Date().toISOString() };
    write('cert.pem', certPemFromToken(comp.token));   // compliance cert signs the checks
    write('compliance-csid.json', JSON.stringify(comp, null, 2));
    step(`Compliance certificate issued (request ${comp.requestId}).`);
  }

  // Compliance checks: sign each sample with the compliance cert and submit it.
  const docs = complianceDocs(config.egs.invoiceTypes || config.egs.invoiceType);
  if (!docs.length) throw new Error('EGS_INVOICE_TYPE declares no invoice types (expected e.g. 0100 for simplified only).');
  let pih = SEED_PIH;
  const sellerData = {
    vatNumber: seller.vatNumber || config.egs.orgIdentifier, name: seller.name || config.egs.orgName,
    crNumber: seller.crNumber || '', street: seller.street || '', building: seller.building || '',
    plot: seller.plot || '', district: seller.district || '', city: seller.city || config.egs.location,
    postalZone: seller.postalZone || '', countryCode: 'SA',
  };
  const testBuyer = {
    name: 'Compliance Test Customer', vatNumber: '399999999900003',
    street: 'King Fahd Road', building: '1234', district: 'Al Olaya', city: 'Riyadh',
    postalZone: '12345', countryCode: 'SA',
  };
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    const label = `${d.kind} ${d.docType === 'invoice' ? 'invoice' : d.docType + ' note'}`;
    const signed = signInvoice({
      invoiceNumber: `SME-COMPLIANCE-${i + 1}`, icv: i + 1, pih,
      invoiceType: d.kind, docType: d.docType,
      billingReference: d.docType === 'invoice' ? undefined : 'SME-COMPLIANCE-1',
      reason: d.docType === 'credit' ? 'Returned item' : (d.docType === 'debit' ? 'Price adjustment' : undefined),
      seller: sellerData,
      buyer: d.kind === 'standard' ? testBuyer : { name: 'Compliance Check' },
      lines: [{ name: 'RO Water Purifier', qty: 1, unitPriceInclVat: 115 }],
      totalInclVat: 115,
    });
    try {
      const chk = await zatca.checkComplianceInvoice(
        { invoiceBase64: Buffer.from(signed.finalXml, 'utf8').toString('base64'), invoiceHash: signed.hash, uuid: signed.uuid },
        comp.token, comp.secret);
      const vs = chk.validationResults?.status || chk.reportingStatus || chk.clearanceStatus || 'OK';
      if (String(vs).toUpperCase() === 'ERROR') {
        const err = new Error(`Compliance check failed for the ${label}.`);
        err.zatca = chk; throw err;
      }
      step(`Compliance check passed: ${label} (${vs}).`);
    } catch (e) {
      if (/Submitted before/i.test(e.message)) { step(`Compliance check already passed earlier: ${label}.`); }
      else { e.steps = steps; throw e; }
    }
    pih = signed.hash;
  }

  step('Requesting the production certificate…');
  const prod = await zatca.requestProductionCsid(comp.requestId, comp.token, comp.secret);
  const prodRec = {
    requestId: prod.requestID, token: prod.binarySecurityToken, secret: prod.secret,
    issuedAt: new Date().toISOString(), invoiceTypes: String(config.egs.invoiceType || '0100'),
  };
  write('cert.pem', certPemFromToken(prodRec.token));  // replace with the PRODUCTION cert
  write('production-csid.json', JSON.stringify(prodRec, null, 2));
  step('Production certificate active. Onboarding complete.');
  return { ok: true, steps, status: status() };
}

module.exports = { onboard, status, certPemFromToken, complianceDocs };
