-- =============================================================================
-- Booking reference becomes two sequential numbers instead of a random code:
--
--   SW-<global#> - <TYPE> <type#>          e.g.  SW-51200 - NB 1200
--
--   SW-<global#>  — a single running count across EVERY booking, regardless
--                    of type. Increments by 1 every time, no matter what.
--   <TYPE> <n>    — a running count PER SERVICE TYPE, own counter, only
--                    increments for bookings of that exact type:
--                      NB  installation
--                      RP  repair
--                      FR  quarterly_service, maintenance (legacy alias)
--                      RL  relocation
--                      IN  inspection
--                    Any other/future booking_type gets the global number
--                    only ("SW-<n>", no " - TYPE n" suffix) — same fallback
--                    principle as v53.
--
-- Starting numbers, per request, so the sequence continues from wherever the
-- team's existing manual numbering already stands (NOT starting at 1):
--   SW 51200, NB 1200, RP 1009, FR 1100, RL 1002, IN 1002
--
-- CREATE SEQUENCE ... IF NOT EXISTS, so re-running this migration never
-- resets a sequence that has already issued numbers.
--
-- This only changes reference numbers for bookings created AFTER this runs.
-- Existing booking_reference values (old SW-YYYYMMDD-XXXXXX and NB-XXXXXX
-- formats) are left untouched.
--
-- Also widens bookings.booking_reference from varchar(20) to varchar(64) —
-- the old format always fit in 20 chars, but "SW-<n> - <TYPE> <n>" grows
-- past that once the running numbers pick up a few more digits.
-- =============================================================================

ALTER TABLE bookings ALTER COLUMN booking_reference TYPE varchar(64);

CREATE SEQUENCE IF NOT EXISTS booking_ref_global_seq START WITH 51200;
CREATE SEQUENCE IF NOT EXISTS booking_ref_nb_seq      START WITH 1200;
CREATE SEQUENCE IF NOT EXISTS booking_ref_rp_seq      START WITH 1009;
CREATE SEQUENCE IF NOT EXISTS booking_ref_fr_seq      START WITH 1100;
CREATE SEQUENCE IF NOT EXISTS booking_ref_rl_seq      START WITH 1002;
CREATE SEQUENCE IF NOT EXISTS booking_ref_in_seq      START WITH 1002;

CREATE OR REPLACE FUNCTION generate_booking_reference()
RETURNS TRIGGER AS $$
DECLARE
  v_global      bigint;
  v_type_prefix text;
  v_type_num    bigint;
BEGIN
  v_global := nextval('booking_ref_global_seq');

  CASE NEW.booking_type
    WHEN 'installation'      THEN v_type_prefix := 'NB'; v_type_num := nextval('booking_ref_nb_seq');
    WHEN 'repair'            THEN v_type_prefix := 'RP'; v_type_num := nextval('booking_ref_rp_seq');
    WHEN 'quarterly_service' THEN v_type_prefix := 'FR'; v_type_num := nextval('booking_ref_fr_seq');
    WHEN 'maintenance'       THEN v_type_prefix := 'FR'; v_type_num := nextval('booking_ref_fr_seq');
    WHEN 'relocation'        THEN v_type_prefix := 'RL'; v_type_num := nextval('booking_ref_rl_seq');
    WHEN 'inspection'        THEN v_type_prefix := 'IN'; v_type_num := nextval('booking_ref_in_seq');
    ELSE v_type_prefix := NULL; v_type_num := NULL;
  END CASE;

  IF v_type_prefix IS NOT NULL THEN
    NEW.booking_reference := 'SW-' || v_global || ' - ' || v_type_prefix || ' ' || v_type_num;
  ELSE
    NEW.booking_reference := 'SW-' || v_global;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger itself is unchanged (still BEFORE INSERT, still calls this function) —
-- CREATE OR REPLACE above is enough, no need to touch the trigger definition.
