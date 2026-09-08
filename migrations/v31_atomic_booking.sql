-- =============================================================================
-- SA'DA H2O — v31  Atomic booking creation (fixes slot-reservation leaks)
--
-- THE BUG THIS FIXES:
-- Booking was a two-step client operation:
--   1) UPDATE availability_slots SET is_booked=true   (reserve)
--   2) INSERT INTO bookings ...                        (book)
-- If anything between them failed — network drop, tab close, phone backgrounded
-- mid-flow — the slot stayed is_booked=true with NO booking. That slot then
-- shows "just booked by someone else" to every future customer, permanently.
-- Two such leaked slots were found in production (both from failed attempts).
--
-- THE FIX:
-- One SECURITY DEFINER function does reserve + insert in a single transaction.
-- If the slot is already taken, it raises and NOTHING changes. If the insert
-- fails, the reserve rolls back automatically (same transaction). No leak window.
--
-- The client calls db.rpc('create_booking', {...}) instead of the two-step dance.
-- booking_reference is still filled by the existing trigger.
--
-- Idempotent (CREATE OR REPLACE). Run AFTER v30.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_booking(
  p_slot_id      uuid,
  p_name         text,
  p_phone        text,
  p_city_name    text,
  p_region_id    uuid,
  p_address      text,
  p_latitude     numeric DEFAULT NULL,
  p_longitude    numeric DEFAULT NULL
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
  -- Lock the slot row FOR UPDATE so two concurrent callers can't both pass the
  -- check. This is the true atomic guard — stronger than the client's
  -- UPDATE...WHERE is_booked=false, because the row is locked for the whole txn.
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
  -- Region sanity: the slot must belong to the region the customer chose.
  IF p_region_id IS NOT NULL AND v_slot.service_region_id IS DISTINCT FROM p_region_id THEN
    RAISE EXCEPTION 'slot_region_mismatch' USING ERRCODE = 'P0001';
  END IF;

  -- Reserve.
  UPDATE availability_slots SET is_booked = true WHERE id = p_slot_id;

  -- Book. booking_reference is set by the existing BEFORE-INSERT trigger.
  INSERT INTO bookings (
    customer_name, customer_email, customer_phone,
    city_id, city_name, service_region_id, location_address,
    latitude, longitude, slot_id, slot_date, slot_hour,
    status, booking_type
  ) VALUES (
    p_name, '', p_phone,
    NULL, p_city_name, p_region_id, p_address,
    p_latitude, p_longitude, p_slot_id, v_slot.slot_date, v_slot.slot_hour,
    'upcoming', 'installation'
  )
  RETURNING id, bookings.booking_reference INTO v_id, v_ref;

  -- If we reach here both succeeded; the txn commits atomically.
  RETURN QUERY SELECT v_id, v_ref, v_slot.slot_date, v_slot.slot_hour;
END;
$$;

-- anon (the public booking page) and authenticated may call it.
GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric) TO anon, authenticated;

-- =============================================================================
-- One-time cleanup: free any slots leaked by the OLD two-step path (booked but
-- no active booking references them). Safe: only frees future/past slots that
-- have NO non-cancelled booking pointing at them.
-- =============================================================================
UPDATE availability_slots s
SET is_booked = false
WHERE s.is_booked = true
  AND NOT EXISTS (
    SELECT 1 FROM bookings b
    WHERE b.slot_id = s.id AND b.status <> 'cancelled'
  );

-- verification (run separately after):
-- SELECT count(*) FROM availability_slots s
--   WHERE s.is_booked = true
--     AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.slot_id=s.id AND b.status<>'cancelled');
--   → expect 0  (no leaks remain)
