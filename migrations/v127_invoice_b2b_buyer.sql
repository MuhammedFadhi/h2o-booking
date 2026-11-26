-- v127: B2B (standard tax invoice) buyer details on invoices.
--
-- Only ADDS nullable columns (plus one with a default) — no data is changed or
-- removed, and existing invoices stay simplified (B2C). Safe to run twice.
--
-- ZATCA rules these support (standard invoices only):
--   buyer name (BT-44); buyer VAT number (BT-48), or another ID with its type
--   (BT-46: CRN, MOM, MLS, 700, SAG, NAT, GCC, IQA, PAS, TIN, OTH);
--   buyer National Address: street, building no. (4 digits), district, city,
--   postal code (5 digits), country; additional no. optional.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS invoice_kind text NOT NULL DEFAULT 'simplified';
DO $$ BEGIN
  ALTER TABLE invoices ADD CONSTRAINT invoices_invoice_kind_chk CHECK (invoice_kind IN ('simplified', 'standard'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_vat_number    text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_id_scheme     text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_id_number     text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_street        text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_building_no   text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_additional_no text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_district      text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_city          text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_postal_code   text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_country       text;

-- Find a company's earlier B2B invoice by VAT number (to pre-fill its address).
CREATE INDEX IF NOT EXISTS invoices_buyer_vat_idx ON invoices (buyer_vat_number) WHERE buyer_vat_number IS NOT NULL;
