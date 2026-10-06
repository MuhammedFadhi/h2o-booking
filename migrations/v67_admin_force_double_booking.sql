-- ============================================================
-- SA'DA H2O — v67 migration
-- Let an admin deliberately double-book an already-taken slot.
--
-- Adds p_force (default false) to create_booking(). When true AND the
-- caller is a recognised admin (is_admin() — checked server-side, never
-- trusting the client flag alone), the slot_already_booked check is
-- skipped. Everyone else (customers, non-admin staff) is unaffected —
-- the slot-exclusivity check still applies to them exactly as before.
--
-- Drops the old 9-arg overload first (same lesson as v56: adding a
-- trailing param via CREATE OR REPLACE creates a second overload
-- instead of replacing the function, which breaks every call that
-- doesn't pass the new param).
--
-- NOTE: freeing a slot (is_booked = false) on cancel/delete/reschedule
-- still needs a follow-up fix — right now those blindly free the slot
-- whenever ANY one booking using it is removed, which would wrongly
-- free a slot that a second (force-booked) booking still needs. Flagged
-- separately; this migration only unblocks creation.
--
-- Safe to re-run.
-- ============================================================

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
  p_booking_type text DEFAULT 'installation',
  p_force        boolean DEFAULT false
)
RETURNS TABLE (booking_id uuid, booking_reference text, slot_date date, slot_hour int)
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
  IF v_slot.is_booked AND NOT (p_force AND is_admin()) THEN
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
    latitude, longitude, slot_id, slot_date, slot_hour,
    status, booking_type, created_by, created_by_name
  ) VALUES (
    p_name, '', p_phone,
    NULL, p_city_name, p_region_id, p_address,
    p_latitude, p_longitude, p_slot_id, v_slot.slot_date, v_slot.slot_hour,
    'upcoming', COALESCE(p_booking_type, 'installation'), 'customer', 'Customer'
  )
  RETURNING id, bookings.booking_reference INTO v_id, v_ref;

  RETURN QUERY SELECT v_id, v_ref, v_slot.slot_date, v_slot.slot_hour;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric,text,boolean) TO anon, authenticated;
