-- =============================================================================
-- SA'DA H2O — v75  Auto-update filter/service due dates on booking completion
--
-- Until now, completing a Filter Change or Annual Service booking never
-- touched the warranty's filter_expiry/service_expiry at all — admin had to
-- separately remember to open Services and log a "+Job Order" by hand.
--
-- Two pieces:
--   1. bookings.warranty_id — a real, structured link to which unit a
--      booking is for (both the customer portal's and admin's "which
--      unit?" pickers previously only saved this as free text).
--   2. A trigger on bookings: the moment status first reaches
--      installed/completed for a quarterly_service/maintenance (Filter
--      Change) or annual_service booking, it resolves the target warranty
--      (booking.warranty_id if set, else the customer's sole warranty if
--      unambiguous, else skipped — never guessed) and logs the same kind
--      of warranty_service_history row + expiry push the manual Job Order
--      button already does.
--
-- Deliberately does NOT fire for 'repair' — a repair visit doesn't
-- necessarily mean the filter was replaced, so that stays a manual admin
-- call via Job Order, same as today.
--
-- source stays within warranty_service_history's existing CHECK
-- ('job'|'manual'|'import') — reusing 'job' rather than widening that
-- constraint for a new 'auto' value; the auto-generated note text is what
-- makes an auto-logged entry distinguishable from a manual one.
--
-- Idempotent. Run AFTER v65 (warranty_service_history.source) and v37
-- (bookings.installed_at).
-- =============================================================================

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS warranty_id uuid REFERENCES warranties(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION auto_log_service_on_booking_complete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_warranty_id uuid;
  v_count int;
  v_days int;
  v_type text;
  v_due timestamptz;
  v_performed_on date;
BEGIN
  -- Fire exactly once: the moment status first reaches the "done" set, not
  -- on every later move between installed <-> completed (e.g. once invoiced).
  IF NEW.status NOT IN ('installed', 'completed') THEN RETURN NEW; END IF;
  IF OLD.status IN ('installed', 'completed') THEN RETURN NEW; END IF;

  IF NEW.booking_type NOT IN ('quarterly_service', 'maintenance', 'annual_service') THEN
    RETURN NEW;
  END IF;

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
  END IF;

  IF v_warranty_id IS NULL THEN RETURN NEW; END IF;

  IF NEW.booking_type = 'annual_service' THEN
    v_type := 'service'; v_days := 365;
  ELSE
    v_type := 'filter'; v_days := 90;
  END IF;

  v_performed_on := COALESCE(NEW.installed_at::date, CURRENT_DATE);
  v_due := COALESCE(NEW.installed_at, now()) + (v_days || ' days')::interval;

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

DROP TRIGGER IF EXISTS trg_auto_log_service_on_complete ON bookings;
CREATE TRIGGER trg_auto_log_service_on_complete
AFTER UPDATE OF status ON bookings
FOR EACH ROW
EXECUTE FUNCTION auto_log_service_on_booking_complete();

-- verification:
-- SELECT booking_reference, booking_type, status, warranty_id FROM bookings WHERE booking_type IN ('quarterly_service','annual_service') ORDER BY created_at DESC LIMIT 10;
-- SELECT * FROM warranty_service_history WHERE performed_by = 'system (booking completed)' ORDER BY created_at DESC LIMIT 10;
