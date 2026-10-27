-- =============================================================================
-- SA'DA H2O — v88  Offset Annual Service when self-reported tracking starts
--                   from a Filter Change, not an Annual Service visit
--
-- v87 started a self-reported row with BOTH gauges fresh from the visit
-- date (filter +90d, service +365d) regardless of which visit type
-- triggered it. For a customer whose first-ever contact is a Filter
-- Change, a fresh 365-day Annual Service countdown overstates how new the
-- unit's yearly cycle actually is — a filter visit implies the unit has
-- already been in service a while. When the triggering visit is a Filter
-- Change, Annual Service now starts at 275 days (365-90) instead of a
-- full 365. A first visit that IS an Annual Service still gets a full
-- fresh 365/90 on both, unchanged.
--
-- Idempotent. Run AFTER v87.
-- =============================================================================

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
BEGIN
  -- Fire exactly once: the moment status first reaches the "done" set, not
  -- on every later move between installed <-> completed (e.g. once invoiced).
  IF NEW.status NOT IN ('installed', 'completed') THEN RETURN NEW; END IF;
  IF OLD.status IN ('installed', 'completed') THEN RETURN NEW; END IF;

  IF NEW.booking_type NOT IN ('quarterly_service', 'maintenance', 'annual_service') THEN
    RETURN NEW;
  END IF;

  v_performed_on := COALESCE(NEW.installed_at::date, CURRENT_DATE);
  IF NEW.booking_type = 'annual_service' THEN
    v_type := 'service'; v_days := 365;
  ELSE
    v_type := 'filter'; v_days := 90;
  END IF;
  v_due := COALESCE(NEW.installed_at, now()) + (v_days || ' days')::interval;

  v_warranty_id := NEW.warranty_id;
  IF v_warranty_id IS NULL THEN
    -- Only auto-resolve when it's unambiguous — a customer with 2+ units
    -- and no explicit pick is left for admin to log manually, same as today.
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
    v_count := 1; -- explicit link — no ambiguity to resolve
  END IF;

  IF v_warranty_id IS NULL AND v_count = 0 THEN
    -- Genuinely nothing on file for this customer — their first-ever SA'DA
    -- visit. Start self-reported tracking instead of doing nothing.
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
      v_cid, COALESCE(NEW.product_model, 'Self-reported unit'), 1, 'active', 'self_reported', NEW.id,
      v_performed_on,
      (v_performed_on + INTERVAL '90 days'),
      -- A Filter Change as the first-ever visit implies the unit isn't
      -- brand new to its yearly cycle — start Annual Service at 275 days
      -- (365-90) instead of a fresh 365. A first visit that's already an
      -- Annual Service gets the full 365, same as before.
      (v_performed_on + (CASE WHEN v_type = 'filter' THEN INTERVAL '275 days' ELSE INTERVAL '365 days' END)),
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

-- Trigger itself is unchanged — CREATE OR REPLACE above is enough.

-- verification:
-- SELECT product_type, registration_date, filter_expiry, service_expiry FROM warranties WHERE source = 'self_reported' ORDER BY created_at DESC LIMIT 10;
