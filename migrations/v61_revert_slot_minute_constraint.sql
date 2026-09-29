-- =============================================================================
-- Rolls back the ONE part of v59 that the app code depends on for
-- correctness: the widened UNIQUE constraint on availability_slots.
--
-- The 1.5-hour slot feature (v59/v60, commit 8dfb3cc) has been reverted in
-- the app code. That reverted code upserts availability_slots using the
-- OLD 3-column onConflict target (service_region_id, slot_date, slot_hour).
-- If the table still only has the v59 4-column constraint
-- (..., slot_minute), every admin slot-creation upsert starts failing with
-- "no unique or exclusion constraint matching the ON CONFLICT specification".
-- This restores the original 3-column constraint so that code works again.
--
-- Deliberately NOT reverted (harmless to leave, safe to leave in place):
--   - slot_minute / duration_minutes columns on availability_slots/bookings
--     (reverted code simply never reads or writes them; existing rows keep
--     whatever values they have, including the one already-booked 1.5-hour
--     test slot).
--   - create_booking()'s widened RETURNS TABLE from v60 (still accepts the
--     same 9 params; reverted JS code just ignores the 2 extra columns it
--     returns).
--
-- Safe to re-run.
-- =============================================================================

DO $$
DECLARE cn text;
BEGIN
  SELECT c.conname INTO cn
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'availability_slots'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) LIKE '%slot_date%slot_hour%slot_minute%';
  IF cn IS NOT NULL THEN
    EXECUTE 'ALTER TABLE availability_slots DROP CONSTRAINT ' || quote_ident(cn);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'availability_slots' AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%slot_date%slot_hour%'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%slot_minute%'
  ) THEN
    ALTER TABLE availability_slots
      ADD CONSTRAINT availability_slots_region_date_hour_key
      UNIQUE (service_region_id, slot_date, slot_hour);
  END IF;
END $$;
