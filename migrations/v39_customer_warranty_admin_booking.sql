-- =============================================================================
-- SA'DA H2O — v39  Customer-driven warranty · Admin booking · Phone change
--
--   1. Warranty status gains 'pending' (installer photo creates a pending warranty
--      per RO unit; the CUSTOMER's QR scan attaches the serial + activates it).
--   2. Bookings gain admin-authorship + location-correction fields.
--   3. RPC: activate_pending_warranty(phone, serial) — customer self-activation,
--      matches by phone to any installed/completed booking, stamps the oldest
--      pending warranty with the serial + customer, sets it active, pulls the name.
--   4. RPC: change_customer_phone(old, new) — repoints every table so a phone
--      edit propagates everywhere (identity key).
--   5. Backfill: the one legacy nameless warranty's name from its booking.
--
-- Idempotent. Run AFTER v38.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. WARRANTY STATUS: allow 'pending'
--    (constraint name may vary; drop-if-exists then recreate with full set)
-- ---------------------------------------------------------------------------
ALTER TABLE warranties DROP CONSTRAINT IF EXISTS warranties_status_check;
ALTER TABLE warranties ADD CONSTRAINT warranties_status_check
  CHECK (status IN ('pending','active','paused','deactivated','expired'));

-- qr_code must be nullable for a pending warranty (serial not known until scan).
ALTER TABLE warranties ALTER COLUMN qr_code DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. BOOKINGS: admin authorship + location correction
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_by          text;  -- 'customer' | 'admin'
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_updated_by text;  -- 'installer' when corrected on-site
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS location_updated_at timestamptz;
-- default existing rows to customer-created (they were)
UPDATE bookings SET created_by = 'customer' WHERE created_by IS NULL;

-- ---------------------------------------------------------------------------
-- 3. CUSTOMER SELF-ACTIVATION RPC
--    Match by phone → require an installed/completed booking → stamp the oldest
--    pending warranty for that customer with the scanned serial + activate.
--    Returns a small JSON status the claim page can branch on.
--    SECURITY DEFINER so the anon (public) claim page can run it under controlled logic.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION activate_pending_warranty(p_phone text, p_serial text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_cid uuid;
  v_name text;
  v_has_booking boolean;
  v_warr warranties%ROWTYPE;
  v_clash uuid;
BEGIN
  IF p_phone IS NULL OR btrim(p_phone) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_phone');
  END IF;

  -- Serial already registered? (idempotent re-scan of the same unit)
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

  -- Must have at least one installed/completed booking (proof they're a real install).
  SELECT EXISTS(
    SELECT 1 FROM bookings
    WHERE customer_phone = p_phone AND status IN ('installed','completed')
  ) INTO v_has_booking;
  IF NOT v_has_booking THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_booking');
  END IF;

  -- Grab the oldest pending warranty for this customer (one per unit; scan each QR to activate each).
  SELECT * INTO v_warr FROM warranties
   WHERE customer_id = v_cid AND status = 'pending'
   ORDER BY created_at ASC LIMIT 1;

  IF v_warr.id IS NULL THEN
    -- No pending warranty. Either already all-activated, or the install didn't
    -- create one. Create one now on the fly so the customer is never stuck.
    INSERT INTO warranties (customer_id, qr_code, product_type, status, registration_date, activated_by, activated_at)
    VALUES (v_cid, p_serial, 'RO', 'active', CURRENT_DATE, 'customer (scan)', now())
    RETURNING * INTO v_warr;
    RETURN jsonb_build_object('ok', true, 'reason', 'activated_new', 'warranty_id', v_warr.id, 'name', v_name);
  END IF;

  -- Activate the pending one with the scanned serial.
  UPDATE warranties
     SET qr_code = COALESCE(p_serial, qr_code),
         status = 'active',
         registration_date = CURRENT_DATE,
         activated_by = 'customer (scan)',
         activated_at = now()
   WHERE id = v_warr.id;

  RETURN jsonb_build_object('ok', true, 'reason', 'activated', 'warranty_id', v_warr.id, 'name', v_name);
END;
$$;
GRANT EXECUTE ON FUNCTION activate_pending_warranty(text, text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. CHANGE PHONE RPC — propagate a phone edit across every table.
--    Admin-only in practice (authenticated), but SECURITY DEFINER to update all
--    tables consistently in one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION change_customer_phone(p_old text, p_new text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_exists uuid;
BEGIN
  IF p_new IS NULL OR btrim(p_new) = '' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_new');
  END IF;
  IF p_old = p_new THEN
    RETURN jsonb_build_object('ok', true, 'reason', 'unchanged');
  END IF;
  -- If the new phone already belongs to a DIFFERENT customer, refuse (would merge identities).
  SELECT id INTO v_exists FROM customers WHERE phone = p_new LIMIT 1;
  IF v_exists IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'new_phone_in_use');
  END IF;

  UPDATE customers          SET phone = p_new WHERE phone = p_old;
  UPDATE bookings           SET customer_phone = p_new WHERE customer_phone = p_old;
  UPDATE invoices           SET customer_phone = p_new WHERE customer_phone = p_old;
  -- inspection_reports + followups reference phone too, if present
  BEGIN
    UPDATE inspection_reports SET customer_phone = p_new WHERE customer_phone = p_old;
  EXCEPTION WHEN undefined_table OR undefined_column THEN NULL; END;

  RETURN jsonb_build_object('ok', true, 'reason', 'changed');
END;
$$;
GRANT EXECUTE ON FUNCTION change_customer_phone(text, text) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. BACKFILL the one legacy nameless warranty from its booking (best-effort).
-- ---------------------------------------------------------------------------
UPDATE customers c
SET name = b.customer_name
FROM bookings b
WHERE b.customer_phone = c.phone
  AND (c.name IS NULL OR btrim(c.name) = '')
  AND b.customer_name IS NOT NULL AND btrim(b.customer_name) <> '';

-- verification (run separately):
-- SELECT status, count(*) FROM warranties GROUP BY status;
-- SELECT proname FROM pg_proc WHERE proname IN ('activate_pending_warranty','change_customer_phone');
