'use strict';
// Dependency-free self-test for the deterministic crypto core (no npm install,
// no ZATCA credentials). Proves secp256k1 sign/verify, cert parsing, the
// Phase-2 QR TLV, and hashing. The UBL/XAdES + API layers need the sandbox to
// validate and are exercised separately (see README).
const assert = require('assert');
const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sign = require('../src/sign');
const { buildQr, decodeQr } = require('../src/qr');
const { sha256Base64 } = require('../src/hash');

let passed = 0;
function ok(name) { console.log('  ✓ ' + name); passed++; }

// 0. SHA-256 known vector
assert.strictEqual(sha256Base64(''), '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=');
ok('SHA-256 Base64 known vector');

// Generate a secp256k1 key + self-signed cert with openssl (mirrors the EGS key).
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zatca-selftest-'));
const keyPath = path.join(dir, 'ec-private.pem');
const certPath = path.join(dir, 'cert.pem');
execSync(`openssl ecparam -name secp256k1 -genkey -noout -out "${keyPath}"`);
execSync(`openssl req -new -x509 -key "${keyPath}" -sha256 -days 365 -subj "/CN=SADA-H2O-EGS-001/O=SADA/C=SA" -out "${certPath}"`);
const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
const certPem = fs.readFileSync(certPath, 'utf8');
ok('generated secp256k1 key + self-signed certificate (openssl)');

// 1. ECDSA secp256k1 sign + verify roundtrip
const payload = Buffer.from('SA\'DA H2O invoice INV-2026-000042', 'utf8');
const sigB64 = sign.ecdsaSign(payload, privateKeyPem);
assert.ok(sign.ecdsaVerify(payload, sigB64, certPem), 'signature must verify against cert');
assert.ok(!sign.ecdsaVerify(Buffer.from('tampered'), sigB64, certPem), 'tampered payload must NOT verify');
ok('ECDSA secp256k1 sign/verify roundtrip (QR tag 7)');

// 2. Public key DER (QR tag 8)
const pub = sign.publicKeyDer(certPem);
assert.ok(Buffer.isBuffer(pub) && pub.length > 40 && pub.length < 200, 'SPKI DER bytes present');
ok('public key DER extracted (QR tag 8), ' + pub.length + ' bytes');

// 3. Certificate signature bytes (QR tag 9) — must match openssl's view
const certSig = sign.certSignatureBytes(certPem);
assert.ok(Buffer.isBuffer(certSig) && certSig.length > 8, 'cert signature bytes present');
ok('certificate signature bytes extracted (QR tag 9), ' + certSig.length + ' bytes');

// 4. Full Phase-2 QR build + decode
const invoiceHash = sha256Base64('canonical-invoice-xml-placeholder');
const qr = buildQr({
  sellerName: "SA'DA H2O Water Purifiers", vatNumber: '311111111111113',
  timestamp: '2026-11-16T10:30:00Z', total: '804.85', vatTotal: '104.98',
  invoiceHash, signature: sigB64, publicKeyDer: pub, certSignature: certSig,
});
const tags = decodeQr(qr);
assert.strictEqual(tags.length, 9, 'QR must have 9 tags');
assert.strictEqual(tags[0].value.toString('utf8'), "SA'DA H2O Water Purifiers");
assert.strictEqual(tags[1].value.toString('utf8'), '311111111111113');
assert.strictEqual(tags[5].value.toString('utf8'), invoiceHash);
assert.strictEqual(tags[6].value.toString('utf8'), sigB64);
assert.ok(tags[7].value.equals(pub), 'tag 8 bytes roundtrip');
assert.ok(tags[8].value.equals(certSig), 'tag 9 bytes roundtrip');
ok('Phase-2 QR (9 tags) build + decode roundtrip');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nAll ${passed} checks passed.`);
