-- v99: Filter Change / Annual Service / Warranty intervals, per product.
--
-- Previously hardcoded everywhere as 90/365/730 days. Every product now
-- carries its own interval (defaulting to those same numbers, so existing
-- products are unaffected until an admin edits one in the new Products
-- panel). The three server-side triggers that compute these dates now look
-- the interval up from product_models by name instead of hardcoding it;
-- client-side writers (js/inspection-report.js, admin/dashboard.html) and
-- read-side display math (js/warranty.js) are updated separately in this
-- same change, reading these same columns.

ALTER TABLE product_models ADD COLUMN IF NOT EXISTS filter_interval_days   int NOT NULL DEFAULT 90;
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS service_interval_days  int NOT NULL DEFAULT 365;
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS warranty_interval_days int NOT NULL DEFAULT 730;


-- 1) Anon QR-claim guard (v27) — looks up NEW.product_type, which the client
--    already sends untouched; everything else in this trigger is unchanged.
CREATE OR REPLACE FUNCTION public.guard_anon_warranty_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_filter_days int; v_service_days int; v_warranty_days int;
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;   -- admin path: trusted, set whatever
  END IF;

  SELECT filter_interval_days, service_interval_days, warranty_interval_days
    INTO v_filter_days, v_service_days, v_warranty_days
    FROM product_models WHERE model_name = NEW.product_type;
  v_filter_days   := COALESCE(v_filter_days, 90);
  v_service_days  := COALESCE(v_service_days, 365);
  v_warranty_days := COALESCE(v_warranty_days, 730);

  NEW.registration_date := CURRENT_DATE;
  NEW.filter_expiry     := (CURRENT_DATE + (v_filter_days   || ' days')::interval);
  NEW.service_expiry    := (CURRENT_DATE + (v_service_days  || ' days')::interval);
  NEW.warranty_expiry   := (CURRENT_DATE + (v_warranty_days || ' days')::interval);
  NEW.quantity          := 1;
  NEW.client_code       := NULL;
  NEW.legacy_id         := NULL;
  RETURN NEW;
END; $$;


-- 2) activate_pending_warranty (v91) — v_product is already resolved by this
--    point (same logic, untouched); only the three hardcoded intervals change.
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
  v_filter_days int;
  v_service_days int;
  v_warranty_days int;
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

  IF v_cid IS NULL AND NOT v_has_any_booking THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  IF v_cid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

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

  IF v_product IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'dispenser');
  END IF;

  SELECT filter_interval_days, service_interval_days, warranty_interval_days
    INTO v_filter_days, v_service_days, v_warranty_days
    FROM product_models WHERE model_name = v_product;
  v_filter_days   := COALESCE(v_filter_days, 90);
  v_service_days  := COALESCE(v_service_days, 365);
  v_warranty_days := COALESCE(v_warranty_days, 730);

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
      (CURRENT_DATE + (v_filter_days   || ' days')::interval),
      (CURRENT_DATE + (v_service_days  || ' days')::interval),
      (CURRENT_DATE + (v_warranty_days || ' days')::interval),
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
         filter_expiry   = COALESCE(filter_expiry,  (CURRENT_DATE + (v_filter_days  || ' days')::interval)),
         service_expiry  = COALESCE(service_expiry, (CURRENT_DATE + (v_service_days || ' days')::interval)),
         warranty_expiry = (CURRENT_DATE + (v_warranty_days || ' days')::interval),
         activated_by = 'customer (scan)',
         activated_at = now()
   WHERE id = v_warr.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'activated', 'warranty_id', v_warr.id, 'name', v_name);
END;
$$;
GRANT EXECUTE ON FUNCTION activate_pending_warranty(text, text, uuid) TO anon, authenticated;


-- 3) auto_log_service_on_booking_complete (v80) — the product whose interval
--    applies is the matched warranty's own product_type when one was found,
--    else the completing booking's product (for the brand-new self-reported
--    row about to be inserted). The 275-day self-reported-filter-first
--    offset generalizes to (service interval - filter interval), same idea
--    as the fixed 365-90 before, just per-product now.
CREATE OR REPLACE FUNCTION auto_log_service_on_booking_complete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_warranty_id uuid;
  v_count int;
  v_days int;
  v_type text;
  v_due timestamptz;
  v_performed_on date;
  v_cid uuid;
  v_product text;
  v_filter_days int;
  v_service_days int;
BEGIN
  IF NEW.status NOT IN ('installed', 'completed') THEN RETURN NEW; END IF;
  IF OLD.status IN ('installed', 'completed') THEN RETURN NEW; END IF;

  IF NEW.booking_type NOT IN ('quarterly_service', 'maintenance', 'annual_service') THEN
    RETURN NEW;
  END IF;

  v_performed_on := COALESCE(NEW.installed_at::date, CURRENT_DATE);
  v_type := CASE WHEN NEW.booking_type = 'annual_service' THEN 'service' ELSE 'filter' END;

  v_warranty_id := NEW.warranty_id;
  IF v_warranty_id IS NULL THEN
    SELECT COUNT(*) INTO v_count
    FROM warranties w JOIN customers c ON c.id = w.customer_id
    WHERE c.phone = NEW.customer_phone AND w.status <> 'deactivated';
    IF v_count = 1 THEN
      SELECT w.id INTO v_warranty_id
      FROM warranties w JOIN customers c ON c.id = w.customer_id
      WHERE c.phone = NEW.customer_phone AND w.status <> 'deactivated'
      LIMIT 1;
    END IF;
  ELSE
    v_count := 1;
  END IF;

  -- Resolve which product's intervals apply: the matched warranty's own
  -- product when one exists, else the completing booking's (for the
  -- brand-new self-reported row created below).
  IF v_warranty_id IS NOT NULL THEN
    SELECT product_type INTO v_product FROM warranties WHERE id = v_warranty_id;
  ELSE
    v_product := COALESCE(NEW.product_model, 'Self-reported unit');
  END IF;
  SELECT filter_interval_days, service_interval_days INTO v_filter_days, v_service_days
    FROM product_models WHERE model_name = v_product;
  v_filter_days  := COALESCE(v_filter_days, 90);
  v_service_days := COALESCE(v_service_days, 365);
  v_days := CASE WHEN v_type = 'service' THEN v_service_days ELSE v_filter_days END;

  v_due := COALESCE(NEW.installed_at, now()) + (v_days || ' days')::interval;

  IF v_warranty_id IS NULL AND v_count = 0 THEN
    SELECT id INTO v_cid FROM customers WHERE phone = NEW.customer_phone LIMIT 1;
    IF v_cid IS NULL THEN
      INSERT INTO customers (phone, name) VALUES (NEW.customer_phone, NEW.customer_name)
      RETURNING id INTO v_cid;
    END IF;

    INSERT INTO warranties (
      customer_id, product_type, quantity, status, source, booking_id,
      registration_date, filter_expiry, service_expiry,
      activated_by, activated_at
    ) VALUES (
      v_cid, v_product, 1, 'active', 'self_reported', NEW.id,
      v_performed_on,
      (v_performed_on + (v_filter_days || ' days')::interval),
      (v_performed_on + (CASE WHEN v_type = 'filter' THEN GREATEST(v_service_days - v_filter_days, 0) ELSE v_service_days END || ' days')::interval),
      'system (self-reported)', now()
    )
    RETURNING id INTO v_warranty_id;

    INSERT INTO warranty_service_history (warranty_id, service_type, notes, source, performed_on, performed_by)
    VALUES (
      v_warranty_id, v_type,
      'Self-reported tracking started from booking ' || COALESCE(NEW.booking_reference, NEW.id::text),
      'job', v_performed_on, 'system (booking completed)'
    );

    RETURN NEW;
  END IF;

  IF v_warranty_id IS NULL THEN RETURN NEW; END IF;

  INSERT INTO warranty_service_history (warranty_id, service_type, notes, source, performed_on, performed_by)
  VALUES (
    v_warranty_id, v_type,
    'Auto-logged on completing booking ' || COALESCE(NEW.booking_reference, NEW.id::text),
    'job', v_performed_on, 'system (booking completed)'
  );

  IF v_type = 'filter' THEN
    UPDATE warranties SET filter_expiry = v_due WHERE id = v_warranty_id;
  ELSE
    UPDATE warranties SET service_expiry = v_due WHERE id = v_warranty_id;
  END IF;

  RETURN NEW;
END;
$$;

-- verification:
-- SELECT model_name, filter_interval_days, service_interval_days, warranty_interval_days FROM product_models ORDER BY sort_order;
-- UPDATE product_models SET filter_interval_days = 120 WHERE model_name = '<some product>'; -- then re-run the usual activate_pending_warranty/claim flow and confirm filter_expiry is +120d, not +90d.
