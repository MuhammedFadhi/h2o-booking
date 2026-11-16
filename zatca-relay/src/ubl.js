'use strict';
// Builds a ZATCA-flavoured UBL 2.1 Invoice (simplified/B2C by default). Leaves an
// empty QR slot (cbc:ID='QR') that the caller fills after signing, and no
// UBLExtensions (sign.js injects the signature block). Money is 2dp SAR.
const crypto = require('crypto');

const VAT_RATE = 0.15;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const f2 = (n) => r2(n).toFixed(2);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// Normalise lines to net (excl VAT) unit prices. Accept either excl or incl.
function normLines(lines) {
  return (lines || []).map((l) => {
    const qty = Number(l.qty) || 1;
    const unitNet = l.unitPriceExclVat != null
      ? Number(l.unitPriceExclVat)
      : r2((Number(l.unitPriceInclVat) || 0) / (1 + VAT_RATE));
    const lineNet = r2(qty * unitNet);
    const lineVat = r2(lineNet * VAT_RATE);
    return { name: l.name || 'Item', qty, unitNet: r2(unitNet), lineNet, lineVat };
  });
}

// data: { invoiceNumber, uuid?, issueInstant?(ISO), icv, pih, invoiceType,
//         seller:{vatNumber,name,street,building,district,city,postalZone,countryCode},
//         buyer:{name?,phone?}, lines:[...], totalInclVat? }
function build(data) {
  const uuid = data.uuid || crypto.randomUUID();
  const now = data.issueInstant ? new Date(data.issueInstant) : new Date();
  const issueInstant = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const issueDate = issueInstant.slice(0, 10);
  const issueTime = issueInstant.slice(11, 19);

  const lines = normLines(data.lines);
  const lineExtNet = r2(lines.reduce((s, l) => s + l.lineNet, 0));
  // When a discount made the booking total lower than the sum of lines, book it
  // as a document-level allowance so the totals reconcile to the money taken.
  const target = data.totalInclVat != null ? r2(data.totalInclVat) : r2(lineExtNet * (1 + VAT_RATE));
  const targetNet = r2(target / (1 + VAT_RATE));
  const allowance = lineExtNet > targetNet + 0.01 ? r2(lineExtNet - targetNet) : 0;
  const taxExclusive = r2(lineExtNet - allowance);
  const vat = r2(taxExclusive * VAT_RATE);
  const taxInclusive = r2(taxExclusive + vat);

  const s = data.seller || {};
  const sellerName = s.name || "SA'DA H2O Water Purifiers";
  const type = data.invoiceType === 'standard' ? '0100000' : '0200000';

  const buyer = data.buyer || {};
  const buyerBlock = (buyer.name || buyer.phone) ? `
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyLegalEntity><cbc:RegistrationName>${esc(buyer.name || 'Customer')}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>` : '';

  const lineXml = lines.map((l, i) => `
  <cac:InvoiceLine>
    <cbc:ID>${i + 1}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PCE">${l.qty}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="SAR">${f2(l.lineNet)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="SAR">${f2(l.lineVat)}</cbc:TaxAmount>
      <cbc:RoundingAmount currencyID="SAR">${f2(l.lineNet + l.lineVat)}</cbc:RoundingAmount>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${esc(l.name)}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="SAR">${f2(l.unitNet)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('');

  const allowanceBlock = allowance > 0 ? `
  <cac:AllowanceCharge>
    <cbc:ChargeIndicator>false</cbc:ChargeIndicator>
    <cbc:AllowanceChargeReason>Discount</cbc:AllowanceChargeReason>
    <cbc:Amount currencyID="SAR">${f2(allowance)}</cbc:Amount>
    <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
  </cac:AllowanceCharge>` : '';

  const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <cbc:ProfileID>reporting:1.0</cbc:ProfileID>
  <cbc:ID>${esc(data.invoiceNumber)}</cbc:ID>
  <cbc:UUID>${uuid}</cbc:UUID>
  <cbc:IssueDate>${issueDate}</cbc:IssueDate>
  <cbc:IssueTime>${issueTime}</cbc:IssueTime>
  <cbc:InvoiceTypeCode name="${type}">388</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>SAR</cbc:DocumentCurrencyCode>
  <cbc:TaxCurrencyCode>SAR</cbc:TaxCurrencyCode>
  <cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>${Number(data.icv) || 1}</cbc:UUID></cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>PIH</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${esc(data.pih || '')}</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID>
    <cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">__QR__</cbc:EmbeddedDocumentBinaryObject></cac:Attachment>
  </cac:AdditionalDocumentReference>
  <cac:Signature><cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod></cac:Signature>
  <cac:AccountingSupplierParty><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="CRN">${esc(s.crNumber || '')}</cbc:ID></cac:PartyIdentification>
    <cac:PostalAddress>
      <cbc:StreetName>${esc(s.street || '')}</cbc:StreetName>
      <cbc:BuildingNumber>${esc(s.building || '')}</cbc:BuildingNumber>
      <cbc:CitySubdivisionName>${esc(s.district || '')}</cbc:CitySubdivisionName>
      <cbc:CityName>${esc(s.city || '')}</cbc:CityName>
      <cbc:PostalZone>${esc(s.postalZone || '')}</cbc:PostalZone>
      <cac:Country><cbc:IdentificationCode>${esc(s.countryCode || 'SA')}</cbc:IdentificationCode></cac:Country>
    </cac:PostalAddress>
    <cac:PartyTaxScheme><cbc:CompanyID>${esc(s.vatNumber || '')}</cbc:CompanyID>
      <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:PartyTaxScheme>
    <cac:PartyLegalEntity><cbc:RegistrationName>${esc(sellerName)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>${buyerBlock}
  <cac:PaymentMeans><cbc:PaymentMeansCode>${esc(data.paymentMeansCode || '10')}</cbc:PaymentMeansCode></cac:PaymentMeans>${allowanceBlock}
  <cac:TaxTotal><cbc:TaxAmount currencyID="SAR">${f2(vat)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="SAR">${f2(vat)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="SAR">${f2(taxExclusive)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="SAR">${f2(vat)}</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>15.00</cbc:Percent>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="SAR">${f2(lineExtNet)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="SAR">${f2(taxExclusive)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="SAR">${f2(taxInclusive)}</cbc:TaxInclusiveAmount>
    <cbc:AllowanceTotalAmount currencyID="SAR">${f2(allowance)}</cbc:AllowanceTotalAmount>
    <cbc:PayableAmount currencyID="SAR">${f2(taxInclusive)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lineXml}
</Invoice>`;

  return {
    xml, uuid, issueInstant, sellerName, vatNumber: s.vatNumber || '',
    totals: { taxExclusive, vat, taxInclusive },
  };
}

module.exports = { build, VAT_RATE };
