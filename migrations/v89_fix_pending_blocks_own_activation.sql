-- =============================================================================
-- SA'DA H2O — v89  Fix: a booking's own pending warranty blocked its activation
--
-- Bug: activate_pending_warranty()'s qty-aware "already fully activated" guard
-- (added in v83) counted ALL warranties linked to p_booking_id regardless of
-- status:
--
--   SELECT COUNT(*) INTO v_existing_count FROM warranties WHERE booking_id = p_booking_id;
--   ...
--   IF v_existing_count >= v_target_qty THEN
--     RETURN jsonb_build_object('ok', true, 'reason', 'already_active', ...);
--   END IF;
--
-- The installer's job-completion step auto-creates a PENDING warranty for
-- every real unit, already linked via booking_id (js/inspection-report.js,
-- createPendingWarranties()). So for an ordinary qty=1 installation,
-- v_existing_count was already 1 (the pending row itself) before the
-- customer ever did anything — equal to v_target_qty, so the function
-- returned early with reason:'already_active' and NEVER reached the UPDATE
-- that actually flips status to 'active'.
--
-- This was invisible until now because:
--   • The physical QR-scan flow (warranty/claim.html) never passes
--     p_booking_id at all, so it always skipped this whole IF block.
--   • The in-app "Activate Your Warranty" button DOES pass p_booking_id, but
--     the portal only just started offering that button for a unit stuck in
--     pending (see customer/portal.html findActivatableBooking fix) — before
--     that, this code path had never actually been exercised by a pending
--     unit, so the bug sat dormant.
--
-- Symptom: customer taps "Activate Warranty" → UI shows "Warranty
-- Activated!" (the RPC returns ok:true) → but the row is still 'pending'
-- underneath, so reloading the page shows the exact same activation prompt
-- again. Looks like "nothing happened."
--
-- Fix: only count NON-pending warranties toward "already fully activated"
-- for this booking. A pending row is exactly "not yet activated" — it must
-- not count as proof the booking is already done.
--
-- Idempotent. Run AFTER v86 (same function signature/body otherwise).
-- =============================================================================

CREATE OR REPLACE FUNCTION activate_pending_warranty(p_phone text, p_serial text, p_booking_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cid uuid;
  v_name text;
  v_has_any_booking boolean;
  v_warr warranties%ROWTYPE;
  v_clash uuid;
  v_product text;
  v_existing_count int;
  v_target_qty int;
BEGIN
  IF p_phone IS NULL OR btrim(p_phone) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_phone');
  END IF;

  IF p_serial IS NOT NULL AND btrim(p_serial) <> '' THEN
    SELECT id INTO v_clash FROM warranties WHERE qr_code = p_serial AND status <> 'pending' LIMIT 1;
    IF v_clash IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'already_active', 'warranty_id', v_clash);
    END IF;
  END IF;

  -- This booking may need more than one warranty (qty>1 line item = that
  -- many physical units) — only treat it as fully activated once as many
  -- NON-PENDING warranties exist for it as the booking actually calls for.
  -- A pending row (the installer's own placeholder) must not count as
  -- "already activated" — that's exactly the status this function exists
  -- to move it out of.
  IF p_booking_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_existing_count FROM warranties WHERE booking_id = p_booking_id AND status <> 'pending';

    SELECT COALESCE(SUM(bi.qty), 0) INTO v_target_qty
    FROM booking_items bi
    WHERE bi.booking_id = p_booking_id AND COALESCE(bi.is_serialized, true) = true;
    IF v_target_qty = 0 THEN
      SELECT COALESCE(product_qty, 1) INTO v_target_qty FROM bookings WHERE id = p_booking_id;
    END IF;
    v_target_qty := GREATEST(COALESCE(v_target_qty, 1), 1);

    IF v_existing_count >= v_target_qty THEN
      SELECT id INTO v_clash FROM warranties WHERE booking_id = p_booking_id AND status <> 'pending' ORDER BY created_at DESC LIMIT 1;
      RETURN jsonb_build_object('ok', true, 'reason', 'already_active', 'warranty_id', v_clash);
    END IF;
  END IF;

  SELECT id, name INTO v_cid, v_name FROM customers WHERE phone = p_phone LIMIT 1;
  SELECT EXISTS(SELECT 1 FROM bookings WHERE customer_phone = p_phone) INTO v_has_any_booking;

  -- No installation-status gate: any booking on this phone (any status) or an
  -- existing customer record is enough to link the warranty to someone.
  IF v_cid IS NULL AND NOT v_has_any_booking THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  IF v_cid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  -- Prefer the product from the specific booking being activated (when the
  -- caller knows it, i.e. the in-app flow); fall back to the newest
  -- serialized item across any of the customer's bookings, same as before
  -- (the QR-scan flow has no booking context to narrow this to). Every
  -- path here is gated on is_serialized = true (via product_models for the
  -- two that read bookings.product_model directly, which has no is_
  -- serialized column of its own) — none of them can land on a dispenser.
  IF p_booking_id IS NOT NULL THEN
    SELECT bi.product_model INTO v_product
    FROM booking_items bi
    WHERE bi.booking_id = p_booking_id AND COALESCE(bi.is_serialized, true) = true
    LIMIT 1;
    IF v_product IS NULL THEN
      SELECT b.product_model INTO v_product
      FROM bookings b
      LEFT JOIN product_models pm ON pm.model_name = b.product_model
      WHERE b.id = p_booking_id AND COALESCE(pm.is_serialized, true) = true;
    END IF;
  END IF;
  IF v_product IS NULL THEN
    SELECT bi.product_model INTO v_product
    FROM bookings b
    JOIN booking_items bi ON bi.booking_id = b.id
    WHERE b.customer_phone = p_phone
      AND COALESCE(bi.is_serialized, true) = true
    ORDER BY b.installed_at DESC NULLS LAST, b.created_at DESC
    LIMIT 1;
  END IF;
  IF v_product IS NULL THEN
    SELECT b.product_model INTO v_product
    FROM bookings b
    LEFT JOIN product_models pm ON pm.model_name = b.product_model
    WHERE b.customer_phone = p_phone AND COALESCE(pm.is_serialized, true) = true
    ORDER BY b.installed_at DESC NULLS LAST, b.created_at DESC
    LIMIT 1;
  END IF;

  -- Every path above only ever resolves a serialized (non-dispenser)
  -- product — if none exists for this phone/booking, there's genuinely
  -- nothing to activate (e.g. a dispenser-only booking), rather than
  -- falling back to 'RO' and activating something that shouldn't exist.
  IF v_product IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'dispenser');
  END IF;

  -- Only reuse an existing pending row that isn't already claimed by a
  -- different booking — otherwise a second installation's activation could
  -- silently overwrite the first one's still-pending row.
  SELECT * INTO v_warr FROM warranties
   WHERE customer_id = v_cid AND status = 'pending'
     AND (booking_id IS NULL OR p_booking_id IS NULL OR booking_id = p_booking_id)
   ORDER BY created_at ASC LIMIT 1;

  IF v_warr.id IS NULL THEN
    INSERT INTO warranties (
      customer_id, qr_code, product_type, quantity, status, booking_id,
      registration_date, filter_expiry, service_expiry, warranty_expiry,
      activated_by, activated_at
    ) VALUES (
      v_cid, p_serial, v_product, 1, 'active', p_booking_id,
      CURRENT_DATE,
      (CURRENT_DATE + INTERVAL '90 days'),
      (CURRENT_DATE + INTERVAL '365 days'),
      (CURRENT_DATE + INTERVAL '730 days'),
      'customer (scan)', now()
    )
    RETURNING * INTO v_warr;
    RETURN jsonb_build_object('ok', true, 'reason', 'activated_new', 'warranty_id', v_warr.id, 'name', v_name);
  END IF;

  UPDATE warranties
     SET qr_code = COALESCE(p_serial, qr_code),
         status = 'active',
         booking_id = COALESCE(booking_id, p_booking_id),
         product_type = CASE WHEN product_type IS NULL OR product_type IN ('','RO')
                             THEN v_product ELSE product_type END,
         registration_date = COALESCE(registration_date, CURRENT_DATE),
         filter_expiry   = COALESCE(filter_expiry,  (CURRENT_DATE + INTERVAL '90 days')),
         service_expiry  = COALESCE(service_expiry, (CURRENT_DATE + INTERVAL '365 days')),
         warranty_expiry = (CURRENT_DATE + INTERVAL '730 days'),
         activated_by = 'customer (scan)',
         activated_at = now()
   WHERE id = v_warr.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'activated', 'warranty_id', v_warr.id, 'name', v_name);
END;
$$;
GRANT EXECUTE ON FUNCTION activate_pending_warranty(text, text, uuid) TO anon, authenticated;

-- verification:
-- SELECT activate_pending_warranty('+9665XXXXXXXX', 'TEST-SERIAL', '<booking-id-with-only-a-pending-warranty>');
--   -> should now return reason 'activated', not 'already_active'
