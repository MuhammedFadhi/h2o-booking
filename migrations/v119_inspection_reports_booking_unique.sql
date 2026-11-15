-- v119: inspection_reports.booking_id needs a unique constraint.
--
-- Production has this constraint (inspection_reports_booking_key) but it was
-- added ad-hoc at some point and never captured in a migration file (same
-- story as the table itself — see v63). Dev never got it, so the app's
-- upsert(onConflict: 'booking_id') fails there with "no unique or exclusion
-- constraint matching the ON CONFLICT specification".
--
-- Safe to re-run. Will fail loudly (as intended) if dev somehow already has
-- duplicate booking_id rows to dedupe first — not expected, but don't mask it.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inspection_reports_booking_key'
  ) THEN
    ALTER TABLE inspection_reports
      ADD CONSTRAINT inspection_reports_booking_key UNIQUE (booking_id);
  END IF;
END $$;
