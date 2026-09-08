-- =============================================================================
-- SA'DA H2O — v34  Product catalogue + prices, product on bookings
--
-- PATH 1 (chosen): adopt the 5 official SA'DA H2O catalogue products with prices
-- as the going-forward catalogue. Customers pick product + quantity at booking.
--
--  1) Add price_sar to product_models.
--  2) Insert the 5 catalogue products (with a flag so only these show in the
--     booking dropdown; the 8 legacy names stay for existing-warranty history).
--  3) Add product_model + product_qty to bookings (they had no product field).
--  4) Backfill the 77 existing bookings to the default "7-Stage RO Purifier" (699),
--     editable afterwards for cross-checking.
--
-- Idempotent. Run AFTER v33.
-- =============================================================================

-- 1) price + a "sellable" flag (only catalogue items show in the booking picker)
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS price_sar numeric;
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS is_catalogue boolean NOT NULL DEFAULT false;
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS sort_order int NOT NULL DEFAULT 999;

-- ON CONFLICT (model_name) below needs a unique constraint on model_name.
-- The existing 8 names are already distinct, so this is safe to add now.
CREATE UNIQUE INDEX IF NOT EXISTS product_models_model_name_key ON product_models(model_name);

-- 2) the 5 official catalogue products. ON CONFLICT keeps this idempotent and
--    lets a re-run update prices without duplicating rows.
--    (model_name is the natural key used by the warranty join.)
INSERT INTO product_models (model_name, price_sar, is_catalogue, sort_order, image_url, description) VALUES
  ('RO Water Dispenser (Hot/Cold)', 499,  true, 1, '/assets/models/purifier-generic.png',
   'Hot & cold RO water with a built-in dispenser, compact design; available in Black and Silver/White. For homes/offices wanting instant hot & cold purified water.'),
  ('7-Stage RO Purifier',           699,  true, 2, '/assets/models/purifier-generic.png',
   '75 GPD (~280 L/day), 7-stage RO + mineral enrichment, removes TDS & heavy metals. Standard home purification.'),
  ('7-Stage RO Purifier + UV',      999,  true, 3, '/assets/models/purifier-generic.png',
   '75 GPD + UV sterilization (99.9% bacteria/viruses), + mineral enrichment. Families wanting extra protection.'),
  ('6-Stage Smart RO',              1199, true, 4, '/assets/models/purifier-generic.png',
   '~280 L/day, smart 6-stage RO.'),
  ('7-Stage Smart RO',              1299, true, 5, '/assets/models/purifier-generic.png',
   'Top of the range smart 7-stage RO.')
ON CONFLICT (model_name) DO UPDATE
  SET price_sar    = EXCLUDED.price_sar,
      is_catalogue = true,
      sort_order   = EXCLUDED.sort_order;

-- 3) product fields on bookings
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS product_model text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS product_qty  int NOT NULL DEFAULT 1;

-- 4) backfill existing bookings to the default catalogue product (editable later)
UPDATE bookings
SET product_model = '7-Stage RO Purifier'
WHERE product_model IS NULL OR btrim(product_model) = '';

UPDATE bookings SET product_qty = 1 WHERE product_qty IS NULL OR product_qty < 1;

-- verification (run separately):
-- SELECT model_name, price_sar FROM product_models WHERE is_catalogue ORDER BY sort_order;
-- SELECT count(*) FROM bookings WHERE product_model IS NULL;   -- expect 0
