-- =============================================================================
-- SA'DA H2O — v38  "Where did you hear about us?"
--
-- Adds an optional referral_source to bookings, captured at booking time so the
-- office can see which channel each customer came from (Instagram, referral, etc).
--
-- Idempotent. Run AFTER v37.
-- =============================================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS referral_source text;

-- verification (run separately):
-- SELECT referral_source, count(*) FROM bookings GROUP BY referral_source ORDER BY 2 DESC;
