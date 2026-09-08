-- =============================================================================
-- SA'DA H2O — v32  Link booking↔warranty↔service, service opt-out, manual marks
--
-- Three related changes:
--
-- (5) LINK bookings and warranties. The columns already exist
--     (warranties.booking_id, bookings.warranty_id) but were never populated.
--     A single install can register MULTIPLE units, so one booking legitimately
--     maps to many warranties. This drops the old one-warranty-per-booking index
--     and links every warranty to its customer's completed install (for customers
--     with exactly one install — the multi-unit count doesn't matter). 44 such
--     customers exist (41 single-unit, 3 multi-unit); 0 have multiple installs.
--
-- (3) MANUAL SERVICE MARKS. Add warranty_service_history.source ('manual'|'job')
--     and reset_filter/reset_service flags so admin can record "customer changed
--     the filter themselves" and reset the due-date clock from that date.
--
-- (4) SERVICE OPT-OUT. Add warranties.service_opted_out boolean. When true the
--     warranty is STILL VALID (coverage intact) but is excluded from reminders
--     and "needs attention" lists — for customers who decline maintenance visits.
--     This is distinct from status='deactivated' (which voids coverage).
--
-- Idempotent. Run AFTER v31.
-- =============================================================================

-- (3) service history: how the entry was created + whether it reset a clock
ALTER TABLE warranty_service_history ADD COLUMN IF NOT EXISTS source text
  DEFAULT 'job' CHECK (source IN ('job', 'manual', 'import'));
ALTER TABLE warranty_service_history ADD COLUMN IF NOT EXISTS performed_on date;
ALTER TABLE warranty_service_history ADD COLUMN IF NOT EXISTS performed_by text;

-- (4) service opt-out — valid warranty, but leave the customer alone
ALTER TABLE warranties ADD COLUMN IF NOT EXISTS service_opted_out boolean NOT NULL DEFAULT false;

-- (5) backfill the clean 1:1 links, both directions.
-- (5) LINK bookings and warranties — CORRECTED for multi-unit installs.
--     A single install visit can register MULTIPLE units (multiple warranties),
--     so "one booking → many warranties" is normal, not an error. The old
--     warranties_booking_unique index wrongly forbade that; drop it first.
DROP INDEX IF EXISTS warranties_booking_unique;

--     Link every warranty to its customer's completed install, for customers who
--     have exactly ONE completed install (so there's no ambiguity about WHICH
--     booking — the number of units/warranties doesn't matter). Customers with
--     multiple installs are skipped (can't tell which install a warranty is from).
WITH single_install AS (
  SELECT customer_phone, min(id::text)::uuid AS booking_id
  FROM bookings
  WHERE status = 'completed' AND booking_type = 'installation'
  GROUP BY customer_phone
  HAVING count(*) = 1
)
UPDATE warranties w
SET booking_id = si.booking_id
FROM customers c, single_install si
WHERE w.customer_id = c.id
  AND si.customer_phone = c.phone
  AND w.booking_id IS NULL;

-- mirror ONE representative warranty back onto each booking. bookings.warranty_id
-- can only hold a single value, so for multi-unit bookings it points at one of
-- the warranties (the rest are still reachable via warranties.booking_id, which
-- is the authoritative direction). Pick the lowest id deterministically.
WITH one_per_booking AS (
  SELECT booking_id, min(id::text)::uuid AS warranty_id
  FROM warranties
  WHERE booking_id IS NOT NULL
  GROUP BY booking_id
)
UPDATE bookings b
SET warranty_id = opb.warranty_id
FROM one_per_booking opb
WHERE b.id = opb.booking_id
  AND b.warranty_id IS NULL;

-- verification (run separately):
-- SELECT count(*) FROM warranties WHERE booking_id IS NOT NULL;   -- ~47
-- SELECT count(*) FROM bookings   WHERE warranty_id IS NOT NULL;  -- ~47
