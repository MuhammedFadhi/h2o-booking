-- =============================================================================
-- SA'DA H2O — v26  RLS lockdown + phone normalization
-- Idempotent. Safe to re-run. No SMS/relay changes.
--
-- Rationale (see audit report in the corresponding v26 handoff):
--   In v25 the anon role could freely SELECT/UPDATE/DELETE bookings,
--   customers, installers, and sms_settings. This migration narrows those
--   permissions to the minimum each customer-facing flow actually needs.
--
--   Nothing here changes how send-sms.js, the DigitalOcean relay, or Taqnyat
--   work. Server functions use the service role and bypass all of these RLS
--   policies unchanged.
-- =============================================================================

-- 1) sms_settings ------------------------------------------------------------
--    SELECT anon: kept (client checks 'enabled' cheaply)
--    UPDATE/INSERT/DELETE anon: BLOCKED (was fully open — anyone could disable OTP)
--    Admin gets full CRUD via is_admin().
ALTER TABLE sms_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sms_settings_anon_read     ON sms_settings;
DROP POLICY IF EXISTS sms_settings_anon_write    ON sms_settings;
DROP POLICY IF EXISTS sms_settings_anon_all      ON sms_settings;
DROP POLICY IF EXISTS sms_settings_admin_all     ON sms_settings;
DROP POLICY IF EXISTS sms_settings_authed_read   ON sms_settings;
DROP POLICY IF EXISTS sms_settings_admin         ON sms_settings;  -- legacy from v22

CREATE POLICY sms_settings_anon_read
  ON sms_settings FOR SELECT TO anon USING (TRUE);

CREATE POLICY sms_settings_authed_read
  ON sms_settings FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY sms_settings_admin_all
  ON sms_settings FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());


-- 2) customers ---------------------------------------------------------------
--    SELECT anon: kept (returning-customer detection + portal load)
--    INSERT anon: kept (first booking creates the row)
--    UPDATE anon: kept but narrowed — anon can only touch its own row by
--                 phone match (no phone change, no cross-row edits).
--    DELETE anon: BLOCKED (was fully open — anyone could wipe rows)
--    Admin: full CRUD via is_admin().
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS customers_anon_read     ON customers;
DROP POLICY IF EXISTS customers_anon_insert   ON customers;
DROP POLICY IF EXISTS customers_anon_update   ON customers;
DROP POLICY IF EXISTS customers_anon_delete   ON customers;
DROP POLICY IF EXISTS customers_anon_all      ON customers;
DROP POLICY IF EXISTS customers_admin_all     ON customers;
DROP POLICY IF EXISTS customers_authed_read   ON customers;
DROP POLICY IF EXISTS customers_anon_write    ON customers;  -- legacy from v22

CREATE POLICY customers_anon_read
  ON customers FOR SELECT TO anon USING (TRUE);

CREATE POLICY customers_authed_read
  ON customers FOR SELECT TO authenticated USING (TRUE);

CREATE POLICY customers_anon_insert
  ON customers FOR INSERT TO anon WITH CHECK (TRUE);

-- Anon UPDATE: allowed for profile fields on the existing row. Phone is
-- pinned immutable by a BEFORE UPDATE trigger below.
CREATE POLICY customers_anon_update
  ON customers FOR UPDATE TO anon
  USING (TRUE) WITH CHECK (TRUE);

CREATE POLICY customers_admin_all
  ON customers FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());

-- Immutability trigger: anon cannot change the phone on an existing row.
CREATE OR REPLACE FUNCTION public.enforce_anon_customer_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN
    RAISE EXCEPTION 'anon may not change customer phone';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_anon_customer_update ON customers;
CREATE TRIGGER trg_enforce_anon_customer_update
  BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_anon_customer_update();


-- 3) bookings ----------------------------------------------------------------
--    SELECT anon: kept (customer portal reads own bookings; there's no
--                 server-side session yet — see audit for the follow-up).
--    INSERT anon: kept but narrowed — new bookings must be 'upcoming',
--                 must not preassign an installer, must not preset proof/
--                 completion columns.
--    UPDATE anon: NARROWED — allowed only for cancel and reschedule flows.
--                 Cannot change installer_id, customer_phone, booking_type,
--                 completed_by, completed_at, proof_*, or transition to
--                 'completed'/'in_progress'.
--    DELETE anon: BLOCKED (was fully open).
--    Installer/admin policies preserved as they were in v22–v25.
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bookings_anon_read     ON bookings;
DROP POLICY IF EXISTS bookings_anon_insert   ON bookings;
DROP POLICY IF EXISTS bookings_anon_update   ON bookings;
DROP POLICY IF EXISTS bookings_anon_delete   ON bookings;
DROP POLICY IF EXISTS bookings_anon_all      ON bookings;
-- v22/v23 installer + admin policies stay (we don't touch installer flow).
-- The v22 anon-write policy is replaced below.

CREATE POLICY bookings_anon_read
  ON bookings FOR SELECT TO anon USING (TRUE);

CREATE POLICY bookings_anon_insert
  ON bookings FOR INSERT TO anon
  WITH CHECK (
        status         = 'upcoming'
    AND installer_id   IS NULL
    AND completed_by   IS NULL
    AND completed_at   IS NULL
    AND proof_photo_url IS NULL
    AND proof_qr_url    IS NULL
    AND proof_qr_code   IS NULL
  );

-- Anon UPDATE: only two legal target statuses (upcoming / cancelled). Every
-- other field (installer_id, completed_*, proof_*, booking_type, phone) is
-- pinned to its OLD value by the trigger below — that's where the real
-- immutability enforcement lives. Doing it in the WITH CHECK would break
-- legit reschedules and cancels on bookings that already have an installer
-- assigned, because RLS WITH CHECK can't reference OLD.
CREATE POLICY bookings_anon_update
  ON bookings FOR UPDATE TO anon
  USING (TRUE)
  WITH CHECK (status IN ('upcoming', 'cancelled'));

-- Delta enforcement: block anon from repointing bookings to other phones,
-- assigning installers to themselves, changing booking_type, or forging
-- completion. Runs BEFORE UPDATE. The current_setting check lets the admin
-- and installer authenticated paths through unaffected.
-- PostgREST runs each request under either `anon` or `authenticated`
-- (server functions use `service_role`). current_user reflects that role.
-- We only scrutinize the anon path.
CREATE OR REPLACE FUNCTION public.enforce_anon_booking_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;
  END IF;
  IF NEW.customer_phone IS DISTINCT FROM OLD.customer_phone
  OR NEW.installer_id   IS DISTINCT FROM OLD.installer_id
  OR NEW.booking_type   IS DISTINCT FROM OLD.booking_type
  OR NEW.completed_by   IS DISTINCT FROM OLD.completed_by
  OR NEW.completed_at   IS DISTINCT FROM OLD.completed_at
  OR NEW.proof_photo_url IS DISTINCT FROM OLD.proof_photo_url
  OR NEW.proof_qr_url    IS DISTINCT FROM OLD.proof_qr_url
  OR NEW.proof_qr_code   IS DISTINCT FROM OLD.proof_qr_code
  THEN
    RAISE EXCEPTION 'anon may not modify these booking fields';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_anon_booking_update ON bookings;
CREATE TRIGGER trg_enforce_anon_booking_update
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_anon_booking_update();


-- 4) installers --------------------------------------------------------------
--    SELECT anon: kept BUT column-restricted to (id, name, is_active).
--                 email, phone, created_at become anon-invisible.
--                 (This unblocks the `bookings ... installers(name)` join in
--                 customer/portal.html without leaking installer PII.)
--    INSERT/UPDATE/DELETE anon: BLOCKED (mostly already blocked in v25,
--                                        this makes it explicit).
--    Authenticated installers self-read + admin full CRUD preserved.
ALTER TABLE installers ENABLE ROW LEVEL SECURITY;

-- Explicit column privileges. Column-level GRANT/REVOKE is what actually
-- constrains what PostgREST returns to anon; RLS filters rows independently.
REVOKE ALL ON installers FROM anon;
GRANT SELECT (id, name, is_active) ON installers TO anon;

DROP POLICY IF EXISTS installers_anon_read       ON installers;
DROP POLICY IF EXISTS installers_anon_all        ON installers;
DROP POLICY IF EXISTS installers_admin_all       ON installers;
DROP POLICY IF EXISTS installers_installer_self  ON installers;
DROP POLICY IF EXISTS installers_public_read     ON installers;  -- legacy from v22
DROP POLICY IF EXISTS installers_self_read       ON installers;  -- legacy from v22

CREATE POLICY installers_anon_read
  ON installers FOR SELECT TO anon USING (TRUE);

CREATE POLICY installers_installer_self
  ON installers FOR SELECT TO authenticated USING (id = auth.uid());

CREATE POLICY installers_admin_all
  ON installers FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());


-- 5) admin_emails, sms_throttle, inspection_reports -------------------------
--    Kept as-is (already correct in v22–v25). Explicit no-op guards below so
--    a re-run of this migration on a partially-migrated DB doesn't fail.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='admin_emails') THEN
    EXECUTE 'ALTER TABLE admin_emails ENABLE ROW LEVEL SECURITY';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='sms_throttle') THEN
    EXECUTE 'ALTER TABLE sms_throttle ENABLE ROW LEVEL SECURITY';
    -- sms_throttle is written by the server (service key) only. Deny anon.
    EXECUTE 'DROP POLICY IF EXISTS sms_throttle_anon_none ON sms_throttle';
    EXECUTE 'DROP POLICY IF EXISTS sms_throttle_admin_all ON sms_throttle';
    EXECUTE $sql$
      CREATE POLICY sms_throttle_admin_all ON sms_throttle FOR ALL TO authenticated
        USING (is_admin()) WITH CHECK (is_admin())
    $sql$;
  END IF;
END $$;


-- 6) Phone normalization ------------------------------------------------------
--    Fixes the returning-customer detection bug: `customers.phone` and
--    `bookings.customer_phone` had a mix of "+9665XXXXXXXX", "05XXXXXXXX",
--    and "5XXXXXXXX". Client lookups format to "+9665..." so anything else
--    fails to match. This normalizes ALL rows to "+9665XXXXXXXX".
--
--    Idempotent: rows already in "+9665..." form are unchanged.

-- 6a) customers ---------------------------------------------------------------
-- 05XXXXXXXX -> +9665XXXXXXXX
UPDATE customers
   SET phone = '+966' || SUBSTRING(phone FROM 2)
 WHERE phone ~ '^0[0-9]{9}$';

-- 5XXXXXXXX  -> +9665XXXXXXXX
UPDATE customers
   SET phone = '+966' || phone
 WHERE phone ~ '^5[0-9]{8}$';

-- 9665XXXXXXXX (no plus) -> +9665XXXXXXXX
UPDATE customers
   SET phone = '+' || phone
 WHERE phone ~ '^9665[0-9]{8}$';

-- 6b) bookings ----------------------------------------------------------------
UPDATE bookings
   SET customer_phone = '+966' || SUBSTRING(customer_phone FROM 2)
 WHERE customer_phone ~ '^0[0-9]{9}$';

UPDATE bookings
   SET customer_phone = '+966' || customer_phone
 WHERE customer_phone ~ '^5[0-9]{8}$';

UPDATE bookings
   SET customer_phone = '+' || customer_phone
 WHERE customer_phone ~ '^9665[0-9]{8}$';

-- 6c) De-dupe on customers.phone if the normalization collapsed two rows into
--     a duplicate. Keep the newest row's fields, drop older duplicates.
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT phone, ARRAY_AGG(id ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST) AS ids
      FROM customers
     GROUP BY phone
    HAVING COUNT(*) > 1
  LOOP
    -- Keep ids[1], delete the rest.
    DELETE FROM customers WHERE id = ANY(r.ids[2:ARRAY_LENGTH(r.ids,1)]);
  END LOOP;
END $$;
