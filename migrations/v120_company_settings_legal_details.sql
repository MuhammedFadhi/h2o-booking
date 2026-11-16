-- v120 — Seller legal / tax identity + structured national address, filled
-- from the official documents.
--
-- Source documents (2026-11):
--   * ZATCA VAT Registration Certificate (VAT group). Group VAT number
--     311272145800003, effective 2022-06-01. The group's main registrant is
--     شركة عالم ارض الفن للمقاولات العامة; SA'DA trades as the listed group
--     branch شركة سعادة العرب للتجارة (Al Khobar), which invoices under the
--     group VAT number.
--   * Ministry of Commerce CR certificate: شركة سعادة العرب للتجارة, unified
--     national number 7028780372, issued 2022-04-25. (Older branch CRs on the
--     VAT certificate: 2051241309, 2051243377.)
--   * National Address proof (Saudi Post / SPL): registered English name
--     "Saadat Alarab Company For Trading"; building 6623, Prince Abdulmohsin
--     Ibn Abdulaziz St, secondary no. 4571, Madinat Al Ummal district,
--     Al Khobar 34442; short address EKJA6623.
--
-- ZATCA Phase-2 UBL needs the address split into building no. (4 digits),
-- street, secondary no., district, city and postal code (5 digits), so those
-- get their own columns. address_en / address_ar stay as the printed line.
--
-- Idempotent: safe to re-run. Run AFTER v112.

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS building_no   text;  -- 4 digits
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS street_en     text;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS street_ar     text;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS secondary_no  text;  -- 4 digits (additional no.)
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS district_en   text;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS district_ar   text;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS postal_code   text;  -- 5 digits
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS short_address text;  -- e.g. EKJA6623

INSERT INTO company_settings (id) VALUES ('default') ON CONFLICT (id) DO NOTHING;

UPDATE company_settings SET
  seller_name_ar = 'شركة سعادة العرب للتجارة',
  seller_name_en = 'Saadat Alarab Company For Trading',
  vat_number     = '311272145800003',
  cr_number      = '7028780372',
  building_no    = '6623',
  street_en      = 'Prince Abdulmohsin Ibn Abdulaziz St',
  street_ar      = 'الامير عبدالمحسن ابن عبدالعزيز',
  secondary_no   = '4571',
  district_en    = 'Madinat Al Ummal Dist.',
  district_ar    = 'حي مدينة العمال',
  postal_code    = '34442',
  short_address  = 'EKJA6623',
  city           = 'Al Khobar',
  address_en     = '6623 Prince Abdulmohsin Ibn Abdulaziz St, Madinat Al Ummal Dist., Al Khobar 34442-4571',
  address_ar     = '6623 الامير عبدالمحسن ابن عبدالعزيز، حي مدينة العمال، الخبر 34442-4571',
  updated_at     = now()
WHERE id = 'default';

-- Check:
-- SELECT seller_name_ar, seller_name_en, vat_number, cr_number, building_no, street_en,
--        secondary_no, district_en, postal_code, city, short_address FROM company_settings;
