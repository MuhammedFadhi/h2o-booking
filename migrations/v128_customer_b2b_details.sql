-- v128: company (B2B) details on the customer record.
--
-- Only ADDS nullable columns (plus one boolean with a default) — no data is
-- changed or removed; every existing customer stays a normal (B2C) customer.
-- Safe to run twice.
--
-- Same details ZATCA needs on a B2B tax invoice: the company's VAT number, or
-- another ID with its type (CRN, 700, MOM, MLS, SAG, NAT, IQA, GCC, PAS, TIN,
-- OTH), and its National Address. New Invoice copies them onto each invoice
-- (invoices.buyer_*, v127), so later edits here never change an issued invoice.

ALTER TABLE customers ADD COLUMN IF NOT EXISTS is_business   boolean NOT NULL DEFAULT false;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS vat_number    text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS id_scheme     text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS id_number     text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS street        text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS building_no   text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS additional_no text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS district      text;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS nat_city      text;   -- National Address city
ALTER TABLE customers ADD COLUMN IF NOT EXISTS postal_code   text;
