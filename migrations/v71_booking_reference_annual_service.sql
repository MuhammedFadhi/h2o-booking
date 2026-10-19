-- =============================================================================
-- SA'DA H2O — v71  Give Annual RO Service its own booking reference code
--
-- migrations/v55 gave every booking_type its own "SW-<global#> - <TYPE> <n>"
-- type code (NB/RP/FR/RL/IN) EXCEPT 'annual_service', which fell through to
-- the generic "any other type" fallback — no type suffix at all, just
-- "SW-<global#>". Give it a dedicated AN code, same pattern as the rest.
--
-- Only affects bookings created AFTER this runs — existing annual_service
-- references stay as plain "SW-<n>" (same "don't touch history" principle
-- v55 itself followed for the old pre-v55 format).
--
-- Idempotent. Run AFTER v55.
-- =============================================================================

CREATE SEQUENCE IF NOT EXISTS booking_ref_an_seq START WITH 1002;

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
    WHEN 'annual_service'    THEN v_type_prefix := 'AN'; v_type_num := nextval('booking_ref_an_seq');
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

-- Trigger itself is unchanged (still BEFORE INSERT, still calls this
-- function) — CREATE OR REPLACE above is enough, no need to touch it.

-- verification (run separately):
-- SELECT booking_reference FROM bookings WHERE booking_type = 'annual_service' ORDER BY created_at DESC LIMIT 5;
