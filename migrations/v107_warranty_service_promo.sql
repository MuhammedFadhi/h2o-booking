-- v107: Remember a service-enabled promo code on the UNIT itself, so a
-- future service-visit booking for that same unit auto-detects and applies
-- it, instead of the admin having to retype the code every time.
--
-- Written onto warranties.service_promo_code whenever a booking for that
-- warranty completes with a service-enabled promo code attached (see
-- submitPayment() in admin/dashboard.html). Read back by adminMarkComplete()
-- on the NEXT service-type booking for the same warranty: if the booking
-- doesn't already have its own promo_code, this is auto-filled and
-- auto-applied via the existing applyServicePromo() validation (which still
-- enforces service_types / applicable_products / max_uses_per_unit — this
-- column is just a convenience pointer, not a bypass).
--
-- Idempotent. Safe to re-run.

ALTER TABLE warranties ADD COLUMN IF NOT EXISTS service_promo_code text;

-- verification:
-- SELECT id, product_type, service_promo_code FROM warranties WHERE service_promo_code IS NOT NULL;
