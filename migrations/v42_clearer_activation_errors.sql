-- =============================================================================
-- SA'DA H2O — v42  Clearer activation errors
--
-- Problem: activate_pending_warranty returned reason 'no_booking' for BOTH
--   (a) a phone with a booking that isn't installed yet, and
--   (b) a phone with no booking at all.
-- The claim page showed "No booking is linked to this number" for both, which
-- confused customers who scanned before the installer marked the job complete.
--
-- Fix: add a distinct reason 'not_installed_yet' when the customer HAS a booking
-- but none is installed/completed. The claim page then shows a helpful message
-- ("your installation isn't marked complete yet") instead of the wrong one.
--
-- Everything else is identical to v41. Idempotent. Run AFTER v41.
-- =============================================================================

CREATE OR REPLACE FUNCTION activate_pending_warranty(p_phone text, p_serial text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cid uuid;
  v_name text;
  v_has_booking boolean;
  v_has_any_booking boolean;
  v_warr warranties%ROWTYPE;
  v_clash uuid;
  v_product text;
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

  SELECT id, name INTO v_cid, v_name FROM customers WHERE phone = p_phone LIMIT 1;

  -- Distinguish: any booking at all on this phone vs an installed/completed one.
  SELECT EXISTS(SELECT 1 FROM bookings WHERE customer_phone = p_phone) INTO v_has_any_booking;
  SELECT EXISTS(
    SELECT 1 FROM bookings
    WHERE customer_phone = p_phone AND status IN ('installed','completed')
  ) INTO v_has_booking;

  IF v_cid IS NULL AND NOT v_has_any_booking THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  IF NOT v_has_booking THEN
    -- They have a booking (or a customer record) but nothing installed yet.
    IF v_has_any_booking THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'not_installed_yet');
    ELSE
      RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
    END IF;
  END IF;

  -- From here, an installed/completed booking exists. Ensure we have a customer id.
  IF v_cid IS NULL THEN
    SELECT id, name INTO v_cid, v_name FROM customers WHERE phone = p_phone LIMIT 1;
    IF v_cid IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
    END IF;
  END IF;

  -- Real product from newest serialized booking item, else booking summary, else 'RO'.
  SELECT bi.product_model INTO v_product
  FROM bookings b
  JOIN booking_items bi ON bi.booking_id = b.id
  WHERE b.customer_phone = p_phone
    AND b.status IN ('installed','completed')
    AND COALESCE(bi.is_serialized, true) = true
  ORDER BY b.installed_at DESC NULLS LAST, b.created_at DESC
  LIMIT 1;
  IF v_product IS NULL THEN
    SELECT product_model INTO v_product
    FROM bookings
    WHERE customer_phone = p_phone AND status IN ('installed','completed')
    ORDER BY installed_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  v_product := COALESCE(v_product, 'RO');

  SELECT * INTO v_warr FROM warranties
   WHERE customer_id = v_cid AND status = 'pending'
   ORDER BY created_at ASC LIMIT 1;

  IF v_warr.id IS NULL THEN
    INSERT INTO warranties (
      customer_id, qr_code, product_type, quantity, status,
      registration_date, filter_expiry, service_expiry, warranty_expiry,
      activated_by, activated_at
    ) VALUES (
      v_cid, p_serial, v_product, 1, 'active',
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
GRANT EXECUTE ON FUNCTION activate_pending_warranty(text, text) TO anon, authenticated;
