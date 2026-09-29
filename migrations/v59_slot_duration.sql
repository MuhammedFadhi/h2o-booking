-- =============================================================================
-- Variable-duration availability slots. Every slot today is an implicit
-- 1-hour block (only a whole-number slot_hour is stored, 0-23 — no minutes,
-- no duration). This adds real duration storage so new slots can be created
-- on a 90-minute grid (9:00-10:30, 10:30-12:00, ...) starting from whatever
-- date the admin chooses, WITHOUT touching any existing slot or booking.
--
--   slot_minute       0 or 30 — the minute component of the slot's start time.
--   duration_minutes  how long the slot lasts, in minutes.
--
-- Both default so every EXISTING row keeps its exact current meaning:
-- slot_minute=0, duration_minutes=60 — i.e. "starts on the hour, lasts an
-- hour", exactly what every current slot/booking already means. Nothing is
-- recalculated or reinterpreted; old bookings display identically to before.
--
-- New slots generated after this migration can use slot_minute=30 and/or
-- duration_minutes=90 (or any other combination) — old and new slots simply
-- coexist, each carrying its own duration.
--
-- Also widens availability_slots' uniqueness to include slot_minute, since
-- two different slots can now legitimately share the same slot_hour (an old
-- 1-hour slot at 10:00 and a new 90-minute grid's 10:30 slot both have
-- slot_hour=10 but are different times).
-- =============================================================================

ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS slot_minute INTEGER;
ALTER TABLE availability_slots ALTER COLUMN slot_minute SET DEFAULT 0;
UPDATE availability_slots SET slot_minute = 0 WHERE slot_minute IS NULL;
ALTER TABLE availability_slots ALTER COLUMN slot_minute SET NOT NULL;
ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_slot_minute_check;
ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_slot_minute_check CHECK (slot_minute IN (0, 30));

ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE availability_slots ALTER COLUMN duration_minutes SET DEFAULT 60;
UPDATE availability_slots SET duration_minutes = 60 WHERE duration_minutes IS NULL;
ALTER TABLE availability_slots ALTER COLUMN duration_minutes SET NOT NULL;
ALTER TABLE availability_slots DROP CONSTRAINT IF EXISTS availability_slots_duration_check;
ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_duration_check CHECK (duration_minutes > 0);

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS slot_minute INTEGER;
ALTER TABLE bookings ALTER COLUMN slot_minute SET DEFAULT 0;
UPDATE bookings SET slot_minute = 0 WHERE slot_minute IS NULL;
ALTER TABLE bookings ALTER COLUMN slot_minute SET NOT NULL;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_slot_minute_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_slot_minute_check CHECK (slot_minute IN (0, 30));

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS duration_minutes INTEGER;
ALTER TABLE bookings ALTER COLUMN duration_minutes SET DEFAULT 60;
UPDATE bookings SET duration_minutes = 60 WHERE duration_minutes IS NULL;
ALTER TABLE bookings ALTER COLUMN duration_minutes SET NOT NULL;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_duration_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_duration_check CHECK (duration_minutes > 0);

-- Widen the uniqueness constraint (was service_region_id+slot_date+slot_hour)
-- to also include slot_minute, found dynamically since it's been renamed
-- across migrations before (v22_polish.sql, v25_service_regions.sql) and may
-- not match the name assumed here on every environment.
DO $$
DECLARE cn text;
BEGIN
  SELECT c.conname INTO cn
  FROM pg_constraint c
  JOIN pg_class t ON t.oid = c.conrelid
  WHERE t.relname = 'availability_slots'
    AND c.contype = 'u'
    AND pg_get_constraintdef(c.oid) LIKE '%slot_date%slot_hour%'
    AND pg_get_constraintdef(c.oid) NOT LIKE '%slot_minute%';
  IF cn IS NOT NULL THEN
    EXECUTE 'ALTER TABLE availability_slots DROP CONSTRAINT ' || quote_ident(cn);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'availability_slots' AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%slot_minute%'
  ) THEN
    ALTER TABLE availability_slots
      ADD CONSTRAINT availability_slots_region_date_hour_minute_key
      UNIQUE (service_region_id, slot_date, slot_hour, slot_minute);
  END IF;
END $$;
