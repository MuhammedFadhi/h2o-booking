-- v99: An Annual Service visit replaces the filter too, in practice.
--
-- auto_log_service_on_booking_complete() only ever pushed service_expiry
-- forward for an annual_service booking, leaving filter_expiry completely
-- untouched — as if the filter hadn't been touched during that visit. In
-- reality, an Annual Service visit includes a filter replacement, so both
-- dates (and both service-history entries) should reflect that.
--
-- A plain Filter Change booking still only touches filter_expiry — this is
-- one-directional, matching the real-world asymmetry (a filter change on
-- its own isn't a full annual service).

CREATE OR REPLACE FUNCTION auto_log_service_on_booking_complete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_warranty_id uuid;
  v_count int;
  v_days int;
  v_type text;
  v_due timestamptz;
  v_due_filter timestamptz;
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
  v_due_filter := COALESCE(NEW.installed_at, now()) + (v_filter_days || ' days')::interval;

  IF v_warranty_id IS NULL AND v_count = 0 THEN
    SELECT id INTO v_cid FROM customers WHERE phone = NEW.customer_phone LIMIT 1;
    IF v_cid IS NULL THEN
      INSERT INTO customers (phone, name) VALUES (NEW.customer_phone, NEW.customer_name)
      RETURNING id INTO v_cid;
    END IF;

    -- Already sets both dates fresh regardless of which visit type started
    -- tracking (unchanged from before) — a brand-new row has no prior
    -- filter_expiry to leave untouched either way.
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
    IF v_type = 'service' THEN
      INSERT INTO warranty_service_history (warranty_id, service_type, notes, source, performed_on, performed_by)
      VALUES (
        v_warranty_id, 'filter',
        'Filter replaced as part of the Annual Service visit on booking ' || COALESCE(NEW.booking_reference, NEW.id::text),
        'job', v_performed_on, 'system (booking completed)'
      );
    END IF;

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
    UPDATE warranties SET service_expiry = v_due, filter_expiry = v_due_filter WHERE id = v_warranty_id;
    INSERT INTO warranty_service_history (warranty_id, service_type, notes, source, performed_on, performed_by)
    VALUES (
      v_warranty_id, 'filter',
      'Filter replaced as part of the Annual Service visit on booking ' || COALESCE(NEW.booking_reference, NEW.id::text),
      'job', v_performed_on, 'system (booking completed)'
    );
  END IF;

  RETURN NEW;
END;
$$;

-- verification:
-- Complete an annual_service booking for a registered unit and confirm BOTH
-- filter_expiry and service_expiry moved, and warranty_service_history has
-- two new rows (service + filter) for it, not just one.
