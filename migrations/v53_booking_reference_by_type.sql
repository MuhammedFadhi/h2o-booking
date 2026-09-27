-- =============================================================================
-- Booking reference prefix by service type, dropping the date segment.
--
-- Old:  SW-YYYYMMDD-XXXXXX          (one prefix for every booking type)
-- New:  <TYPE>-XXXXXX               (prefix depends on booking_type, no date)
--   NB  installation      (New Booking / New installation)
--   RP  repair
--   FR  quarterly_service, maintenance (legacy alias)  — Filter Replacement
--   RL  relocation
--   SW  anything else (inspection, annual_service, future types) — old prefix kept
--
-- The 6-char code is random from 0-9A-Z (not derived from the row id), with a
-- retry loop since booking_reference is UNIQUE and we no longer have the date
-- to help avoid collisions.
--
-- This only changes reference numbers for bookings created AFTER this runs.
-- Existing booking_reference values are left untouched — they've already gone
-- out in SMS/WhatsApp confirmations and printed paperwork.
--
-- Idempotent (CREATE OR REPLACE). Run once in the Supabase SQL editor.
-- =============================================================================

CREATE OR REPLACE FUNCTION generate_booking_reference()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix text;
  v_code   text;
  v_ref    text;
BEGIN
  v_prefix := CASE NEW.booking_type
    WHEN 'installation'       THEN 'NB'
    WHEN 'repair'             THEN 'RP'
    WHEN 'quarterly_service'  THEN 'FR'
    WHEN 'maintenance'        THEN 'FR'
    WHEN 'relocation'         THEN 'RL'
    ELSE 'SW'
  END;

  LOOP
    SELECT string_agg(substr('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', (floor(random() * 36) + 1)::int, 1), '')
    INTO v_code
    FROM generate_series(1, 6);

    v_ref := v_prefix || '-' || v_code;
    EXIT WHEN NOT EXISTS (SELECT 1 FROM bookings WHERE booking_reference = v_ref);
  END LOOP;

  NEW.booking_reference := v_ref;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger itself is unchanged (still BEFORE INSERT, still calls this function) —
-- CREATE OR REPLACE above is enough, no need to touch the trigger definition.
