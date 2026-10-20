-- =============================================================================
-- SA'DA H2O — v76  Backfill filter/service due dates for ALREADY-completed
-- Filter Change / Annual Service bookings (one-time data fix, not a schema
-- or function change — nothing here needs to run again after it's applied).
--
-- v75's trigger only fires going forward, on a booking's FIRST transition
-- into installed/completed. Any Filter Change/Annual Service booking that
-- completed before v75 existed never got its warranty's filter_expiry/
-- service_expiry pushed automatically, and may never have been logged via
-- the manual "+Job Order" button either.
--
-- Same resolution rule as the trigger: booking.warranty_id if it's set,
-- else the customer's SOLE warranty if unambiguous — a customer with 2+
-- units and no explicit pick is skipped, never guessed.
--
-- Safety: only the MOST RECENT qualifying booking per warranty is applied
-- (not every historical one), and only when the computed date would ADVANCE
-- the current filter_expiry/service_expiry — never moves either backward,
-- so a date that's already correct, or newer than this would compute, is
-- left untouched.
--
-- RUN THE PREVIEW QUERY FIRST (read-only, no writes). It lists exactly the
-- customers this will touch — name, phone, booking, serial, current due
-- date, new due date — and only those; anyone the backfill would skip
-- (repair-only, ambiguous multi-unit, or already up to date) never appears
-- in this list at all. Review it, then run the BACKFILL block below it.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) PREVIEW — read-only, run this first
-- ---------------------------------------------------------------------------
WITH customer_sole_warranty AS (
  SELECT c.phone, MIN(w.id) AS warranty_id
  FROM warranties w JOIN customers c ON c.id = w.customer_id
  WHERE w.status <> 'deactivated'
  GROUP BY c.phone
  HAVING COUNT(*) = 1
),
resolved_bookings AS (
  SELECT
    b.id AS booking_id, b.booking_reference, b.booking_type,
    COALESCE(b.installed_at, b.created_at) AS completed_at,
    COALESCE(b.warranty_id, csw.warranty_id) AS warranty_id
  FROM bookings b
  LEFT JOIN customer_sole_warranty csw ON csw.phone = b.customer_phone
  WHERE b.booking_type IN ('quarterly_service', 'maintenance', 'annual_service')
    AND b.status IN ('installed', 'completed')
),
latest_per_warranty AS (
  SELECT DISTINCT ON (warranty_id)
    warranty_id, booking_id, booking_reference, booking_type, completed_at
  FROM resolved_bookings
  WHERE warranty_id IS NOT NULL
  ORDER BY warranty_id, completed_at DESC
),
computed AS (
  SELECT
    l.*,
    CASE WHEN l.booking_type = 'annual_service' THEN 'service' ELSE 'filter' END AS service_type,
    l.completed_at + (CASE WHEN l.booking_type = 'annual_service' THEN 365 ELSE 90 END || ' days')::interval AS new_due
  FROM latest_per_warranty l
)
SELECT
  cust.name AS customer_name, cust.phone AS customer_phone,
  c.booking_reference, c.booking_type, c.completed_at::date AS completed_on,
  w.qr_code AS serial, w.product_type,
  c.service_type,
  CASE WHEN c.service_type = 'filter' THEN w.filter_expiry ELSE w.service_expiry END AS current_due,
  c.new_due
FROM computed c
JOIN warranties w ON w.id = c.warranty_id
JOIN customers cust ON cust.id = w.customer_id
-- Only the customers the backfill below will actually touch — everyone
-- else (repair-only, ambiguous multi-unit, or already up to date) is left
-- out of this list entirely, not just flagged.
WHERE c.new_due > COALESCE(CASE WHEN c.service_type = 'filter' THEN w.filter_expiry ELSE w.service_expiry END, '-infinity'::timestamptz)
ORDER BY c.completed_at DESC;

-- ---------------------------------------------------------------------------
-- 2) BACKFILL — writes. Only run after reviewing the preview above.
--    Only touches rows the preview marked will_update = true.
-- ---------------------------------------------------------------------------
WITH customer_sole_warranty AS (
  SELECT c.phone, MIN(w.id) AS warranty_id
  FROM warranties w JOIN customers c ON c.id = w.customer_id
  WHERE w.status <> 'deactivated'
  GROUP BY c.phone
  HAVING COUNT(*) = 1
),
resolved_bookings AS (
  SELECT
    b.id AS booking_id, b.booking_reference, b.booking_type,
    COALESCE(b.installed_at, b.created_at) AS completed_at,
    COALESCE(b.warranty_id, csw.warranty_id) AS warranty_id
  FROM bookings b
  LEFT JOIN customer_sole_warranty csw ON csw.phone = b.customer_phone
  WHERE b.booking_type IN ('quarterly_service', 'maintenance', 'annual_service')
    AND b.status IN ('installed', 'completed')
),
latest_per_warranty AS (
  SELECT DISTINCT ON (warranty_id)
    warranty_id, booking_id, booking_reference, booking_type, completed_at
  FROM resolved_bookings
  WHERE warranty_id IS NOT NULL
  ORDER BY warranty_id, completed_at DESC
),
to_apply AS (
  SELECT
    l.warranty_id, l.booking_reference, l.completed_at,
    CASE WHEN l.booking_type = 'annual_service' THEN 'service' ELSE 'filter' END AS service_type,
    l.completed_at + (CASE WHEN l.booking_type = 'annual_service' THEN 365 ELSE 90 END || ' days')::interval AS new_due
  FROM latest_per_warranty l
  JOIN warranties w ON w.id = l.warranty_id
  WHERE l.completed_at + (CASE WHEN l.booking_type = 'annual_service' THEN 365 ELSE 90 END || ' days')::interval
        > COALESCE(CASE WHEN l.booking_type = 'annual_service' THEN w.service_expiry ELSE w.filter_expiry END, '-infinity'::timestamptz)
),
logged AS (
  INSERT INTO warranty_service_history (warranty_id, service_type, notes, source, performed_on, performed_by)
  SELECT warranty_id, service_type,
    'Backfilled from booking ' || booking_reference,
    'job', completed_at::date, 'system (backfill)'
  FROM to_apply
  RETURNING warranty_id
)
UPDATE warranties w
SET filter_expiry  = CASE WHEN t.service_type = 'filter'  THEN t.new_due ELSE w.filter_expiry  END,
    service_expiry = CASE WHEN t.service_type = 'service' THEN t.new_due ELSE w.service_expiry END
FROM to_apply t
WHERE w.id = t.warranty_id;

-- verification (run separately, after the backfill):
-- SELECT * FROM warranty_service_history WHERE performed_by = 'system (backfill)' ORDER BY created_at DESC;
