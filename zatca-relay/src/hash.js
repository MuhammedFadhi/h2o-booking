'use strict';
const crypto = require('crypto');

// Plain SHA-256 -> Base64. Dependency-free (used by the self-test).
function sha256Base64(data) {
  return crypto.createHash('sha256')
    .update(Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'))
    .digest('base64');
}

// The ZATCA invoice hash: canonicalize the invoice XML (after removing the three
// elements ZATCA excludes from the hash) then SHA-256 -> Base64.
//
// Per ZATCA's signing spec the hash is taken over the document with these removed:
//   - ext:UBLExtensions            (the signature block itself)
//   - cac:Signature                (the UBL Signature reference)
//   - cac:AdditionalDocumentReference where cbc:ID = 'QR'  (the QR node)
// then canonicalized with C14N 1.1. xml-crypto + @xmldom/xmldom are required at
// deploy time (declared in package.json); loaded lazily so the dep-free
// self-test can still run without them installed.
function invoiceHash(xmlString) {
  const { DOMParser } = require('@xmldom/xmldom');
  const { C14nCanonicalization } = require('xml-crypto/lib/c14n-canonicalization');
  const xpath = require('xpath');

  const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
  const select = xpath.useNamespaces({
    ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
    cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
  });

  const remove = [
    "//ext:UBLExtensions",
    "//cac:Signature",
    "//cac:AdditionalDocumentReference[cbc:ID='QR']",
  ];
  for (const q of remove) {
    for (const node of select(q, doc)) {
      if (node.parentNode) node.parentNode.removeChild(node);
    }
  }

  const canon = new C14nCanonicalization().process(doc.documentElement, {
    inclusiveNamespacesPrefixList: '',
  });
  return crypto.createHash('sha256').update(Buffer.from(canon, 'utf8')).digest('base64');
}

module.exports = { sha256Base64, invoiceHash };
