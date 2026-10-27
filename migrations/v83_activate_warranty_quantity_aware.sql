-- =============================================================================
-- SA'DA H2O — v83  Let a qty>1 booking get one warranty PER unit
--
-- v82's "already has a warranty for this booking_id" guard was a blunt
-- existence check — correct for a qty=1 booking, but wrong for e.g. a
-- booking with "7 stage RO - A100 ×2": the FIRST activation call would
-- create one warranty, and v82 would then block the second physical unit
-- from EVER getting its own, since "a warranty already exists for this
-- booking" was already true.
--
-- Replaces that with a quantity-aware check: count how many warranties
-- already exist for this booking_id, compare against how many serialized
-- units the booking is actually for (sum of booking_items.qty, falling
-- back to bookings.product_qty), and only treat it as fully done once that
-- many exist. Each individual warranty row still represents exactly one
-- physical unit (quantity always 1) — matching how scanning N separate
-- physical QR stickers for N units already works.
--
-- Idempotent. Run AFTER v82.
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
  -- warranties exist for it as the booking actually calls for.
  IF p_booking_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_existing_count FROM warranties WHERE booking_id = p_booking_id;

    SELECT COALESCE(SUM(bi.qty), 0) INTO v_target_qty
    FROM booking_items bi
    WHERE bi.booking_id = p_booking_id AND COALESCE(bi.is_serialized, true) = true;
    IF v_target_qty = 0 THEN
      SELECT COALESCE(product_qty, 1) INTO v_target_qty FROM bookings WHERE id = p_booking_id;
    END IF;
    v_target_qty := GREATEST(COALESCE(v_target_qty, 1), 1);

    IF v_existing_count >= v_target_qty THEN
      SELECT id INTO v_clash FROM warranties WHERE booking_id = p_booking_id ORDER BY created_at DESC LIMIT 1;
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
  -- (the QR-scan flow has no booking context to narrow this to).
  IF p_booking_id IS NOT NULL THEN
    SELECT bi.product_model INTO v_product
    FROM booking_items bi
    WHERE bi.booking_id = p_booking_id AND COALESCE(bi.is_serialized, true) = true
    LIMIT 1;
    IF v_product IS NULL THEN
      SELECT product_model INTO v_product FROM bookings WHERE id = p_booking_id;
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
    SELECT product_model INTO v_product
    FROM bookings
    WHERE customer_phone = p_phone
    ORDER BY installed_at DESC NULLS LAST, created_at DESC
    LIMIT 1;
  END IF;
  v_product := COALESCE(v_product, 'RO');

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
-- SELECT booking_id, count(*) FROM warranties WHERE booking_id IS NOT NULL GROUP BY booking_id;
