'use strict';
// ZATCA Fatoora API client — onboarding (CSID) + document (reporting/clearance).
// Uses Node 18+ global fetch. Auth for document + production steps is HTTP Basic
// with (binarySecurityToken : secret) from the issued CSID.
const config = require('./config');

function basicAuth(token, secret) {
  return 'Basic ' + Buffer.from(`${token}:${secret}`).toString('base64');
}
async function call(url, { method = 'POST', headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Accept-Version': 'V2', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    // Keep ZATCA's validationResults whole: the dashboard turns its error and
    // warning codes into plain-language reasons on the Pending page.
    const msg = json?.validationResults ? JSON.stringify({ validationResults: json.validationResults })
      : json?.errors ? JSON.stringify(json.errors) : (json?.message || text || res.statusText);
    const err = new Error(`ZATCA ${res.status} ${url}: ${msg}`);
    err.status = res.status; err.body = json;
    throw err;
  }
  return json;
}

// 1) Compliance CSID — exchange the CSR for a compliance certificate, gated by the
//    one-time OTP generated in the Fatoora portal.
async function requestComplianceCsid(csrBase64, otp) {
  return call(config.endpoints.complianceCsid, {
    headers: { OTP: otp },
    body: { csr: csrBase64 },
  });
}

// 2) Compliance invoice check — prove the EGS can sign each declared invoice type.
async function checkComplianceInvoice({ invoiceBase64, invoiceHash, uuid }, token, secret) {
  return call(config.endpoints.complianceInvoice, {
    headers: { Authorization: basicAuth(token, secret) },
    body: { invoiceHash, uuid, invoice: invoiceBase64 },
  });
}

// 3) Production CSID — once compliance passes, swap the compliance request id for
//    the production certificate used to sign live invoices.
async function requestProductionCsid(complianceRequestId, token, secret) {
  return call(config.endpoints.productionCsid, {
    headers: { Authorization: basicAuth(token, secret) },
    body: { compliance_request_id: complianceRequestId },
  });
}

// 4a) Reporting — simplified (B2C) invoices, after issuance (within 24h).
async function reportInvoice({ invoiceBase64, invoiceHash, uuid }, token, secret) {
  return call(config.endpoints.reportingSingle, {
    headers: { Authorization: basicAuth(token, secret), 'Clearance-Status': '0' },
    body: { invoiceHash, uuid, invoice: invoiceBase64 },
  });
}

// 4b) Clearance — standard (B2B) invoices, BEFORE issuance.
async function clearInvoice({ invoiceBase64, invoiceHash, uuid }, token, secret) {
  return call(config.endpoints.clearanceSingle, {
    headers: { Authorization: basicAuth(token, secret), 'Clearance-Status': '1' },
    body: { invoiceHash, uuid, invoice: invoiceBase64 },
  });
}

module.exports = {
  requestComplianceCsid, checkComplianceInvoice, requestProductionCsid,
  reportInvoice, clearInvoice,
};
