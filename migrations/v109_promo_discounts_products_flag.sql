-- v109: Let a promo code restrict WHICH product models it applies to
-- (applicable_products, from v70/v108) without necessarily discounting a
-- product purchase at all — e.g. "free first filter change, for these RO
-- models only, but never discount the unit purchase itself".
--
-- discounts_products=true (default)  -> behaves exactly as before: the
--   purchase-time discount applies to whichever products applicable_products
--   allows (or all, if null).
-- discounts_products=false -> the product purchase is never discounted,
--   regardless of applicable_products/discount_value; applicable_products
--   is still used (see v108's applyServicePromo) purely to gate which
--   units' service visits this code can be used on.
--
-- Idempotent. Safe to re-run.

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS discounts_products boolean NOT NULL DEFAULT true;

-- verification:
-- SELECT code, applicable_products, discounts_products, applies_to_services FROM promo_codes;
