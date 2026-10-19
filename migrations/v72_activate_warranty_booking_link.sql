-- =============================================================================
-- SA'DA H2O — v72  Link a self-activated warranty back to its booking
--
-- activate_pending_warranty() (v46) never recorded which booking a
-- self-activated warranty (QR scan, or the new in-app "Activate Warranty"
-- card on My Unit) came from — only customer_id. That's fine for a customer
-- with a single installation, but breaks for one with two or more: there was
-- no way to tell "has booking #2 been activated yet?" once booking #1's
-- warranty already existed, so the in-app activation card could only ever
-- offer the customer's FIRST unit.
--
-- Adds an optional p_booking_id param (DEFAULT NULL, so the existing
-- warranty/claim.html QR-scan call — which has no booking context, just a
-- phone + the serial off the sticker — keeps working completely unchanged)
-- and records it on both the "create new" and "reuse an existing pending
-- row" paths.
--
-- CREATE OR REPLACE can't change a function's parameter list — a 3-arg
-- version would just sit ALONGSIDE the old 2-arg one, and Postgres prefers
-- an exact-arity match, so claim.html's existing 2-arg call would keep
-- silently hitting the old, un-patched version. Drop it first so there's
-- only ever one definition; a 2-arg call still works fine against the new
-- 3-arg one via p_booking_id's default.
--
-- Idempotent. Run AFTER v46.
-- =============================================================================

DROP FUNCTION IF EXISTS activate_pending_warranty(text, text);

CREATE OR REPLACE FUNCTION activate_pending_warranty(p_phone text, p_serial text, p_booking_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cid uuid;
  v_name text;
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
-- SELECT booking_id, qr_code, product_type, status FROM warranties ORDER BY created_at DESC LIMIT 10;
