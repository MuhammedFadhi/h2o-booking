-- v130: keep the ZATCA XML of each reported / cleared invoice.
--
-- einvoice_xml = base64 of the legal e-invoice: the signed XML we reported
-- (simplified / B2C) or ZATCA's cleared XML (standard / B2B). It is embedded in
-- the invoice's PDF/A-3 download, and ZATCA expects it kept for the archive
-- period. Filled from now on; invoices reported earlier have none.
--
-- Only ADDS one nullable column — no data is changed or removed. Safe to run twice.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_xml text;
