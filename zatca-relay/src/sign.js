'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { sha256Base64 } = require('./hash');

// ---- credential loading -----------------------------------------------------
function credPath(name) { return path.join(config.certDir, name); }
function loadCreds() {
  return {
    privateKeyPem: fs.readFileSync(credPath('ec-private.pem'), 'utf8'),
    // The production CSID certificate (Base64 PEM). Onboarding writes it here.
    certPem: fs.readFileSync(credPath('cert.pem'), 'utf8'),
  };
}

// ---- ECDSA secp256k1 (node:crypto, dependency-free) -------------------------
// Sign arbitrary bytes; returns the DER ECDSA signature as Base64.
function ecdsaSign(bytes, privateKeyPem) {
  const key = privateKeyPem || loadCreds().privateKeyPem;
  const sig = crypto.createSign('SHA256')
    .update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
    .sign(key);
  return sig.toString('base64');
}
function ecdsaVerify(bytes, signatureB64, certOrPubPem) {
  return crypto.createVerify('SHA256')
    .update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8'))
    .verify(certOrPubPem, Buffer.from(signatureB64, 'base64'));
}

// EGS public key as DER SubjectPublicKeyInfo bytes (QR tag 8).
function publicKeyDer(certPem) {
  const cert = new crypto.X509Certificate(certPem || loadCreds().certPem);
  return cert.publicKey.export({ type: 'spki', format: 'der' });
}

// The X.509 certificate's own signature bytes (QR tag 9 = ZATCA's stamp over the
// EGS public key). A Certificate is SEQUENCE { tbsCertificate, sigAlg, sigValue
// BIT STRING }; we walk the DER and return the final BIT STRING's content.
function certSignatureBytes(certPem) {
  const pem = certPem || loadCreds().certPem;
  const der = pemToDer(pem);
  const r = new DerReader(der);
  r.expect(0x30); r.readLen();          // outer SEQUENCE
  skipTlv(r);                            // tbsCertificate
  skipTlv(r);                            // signatureAlgorithm
  r.expect(0x03);                        // signatureValue BIT STRING
  const len = r.readLen();
  r.pos += 1;                            // skip the "unused bits" byte
  return der.subarray(r.pos, r.pos + len - 1);
}

// ---- minimal DER helpers ----------------------------------------------------
function pemToDer(pem) {
  const b64 = pem.replace(/-----BEGIN[^-]+-----/, '').replace(/-----END[^-]+-----/, '').replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}
class DerReader {
  constructor(buf) { this.buf = buf; this.pos = 0; }
  expect(tag) { if (this.buf[this.pos] !== tag) throw new Error(`DER: expected tag 0x${tag.toString(16)} at ${this.pos}, got 0x${this.buf[this.pos].toString(16)}`); this.pos++; }
  readLen() {
    let b = this.buf[this.pos++];
    if (b < 0x80) return b;
    const n = b & 0x7f; let len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | this.buf[this.pos++];
    return len;
  }
}
function skipTlv(r) { r.pos++; const len = r.readLen(); r.pos += len; }

// ---- XAdES UBL signature assembly (deploy-time; needs xml-crypto) -----------
// Builds the ext:UBLExtensions signature block ZATCA requires and returns the
// signed invoice XML plus the SignatureValue (QR tag 7). This is the most
// compliance-sensitive step and MUST be validated with ZATCA's /compliance/invoices
// sandbox check before go-live (see README). Implemented to the documented spec.
function buildSignedXml(invoiceXml, invoiceHashB64) {
  const { certPem, privateKeyPem } = loadCreds();
  const signingTime = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const certDer = pemToDer(certPem);
  const certB64 = certDer.toString('base64');
  const certHashB64 = sha256Base64(Buffer.from(certB64, 'utf8')); // ZATCA hashes the Base64 cert text

  const cert = new crypto.X509Certificate(certPem);
  const issuerName = cert.issuer.split('\n').reverse().join(', ');
  const serialNumber = BigInt('0x' + cert.serialNumber).toString();

  // SignedProperties (XAdES) — its canonical form is what the SignedInfo digests.
  const signedProps =
`<xades:SignedProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Id="xadesSignedProperties">` +
`<xades:SignedSignatureProperties><xades:SigningTime>${signingTime}</xades:SigningTime>` +
`<xades:SigningCertificate><xades:Cert><xades:CertDigest>` +
`<ds:DigestMethod xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
`<ds:DigestValue xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${certHashB64}</ds:DigestValue></xades:CertDigest>` +
`<xades:IssuerSerial><ds:X509IssuerName xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${issuerName}</ds:X509IssuerName>` +
`<ds:X509SerialNumber xmlns:ds="http://www.w3.org/2000/09/xmldsig#">${serialNumber}</ds:X509SerialNumber></xades:IssuerSerial>` +
`</xades:Cert></xades:SigningCertificate></xades:SignedSignatureProperties></xades:SignedProperties>`;
  const signedPropsHash = sha256Base64(Buffer.from(signedProps, 'utf8'));

  // SignedInfo references the invoice hash (tag 6) and the SignedProperties hash.
  const signedInfo =
`<ds:SignedInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">` +
`<ds:CanonicalizationMethod Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
`<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256"/>` +
`<ds:Reference Id="invoiceSignedData" URI="">` +
`<ds:Transforms>` +
`<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath></ds:Transform>` +
`<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath></ds:Transform>` +
`<ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116"><ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath></ds:Transform>` +
`<ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>` +
`</ds:Transforms>` +
`<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
`<ds:DigestValue>${invoiceHashB64}</ds:DigestValue></ds:Reference>` +
`<ds:Reference URI="#xadesSignedProperties" Type="http://www.w3.org/2000/09/xmldsig#SignedProperties">` +
`<ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/>` +
`<ds:DigestValue>${signedPropsHash}</ds:DigestValue></ds:Reference></ds:SignedInfo>`;

  // ECDSA over the SignedInfo -> SignatureValue (also QR tag 7).
  const signatureB64 = ecdsaSign(Buffer.from(signedInfo, 'utf8'), privateKeyPem);

  const ublExt =
`<ext:UBLExtensions xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">` +
`<ext:UBLExtension><ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>` +
`<ext:ExtensionContent><sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" ` +
`xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" ` +
`xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">` +
`<sac:SignatureInformation><cbc:ID xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">urn:oasis:names:specification:ubl:signature:1</cbc:ID>` +
`<sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>` +
`<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">` +
signedInfo +
`<ds:SignatureValue>${signatureB64}</ds:SignatureValue>` +
`<ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certB64}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>` +
`<ds:Object><xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">` +
signedProps +
`</xades:QualifyingProperties></ds:Object></ds:Signature>` +
`</sac:SignatureInformation></sig:UBLDocumentSignatures></ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions>`;

  // Inject the UBLExtensions as the first child of <Invoice>, and the QR value.
  const qrPlaceholderFilled = invoiceXml; // ubl.js leaves a QR slot the caller fills after this
  const signedXml = qrPlaceholderFilled.replace(/(<Invoice[^>]*>)/, `$1${ublExt}`);

  return { signedXml, signatureB64, signingTime };
}

module.exports = {
  loadCreds, ecdsaSign, ecdsaVerify, publicKeyDer, certSignatureBytes,
  buildSignedXml, pemToDer,
};
