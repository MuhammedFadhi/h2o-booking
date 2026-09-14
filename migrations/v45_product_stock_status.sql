-- =============================================================================
-- SA'DA H2O — v45  Product stock status
--
-- Adds an in_stock flag to product_models so the catalogue can mark a product
-- unavailable without hiding it entirely (removing it from is_catalogue would
-- lose it from historical bookings' display too, since booking_items/product
-- lookups join on model_name). Defaults true so every existing row is
-- unaffected until explicitly marked out of stock.
--
-- Idempotent — safe to re-run.
-- =============================================================================

ALTER TABLE product_models
  ADD COLUMN IF NOT EXISTS in_stock boolean NOT NULL DEFAULT true;

-- Mark 6-Stage Smart RO and 7-Stage Smart RO as out of stock for now.
UPDATE product_models
SET in_stock = false
WHERE model_name IN ('6-Stage Smart RO', '7-Stage Smart RO');

-- verification:
-- SELECT model_name, price_sar, in_stock FROM product_models
-- WHERE is_catalogue = true ORDER BY sort_order;
