-- =============================================================================
-- SA'DA H2O — v79  Start self-reported tracking on a customer's first visit
--
-- The schema/RLS for "self-reported" tracking (a warranty-shaped row for a
-- customer whose only relationship with us is a standalone service visit —
-- e.g. a Filter Change on a non-SA'DA or unregistered unit, booked via the
-- "Book a Filter Change" shortcut on My Unit) has existed since v65/v66/v68.
-- customer/portal.html and js/warranty.js already know how to DISPLAY a
-- source='self_reported' row (My Unit's "SERVICE TRACKING" badge, "First
-- serviced by SA'DA" instead of "Installed", etc.) — but nothing anywhere
-- in the codebase ever actually CREATED one. A customer with zero
-- registered units who completed a Filter Change just vanished into
-- v75's "no warranty to resolve, skip" branch, so My Unit stayed stuck on
-- "No units registered yet" forever, even after a real completed visit.
--
-- Extends auto_log_service_on_booking_complete() (v75/v78's trigger): when
-- it can't resolve ANY existing warranty for this customer (not an
-- ambiguous multi-unit case — genuinely zero), it now starts a new
-- source='self_reported' row instead of giving up, seeded from this
-- visit's completion date (both filter_expiry +90d and service_expiry
-- +365d set together, same as a real unit's first activation), then logs
-- the triggering visit into warranty_service_history same as before.
--
-- A customer with 2+ EXISTING units and no explicit booking.warranty_id
-- pick is still left alone, same as always — only a genuine first-ever
-- visit (zero warranties on file) starts a new self-reported row.
--
-- Idempotent. Run AFTER v78.
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
      (v_performed_on + INTERVAL '365 days'),
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

-- Trigger itself is unchanged (still AFTER UPDATE OF status, still calls
-- this function) — CREATE OR REPLACE above is enough, no need to touch it.

-- verification:
-- SELECT * FROM warranties WHERE source = 'self_reported' ORDER BY created_at DESC LIMIT 10;
