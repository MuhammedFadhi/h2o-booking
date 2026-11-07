-- v108: Promo codes usable on flat-rate SERVICE VISITS (Filter Change /
-- Annual Service / Repair), not just product purchases.
--
-- Use cases:
--   "1st filter replacement free"      -> applies_to_services=true,
--                                          service_types=['quarterly_service','maintenance'],
--                                          max_uses_per_unit=1
--   "all services free for a customer" -> applies_to_services=true,
--                                          service_types=NULL (all types),
--                                          max_uses_per_unit=NULL (unlimited)
--
-- "Unit free, but services still chargeable" needs none of this — it's
-- already covered by the existing applicable_products restriction applied
-- at booking creation (see v70_promo_product_restriction.sql).
--
-- Reuses the existing discount_type/discount_value columns — the discount
-- is computed against the visit's flat fee (SERVICE_VISIT_PRICES) or
-- manually entered amount at Mark Complete time, not against a product
-- basket.
--
-- Idempotent. Safe to re-run.

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS applies_to_services boolean NOT NULL DEFAULT false;
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS service_types text[];      -- NULL/empty = all service types
ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS max_uses_per_unit int;     -- NULL = unlimited; 1 = first visit only

-- verification:
-- SELECT code, applies_to_services, service_types, max_uses_per_unit FROM promo_codes;
