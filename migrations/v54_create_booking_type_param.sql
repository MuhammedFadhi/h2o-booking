-- v54: create_booking() accepts the real booking_type, instead of always
-- inserting 'installation' and letting the caller UPDATE it afterward.
--
-- Bug this fixes: admin's "Service / Repair" flow (submitServiceBooking() in
-- admin/dashboard.html) calls create_booking() to reserve the slot + insert
-- the row, then immediately UPDATEs booking_type to the real job type
-- (repair/relocation/quarterly_service/...). But booking_reference is set by
-- a BEFORE INSERT trigger (see v53_booking_reference_by_type.sql), which only
-- ever saw booking_type = 'installation' at insert time — so every repair,
-- relocation, filter-change etc. booked through that flow got an "NB-" prefix
-- instead of the correct "RP-"/"RL-"/"FR-" one, regardless of its real type.
--
-- Fix: create_booking() takes an optional p_booking_type (default
-- 'installation', so every existing caller — the public booking page, admin's
-- "Book for Customer" — is unaffected) and inserts it directly, so the
-- trigger sees the correct type immediately and no follow-up UPDATE is
-- needed. admin/dashboard.html's submitServiceBooking() now passes
-- p_booking_type: jobType and drops booking_type from its follow-up patch.
--
-- CORRECTION (see v56_fix_create_booking_overload.sql): adding this trailing
-- parameter via CREATE OR REPLACE does NOT replace the original function as
-- assumed below — Postgres creates a second, separate overload instead,
-- which broke every create_booking() call once this ran. v56 drops the old
-- 8-arg overload to fix it. Left this file's history as-is; see v56 for what
-- actually happened.
-- Does NOT retroactively fix booking_reference on already-created rows.

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

GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric,text) TO anon, authenticated;
