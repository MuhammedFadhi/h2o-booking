-- v96: Per-unit Filter Change interval override.
--
-- v94 made the filter interval per-PRODUCT. Real-world usage varies per
-- UNIT of the same product though — the same RO system filters out much
-- faster in a hotel (heavy daily use) than in a home, even side by side.
-- warranties.filter_interval_override_days lets admin set a different
-- cadence for one specific unit; NULL (the default for every existing row)
-- means "follow the product's own interval", unchanged from before.
--
-- Only auto_log_service_on_booking_complete() needs updating — that's the
-- one write path that recomputes filter_expiry on an EXISTING warranty
-- (a Filter Change job completing). The other two trigger functions only
-- ever run at a warranty's creation/first-activation, before any
-- unit-specific override could exist yet.

ALTER TABLE warranties ADD COLUMN IF NOT EXISTS filter_interval_override_days int;

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
  v_filter_override int;
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

  IF v_warranty_id IS NOT NULL THEN
    SELECT product_type, filter_interval_override_days INTO v_product, v_filter_override
      FROM warranties WHERE id = v_warranty_id;
  ELSE
    v_product := COALESCE(NEW.product_model, 'Self-reported unit');
    v_filter_override := NULL;
  END IF;
  SELECT filter_interval_days, service_interval_days INTO v_filter_days, v_service_days
    FROM product_models WHERE model_name = v_product;
  v_filter_days  := COALESCE(v_filter_override, v_filter_days, 90);
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

-- shift_warranty_dates_for_product (v95) — a product-wide interval edit in
-- the Products panel should NOT sweep up a unit that was deliberately given
-- its own override; only its service_expiry/warranty_expiry still follow
-- the product-wide cascade.
CREATE OR REPLACE FUNCTION shift_warranty_dates_for_product(
  p_product_type text, p_filter_delta int, p_service_delta int, p_warranty_delta int
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE warranties
  SET filter_expiry   = CASE WHEN p_filter_delta   <> 0 AND filter_expiry   IS NOT NULL AND filter_interval_override_days IS NULL THEN filter_expiry   + (p_filter_delta   || ' days')::interval ELSE filter_expiry   END,
      service_expiry  = CASE WHEN p_service_delta  <> 0 AND service_expiry  IS NOT NULL THEN service_expiry  + (p_service_delta  || ' days')::interval ELSE service_expiry  END,
      warranty_expiry = CASE WHEN p_warranty_delta <> 0 AND warranty_expiry IS NOT NULL THEN warranty_expiry + (p_warranty_delta || ' days')::interval ELSE warranty_expiry END
  WHERE product_type = p_product_type;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION shift_warranty_dates_for_product(text, int, int, int) TO authenticated;

-- verification:
-- UPDATE warranties SET filter_interval_override_days = 30 WHERE qr_code = '<some serial>';
--   -> that unit's next Filter Change job completion should push filter_expiry
--      by 30 days, not the product's own filter_interval_days.
