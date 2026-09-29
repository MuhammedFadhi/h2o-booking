-- =============================================================================
-- create_booking() carries slot_minute/duration_minutes through from the
-- slot it reserves into the booking it creates, and returns them too (so
-- callers can show the correct time without a second query).
--
-- Parameter list is UNCHANGED (still the same 9 params as v54/v56) — only
-- the RETURNS TABLE column list and the INSERT grow by two columns. Adding
-- return columns is NOT something CREATE OR REPLACE can do in place (Postgres
-- rejects a return-type change on REPLACE), so this explicitly DROPs the
-- exact 9-arg signature first, then recreates it — idempotent, safe to re-run.
--
-- Existing callers are unaffected: they only ever read booking_id/
-- booking_reference/slot_date/slot_hour off the result, and extra columns on
-- a Postgres RPC's return row are simply additional properties on the JS
-- object PostgREST returns — nothing breaks by them showing up unused.
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_booking(uuid, text, text, text, uuid, text, numeric, numeric, text);

CREATE OR REPLACE FUNCTION public.create_booking(
  p_slot_id      uuid,
  p_name         text,
  p_phone        text,
  p_city_name    text,
  p_region_id    uuid,
  p_address      text,
  p_latitude     numeric DEFAULT NULL,
  p_longitude    numeric DEFAULT NULL,
  p_booking_type text DEFAULT 'installation'
)
RETURNS TABLE (
  booking_id       uuid,
  booking_reference text,
  slot_date        date,
  slot_hour        int,
  slot_minute      int,
  duration_minutes int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_slot   availability_slots%ROWTYPE;
  v_id     uuid;
  v_ref    text;
BEGIN
  SELECT * INTO v_slot
  FROM availability_slots
  WHERE id = p_slot_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'slot_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF v_slot.is_booked THEN
    RAISE EXCEPTION 'slot_already_booked' USING ERRCODE = 'P0001';
  END IF;
  IF v_slot.is_available IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'slot_not_available' USING ERRCODE = 'P0001';
  END IF;
  IF p_region_id IS NOT NULL AND v_slot.service_region_id IS DISTINCT FROM p_region_id THEN
    RAISE EXCEPTION 'slot_region_mismatch' USING ERRCODE = 'P0001';
  END IF;

  UPDATE availability_slots SET is_booked = true WHERE id = p_slot_id;

  INSERT INTO bookings (
    customer_name, customer_email, customer_phone,
    city_id, city_name, service_region_id, location_address,
    latitude, longitude, slot_id, slot_date, slot_hour, slot_minute, duration_minutes,
    status, booking_type, created_by, created_by_name
  ) VALUES (
    p_name, '', p_phone,
    NULL, p_city_name, p_region_id, p_address,
    p_latitude, p_longitude, p_slot_id, v_slot.slot_date, v_slot.slot_hour,
    COALESCE(v_slot.slot_minute, 0), COALESCE(v_slot.duration_minutes, 60),
    'upcoming', COALESCE(p_booking_type, 'installation'), 'customer', 'Customer'
  )
  RETURNING id, bookings.booking_reference INTO v_id, v_ref;

  RETURN QUERY SELECT v_id, v_ref, v_slot.slot_date, v_slot.slot_hour,
    COALESCE(v_slot.slot_minute, 0), COALESCE(v_slot.duration_minutes, 60);
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric,text) TO anon, authenticated;
