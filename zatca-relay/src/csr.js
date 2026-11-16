'use strict';
// Generates the EGS private key (ECDSA secp256k1) and the Certificate Signing
// Request ZATCA onboarding needs. The CSR carries ZATCA's custom fields:
//   - certificateTemplateName extension (OID 1.3.6.1.4.1.311.20.2), value per env
//   - subjectAltName/dirName with SN (EGS serial), UID (VAT no.), title (invoice
//     type), registeredAddress (location), businessCategory (industry)
// We shell out to openssl because EC CSRs with custom extensions are most
// reliably produced that way (the host already has openssl, like the SMS relay box).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('./config');

// The certificate template name ZATCA expects differs per environment.
const TEMPLATE = {
  'developer-portal': 'TSTZATCA-Code-Signing',
  'simulation':       'PREZATCA-Code-Signing',
  'core':             'ZATCA-Code-Signing',
};

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function opensslConfig() {
  const e = config.egs;
  const template = TEMPLATE[config.envName];
  // invoiceType: 4 digits; position 1 = standard (1/0), position 2 = simplified (1/0).
  return `oid_section = OIDs
[ OIDs ]
certificateTemplateName = 1.3.6.1.4.1.311.20.2
[ req ]
default_bits = 2048
prompt = no
default_md = sha256
req_extensions = req_ext
distinguished_name = dn
[ dn ]
CN = ${e.commonName}
OU = ${e.orgUnitName}
O = ${e.orgName}
C = ${e.country}
[ req_ext ]
certificateTemplateName = ASN1:PRINTABLESTRING:${template}
subjectAltName = dirName:alt_names
[ alt_names ]
SN = ${e.serialNumber}
UID = ${e.orgIdentifier}
title = ${e.invoiceType}
registeredAddress = ${e.location}
businessCategory = ${e.industry}
`;
}

// Generates key + CSR (idempotent on the key: reuses an existing private key so
// re-running onboarding doesn't orphan an issued certificate). Returns the CSR
// Base64-encoded, which is what the ZATCA compliance endpoint expects.
function generateKeyAndCsr() {
  ensureDir(config.certDir);
  const keyPath = path.join(config.certDir, 'ec-private.pem');
  const cnfPath = path.join(config.certDir, 'csr.cnf');
  const csrPath = path.join(config.certDir, 'csr.pem');

  if (!fs.existsSync(keyPath)) {
    execFileSync('openssl', ['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', keyPath]);
  }
  fs.writeFileSync(cnfPath, opensslConfig());
  execFileSync('openssl', ['req', '-new', '-sha256', '-key', keyPath, '-config', cnfPath, '-out', csrPath]);

  const csrPem = fs.readFileSync(csrPath, 'utf8');
  const csrBase64 = Buffer.from(csrPem, 'utf8').toString('base64');
  return { csrPem, csrBase64, keyPath, csrPath };
}

module.exports = { generateKeyAndCsr, TEMPLATE };
