-- =============================================================================
-- SA'DA H2O — v33  Backfill missing customer names from their bookings
--
-- Some customers registered a warranty by phone (QR scan) without ever giving a
-- name, so customers.name is null and the warranty shows "No name" — even when
-- the SAME phone has a booking that DOES carry a name (booking.customer_name).
--
-- This copies that name onto the customer record. The going-forward fix (pull
-- the booking name at activation time) lives in create_booking / activation code.
--
-- Only fills names that are currently null — never overwrites an existing name.
-- Uses the most recent non-empty booking name for each phone.
--
-- Idempotent. Run AFTER v32.
-- =============================================================================

WITH latest_named_booking AS (
  SELECT DISTINCT ON (customer_phone)
         customer_phone,
         customer_name
  FROM bookings
  WHERE customer_name IS NOT NULL
    AND btrim(customer_name) <> ''
  ORDER BY customer_phone, created_at DESC
)
UPDATE customers c
SET name = lnb.customer_name,
    updated_at = now()
FROM latest_named_booking lnb
WHERE c.phone = lnb.customer_phone
  AND (c.name IS NULL OR btrim(c.name) = '');

-- verification (run separately):
-- SELECT count(*) FROM customers WHERE name IS NULL OR btrim(name)='';
--   → should drop by however many had a named booking
