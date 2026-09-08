-- =============================================================================
-- SA'DA H2O — v40  Fix customer-scan warranty expiries
--
-- BUG: activate_pending_warranty is SECURITY DEFINER, so it runs as the function
-- owner, NOT 'anon'. The guard_anon_warranty_insert trigger only fills
-- filter/service/warranty expiries when current_user = 'anon', so warranties
-- created/updated via the RPC ended up with NULL service_expiry & warranty_expiry
-- (and product_type hardcoded to 'RO' on the fallback path).
--
-- FIX:
--   1. Rewrite activate_pending_warranty so BOTH paths explicitly set all three
--      expiries (filter +90d, service +365d, warranty +730d) and use the real
--      product from the customer's most recent installed/completed booking item
--      instead of the literal 'RO'.
--   2. Backfill any already-activated warranties missing service/warranty dates.
--
-- Idempotent. Run AFTER v39.
-- =============================================================================

CREATE OR REPLACE FUNCTION activate_pending_warranty(p_phone text, p_serial text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cid uuid;
  v_name text;
  v_has_booking boolean;
  v_warr warranties%ROWTYPE;
  v_clash uuid;
  v_product text;
BEGIN
  IF p_phone IS NULL OR btrim(p_phone) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_phone');
  END IF;

  -- Serial already registered on a non-pending warranty? (idempotent re-scan)
  IF p_serial IS NOT NULL AND btrim(p_serial) <> '' THEN
    SELECT id INTO v_clash FROM warranties WHERE qr_code = p_serial AND status <> 'pending' LIMIT 1;
    IF v_clash IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'reason', 'already_active', 'warranty_id', v_clash);
    END IF;
  END IF;

  -- Find the customer by phone.
  SELECT id, name INTO v_cid, v_name FROM customers WHERE phone = p_phone LIMIT 1;
  IF v_cid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  -- Must have an installed/completed booking.
  SELECT EXISTS(
    SELECT 1 FROM bookings
    WHERE customer_phone = p_phone AND status IN ('installed','completed')
  ) INTO v_has_booking;
  IF NOT v_has_booking THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  -- Best-effort real product name: newest serialized booking_item on an
  -- installed/completed booking for this phone; else the booking summary; else 'RO'.
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

  -- Oldest pending warranty for this customer.
  SELECT * INTO v_warr FROM warranties
   WHERE customer_id = v_cid AND status = 'pending'
   ORDER BY created_at ASC LIMIT 1;

  IF v_warr.id IS NULL THEN
    -- No pending warranty — create one fully-formed (all expiries + real product).
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

  -- Activate the pending one: set serial, activate, and ensure all expiries exist.
  UPDATE warranties
     SET qr_code = COALESCE(p_serial, qr_code),
         status = 'active',
         product_type = CASE WHEN product_type IS NULL OR product_type IN ('','RO')
                             THEN v_product ELSE product_type END,
         registration_date = COALESCE(registration_date, CURRENT_DATE),
         filter_expiry   = COALESCE(filter_expiry,   (CURRENT_DATE + INTERVAL '90 days')),
         service_expiry  = COALESCE(service_expiry,  (CURRENT_DATE + INTERVAL '365 days')),
         warranty_expiry = COALESCE(warranty_expiry, (CURRENT_DATE + INTERVAL '730 days')),
         activated_by = 'customer (scan)',
         activated_at = now()
   WHERE id = v_warr.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'activated', 'warranty_id', v_warr.id, 'name', v_name);
END;
$$;
GRANT EXECUTE ON FUNCTION activate_pending_warranty(text, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- BACKFILL: fix already-activated warranties missing service/warranty expiries.
-- Anchor the intervals on the existing registration_date (or filter_expiry - 90d,
-- or today) so dates stay internally consistent with the filter date.
-- ---------------------------------------------------------------------------
UPDATE warranties
SET
  service_expiry  = COALESCE(service_expiry,  (COALESCE(registration_date, (filter_expiry::date - 90), CURRENT_DATE) + INTERVAL '365 days')),
  warranty_expiry = COALESCE(warranty_expiry, (COALESCE(registration_date, (filter_expiry::date - 90), CURRENT_DATE) + INTERVAL '730 days')),
  filter_expiry   = COALESCE(filter_expiry,   (COALESCE(registration_date, CURRENT_DATE) + INTERVAL '90 days'))
WHERE status <> 'pending'
  AND (service_expiry IS NULL OR warranty_expiry IS NULL OR filter_expiry IS NULL);

-- Upgrade generic 'RO' product_type to the real model from the customer's booking,
-- for warranties created via the RPC fallback (customer scan with no pending row).
UPDATE warranties w
SET product_type = sub.model
FROM (
  SELECT DISTINCT ON (c.id) c.id AS cid, bi.product_model AS model
  FROM customers c
  JOIN bookings b ON b.customer_phone = c.phone AND b.status IN ('installed','completed')
  JOIN booking_items bi ON bi.booking_id = b.id AND COALESCE(bi.is_serialized, true) = true
  ORDER BY c.id, b.installed_at DESC NULLS LAST, b.created_at DESC
) sub
WHERE w.customer_id = sub.cid
  AND (w.product_type = 'RO' OR w.product_type IS NULL)
  AND sub.model IS NOT NULL;

-- verification (run separately):
-- SELECT qr_code, product_type, filter_expiry, service_expiry, warranty_expiry
-- FROM warranties WHERE activated_by = 'customer (scan)';
