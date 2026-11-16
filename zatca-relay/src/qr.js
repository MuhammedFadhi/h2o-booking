'use strict';
// ZATCA Phase-2 QR code = Base64 of a TLV (Tag-Length-Value) sequence of 9 fields.
//   1 seller name        2 VAT number        3 ISO-8601 timestamp
//   4 invoice total (incl VAT)               5 VAT total
//   6 invoice XML hash (Base64)              7 ECDSA signature (Base64)
//   8 EGS public key (DER SubjectPublicKeyInfo bytes)
//   9 ZATCA's signature over the EGS public key = the signature bytes of the CSID
//     certificate (simplified invoices only).
// Tags 1-7 are text (UTF-8); tags 8-9 are raw bytes. Length is a single byte
// (all these fields are < 256 bytes).

function tlv(tag, value) {
  const bytes = Buffer.isBuffer(value)
    ? value
    : Buffer.from(String(value == null ? '' : value), 'utf8');
  return Buffer.concat([Buffer.from([tag, bytes.length]), bytes]);
}

// p: { sellerName, vatNumber, timestamp, total, vatTotal,
//      invoiceHash, signature, publicKeyDer(Buffer), certSignature(Buffer) }
// Pass only 1-5 to get the Phase-1 QR; pass 6-9 for the full Phase-2 QR.
function buildQr(p) {
  const parts = [
    tlv(1, p.sellerName || ''),
    tlv(2, p.vatNumber || ''),
    tlv(3, p.timestamp || new Date().toISOString()),
    tlv(4, String(p.total)),
    tlv(5, String(p.vatTotal)),
  ];
  if (p.invoiceHash != null) parts.push(tlv(6, p.invoiceHash));
  if (p.signature != null)   parts.push(tlv(7, p.signature));
  if (p.publicKeyDer != null) parts.push(tlv(8, p.publicKeyDer));
  if (p.certSignature != null) parts.push(tlv(9, p.certSignature));
  return Buffer.concat(parts).toString('base64');
}

// Decode a Base64 QR back to [{tag, value(Buffer)}] — used by the self-test.
function decodeQr(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i], len = buf[i + 1];
    out.push({ tag, value: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

module.exports = { buildQr, decodeQr, tlv };
