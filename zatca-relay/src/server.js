'use strict';
// The relay HTTP endpoint. The dashboard/Worker POST an invoice here; the relay
// builds UBL, hashes, signs (ECDSA secp256k1), builds the Phase-2 QR, and reports
// (simplified) or clears (standard) to ZATCA. The private key never leaves here.
//
// Put this behind TLS / a reverse proxy, like the SMS relay. Caller must send the
// shared secret in `x-relay-key`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const ubl = require('./ubl');
const { invoiceHash } = require('./hash');
const sign = require('./sign');
const { buildQr } = require('./qr');
const zatca = require('./zatca');
const onboarding = require('./onboarding');

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function loadCsidToken() {
  // Production CSID (binarySecurityToken + secret) written by onboarding.
  const p = path.join(config.certDir, 'production-csid.json');
  if (!fs.existsSync(p)) throw new Error('No production CSID found — run `npm run onboard` first.');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Build + sign + stamp the QR into the final signed XML for one invoice.
function signInvoice(data) {
  const built = ubl.build(data);                    // UBL with empty QR slot
  const hash = invoiceHash(built.xml);              // tag 6
  const { signedXml, signatureB64 } = sign.buildSignedXml(built.xml, hash); // injects UBLExtensions, tag 7
  const qr = buildQr({
    sellerName: built.sellerName, vatNumber: built.vatNumber, timestamp: built.issueInstant,
    total: built.totals.taxInclusive.toFixed(2), vatTotal: built.totals.vat.toFixed(2),
    invoiceHash: hash, signature: signatureB64,
    publicKeyDer: sign.publicKeyDer(), certSignature: sign.certSignatureBytes(),
  });
  const finalXml = signedXml.replace('__QR__', qr);
  return { finalXml, hash, uuid: built.uuid, qr, totals: built.totals };
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-relay-key'] || ''));
  const want = Buffer.from(config.relayApiKey || '');
  return want.length > 0 && given.length === want.length && require('crypto').timingSafeEqual(given, want);
}

let onboardingRunning = false;

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, env: config.envName });
    const route = `${req.method} ${req.url}`;
    if (!['GET /status', 'POST /onboard', 'POST /sign-report'].includes(route)) return send(res, 404, { error: 'Not found' });
    if (!authorized(req)) return send(res, 401, { error: 'Unauthorized' });

    // Environment + onboarding state for the dashboard's ZATCA page.
    if (route === 'GET /status') return send(res, 200, { ok: true, ...onboarding.status() });

    // Onboarding from the dashboard: OTP + seller details from Tax / Company info.
    if (route === 'POST /onboard') {
      if (onboardingRunning) return send(res, 409, { error: 'Onboarding is already running — wait for it to finish.' });
      onboardingRunning = true;
      try {
        const body = await readJson(req);
        const out = await onboarding.onboard({ otp: body.otp, seller: body.seller || {} }, signInvoice);
        return send(res, 200, out);
      } catch (e) {
        return send(res, 400, { error: e.message, steps: e.steps || [], zatca: e.zatca || e.body || null, status: onboarding.status() });
      } finally {
        onboardingRunning = false;
      }
    }

    const data = await readJson(req);
    if (!data.invoiceNumber) return send(res, 400, { error: 'invoiceNumber required' });

    const { finalXml, hash, uuid, qr } = signInvoice(data);
    const invoiceBase64 = Buffer.from(finalXml, 'utf8').toString('base64');

    const { token, secret } = loadCsidToken();
    const isStandard = data.invoiceType === 'standard';
    let zres;
    try {
      zres = isStandard
        ? await zatca.clearInvoice({ invoiceBase64, invoiceHash: hash, uuid }, token, secret)
        : await zatca.reportInvoice({ invoiceBase64, invoiceHash: hash, uuid }, token, secret);
    } catch (e) {
      // The invoice is already signed + QR-stamped; surface it even if ZATCA
      // submission failed so the caller can retry reporting within 24h.
      return send(res, 502, {
        error: 'ZATCA submission failed', detail: e.message, zatca: e.body || null,
        env: config.envName, uuid, invoiceHash: hash, qr, reported: false,
      });
    }
    const status = isStandard ? zres.clearanceStatus : zres.reportingStatus;
    send(res, 200, {
      ok: true, env: config.envName, uuid, invoiceHash: hash, qr,
      status, reported: !isStandard, cleared: isStandard,
      warnings: zres.validationResults?.warningMessages || [],
      zatca: zres,
    });
  } catch (e) {
    send(res, 500, { error: e.message || 'Server error' });
  }
});

if (require.main === module) {
  if (!config.relayApiKey || config.relayApiKey.length < 32) {
    console.error('RELAY_API_KEY is missing or shorter than 32 characters — set it in .env (deploy/install.sh generates one).');
    process.exit(1);
  }
  server.listen(config.port, config.host, () => console.log(`ZATCA relay [${config.envName}] on ${config.host}:${config.port}`));
}
module.exports = { server, signInvoice };
