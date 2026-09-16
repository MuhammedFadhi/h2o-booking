-- v48: booking authorship — who created it, and which sales agent gets credit.
--
-- created_by_name — display name of the creator, or 'Customer' for a
--                    self-service booking via the public link. (Distinct from
--                    the existing `created_by` flag column, which stays the
--                    coarse 'admin' | 'customer' marker other code already
--                    branches on — left untouched.)
-- sales_agent      — the admin/sales user credited for the sale. Defaults to
--                    the creating admin, editable afterward via a dropdown.
--                    NULL (shown as "—") for customer self-bookings until an
--                    admin assigns one.
--
-- Idempotent — safe to re-run.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_by_name text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sales_agent text;

-- Backfill legacy rows so the admin console doesn't show a blank for old data.
UPDATE bookings SET created_by_name = 'Customer'
WHERE created_by = 'customer' AND created_by_name IS NULL;

-- ---------------------------------------------------------------------------
-- Every booking (customer self-book link, admin "book for customer", admin
-- "service visit") goes through this one RPC (see v31_atomic_booking.sql).
-- Default the insert to the customer-authored values; both admin flows
-- immediately overwrite created_by / created_by_name / sales_agent in their
-- own follow-up UPDATE, so this only "sticks" for genuine self-bookings.
-- ---------------------------------------------------------------------------
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
    'upcoming', 'installation', 'customer', 'Customer'
  )
  RETURNING id, bookings.booking_reference INTO v_id, v_ref;

  RETURN QUERY SELECT v_id, v_ref, v_slot.slot_date, v_slot.slot_hour;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric) TO anon, authenticated;
