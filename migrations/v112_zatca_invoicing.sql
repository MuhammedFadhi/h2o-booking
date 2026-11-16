-- =============================================================================
-- SA'DA H2O — v112  ZATCA-compliant invoicing
--
-- Turns the existing invoice feature into a ZATCA (Fatoora) Phase-1 "generation"
-- compliant SIMPLIFIED TAX INVOICE system for B2C sales:
--
--   1. company_settings — the seller's legal identity that MUST appear on every
--      tax invoice: legal name (EN/AR), 15-digit VAT registration number, CR
--      number, address. Single row ('default'). FILL IN THE REAL VAT NUMBER.
--   2. Gapless, sequential invoice numbering (next_invoice_number()) — ZATCA
--      requires sequential numbering; manual free-typing risked gaps/duplicates.
--   3. invoices gets the ZATCA snapshot columns: seller name + VAT number as they
--      stood at issue, plus qr_payload (the Base64 TLV string encoded in the QR),
--      so a re-print is always byte-identical to what was first issued.
--
-- The QR itself (Base64 TLV of seller name, VAT number, timestamp, total, VAT)
-- is built in js/invoice-generator.js and the printable bilingual document is
-- produced client-side (no external service), mirroring warranty-certificate.js.
--
-- Idempotent. Run AFTER v111.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. COMPANY / TAX SETTINGS  (the seller identity on every invoice)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
  id              text PRIMARY KEY DEFAULT 'default',
  seller_name_en  text,
  seller_name_ar  text,
  vat_number      text,          -- 15-digit ZATCA VAT registration number
  cr_number       text,          -- commercial registration number
  address_en      text,
  address_ar      text,
  city            text,
  phone           text,
  email           text,
  logo_url        text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_settings_singleton CHECK (id = 'default')
);

-- Seed the one row with what we know. VAT + CR are LEFT BLANK on purpose — the
-- invoice document refuses to look compliant until the real VAT number is set
-- (edit it in the dashboard's "Tax / Company info" dialog, or UPDATE here).
INSERT INTO company_settings (id, seller_name_en, seller_name_ar, phone, city)
SELECT 'default', 'SA''DA H2O Water Purifiers', 'سعدا لتنقية المياه', '920022569', 'Jubail'
WHERE NOT EXISTS (SELECT 1 FROM company_settings WHERE id = 'default');

ALTER TABLE company_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_settings_anon_read ON company_settings;
DROP POLICY IF EXISTS company_settings_auth_all  ON company_settings;
-- Seller identity is printed on every customer invoice, so it is public info:
-- anon may READ it (a customer viewing their own invoice link renders the QR);
-- only admin writes.
CREATE POLICY company_settings_anon_read ON company_settings FOR SELECT TO anon USING (true);
CREATE POLICY company_settings_auth_all  ON company_settings FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 2. GAPLESS SEQUENTIAL INVOICE NUMBERS  (INV-YYYY-000123, per calendar year)
--    An atomic per-year counter. SECURITY DEFINER so admin can mint a number
--    without a broad grant on the counter table. A number is only ever minted
--    when a booking is actually completed, so the sequence stays gapless.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoice_counters (
  year      int PRIMARY KEY,
  last_seq  int NOT NULL DEFAULT 0
);
ALTER TABLE invoice_counters ENABLE ROW LEVEL SECURITY;  -- no policies: only the SECURITY DEFINER fn touches it

CREATE OR REPLACE FUNCTION next_invoice_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  y int := EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int;
  n int;
BEGIN
  INSERT INTO invoice_counters(year, last_seq) VALUES (y, 1)
  ON CONFLICT (year) DO UPDATE SET last_seq = invoice_counters.last_seq + 1
  RETURNING last_seq INTO n;
  RETURN 'INV-' || y || '-' || lpad(n::text, 6, '0');
END;
$$;
GRANT EXECUTE ON FUNCTION next_invoice_number() TO authenticated;

-- Seed this year's counter past any numbers already issued under the old manual
-- scheme that happen to match the INV-YYYY-NNNNNN shape, so we never collide.
INSERT INTO invoice_counters(year, last_seq)
SELECT EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int, 0
WHERE NOT EXISTS (
  SELECT 1 FROM invoice_counters
  WHERE year = EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int
);
UPDATE invoice_counters ic
SET last_seq = GREATEST(ic.last_seq, (
  SELECT COALESCE(MAX((regexp_replace(invoice_number, '^INV-\d{4}-0*', ''))::int), 0)
  FROM invoices
  WHERE invoice_number ~ ('^INV-' || ic.year || '-\d+$')
))
WHERE ic.year = EXTRACT(YEAR FROM (now() AT TIME ZONE 'Asia/Riyadh'))::int;

-- ---------------------------------------------------------------------------
-- 3. INVOICES: ZATCA snapshot columns
-- ---------------------------------------------------------------------------
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_name       text;  -- seller legal name at issue
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS seller_vat_number text;  -- seller VAT number at issue
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS qr_payload        text;  -- Base64 TLV encoded in the QR
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS buyer_address     text;  -- optional buyer address line

-- verification (run separately):
-- SELECT * FROM company_settings;
-- SELECT next_invoice_number();            -- mints + returns the next number
-- SELECT year, last_seq FROM invoice_counters;
