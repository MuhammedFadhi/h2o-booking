-- ============================================================
-- SA'DA H2O — v22 migration
-- 1) booking_type column (installation | maintenance | repair | relocation)
-- 2) 48-hour lead-time DB check (customer-side enforcement)
-- 3) sms_settings + customers tables (idempotent)
-- 4) proof + reschedule columns (idempotent)
-- 5) helpful indexes
-- Safe to re-run.
-- ============================================================

-- 1) bookings.booking_type + relax legacy NOT NULL
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS booking_type VARCHAR(32) DEFAULT 'installation';
ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_booking_type_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_booking_type_check
  CHECK (booking_type IN ('installation','maintenance','repair','relocation'));
-- customer_email is optional now (SMS is primary contact)
ALTER TABLE bookings ALTER COLUMN customer_email DROP NOT NULL;

-- 4) Proof + reschedule + audit columns
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_photo_url TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_qr_url   TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_qr_code  VARCHAR(120);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_by   VARCHAR(20);
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at   TIMESTAMPTZ;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;

-- 2) 48-hour lead time — enforced via trigger. Service role is exempt
--    so admin can back-date bookings if needed.
CREATE OR REPLACE FUNCTION enforce_booking_lead_time()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role TEXT;
BEGIN
  -- Best-effort role detection (empty during pg_cron/service_role bypass)
  BEGIN
    jwt_role := coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true));
  EXCEPTION WHEN OTHERS THEN
    jwt_role := NULL;
  END;

  -- Only enforce on customer (anon) or logged-in customer (authenticated)
  IF jwt_role IN ('anon', 'authenticated') THEN
    IF NEW.slot_date < (CURRENT_DATE + INTERVAL '2 days')::date THEN
      RAISE EXCEPTION 'Bookings require at least 2 days lead time (earliest: %).', (CURRENT_DATE + INTERVAL '2 days')::date;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_bookings_lead_time ON bookings;
CREATE TRIGGER trg_bookings_lead_time
  BEFORE INSERT ON bookings
  FOR EACH ROW EXECUTE FUNCTION enforce_booking_lead_time();

-- 3) SMS settings table
CREATE TABLE IF NOT EXISTS sms_settings (
  key         VARCHAR(48) PRIMARY KEY,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Seed defaults (idempotent)
INSERT INTO sms_settings(key, enabled) VALUES
  ('otp', TRUE), ('confirmation', TRUE), ('booking_link', TRUE),
  ('installer_assigned', TRUE), ('cancellation', TRUE),
  ('reschedule', TRUE), ('reopen', TRUE), ('completion', TRUE),
  ('reminder', TRUE), ('service_due', TRUE)
ON CONFLICT (key) DO NOTHING;

-- 3b) Customers table
CREATE TABLE IF NOT EXISTS customers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  phone       VARCHAR(20) UNIQUE NOT NULL,
  name        VARCHAR(120),
  city        VARCHAR(100),
  address     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "customers open" ON customers;
CREATE POLICY "customers open" ON customers FOR ALL USING (true) WITH CHECK (true);



-- 5) Indexes
CREATE INDEX IF NOT EXISTS idx_bookings_phone     ON bookings(customer_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_type      ON bookings(booking_type);
CREATE INDEX IF NOT EXISTS idx_customers_phone    ON customers(phone);

-- 5b) RLS policies to unblock v22 client flows
-- WHY: v21 base schema only defines INSERT for bookings and SELECT for
-- available slots. Without the additions below, real-time subscriptions,
-- customer portal "My Bookings", slot reservation, and installer login
-- name lookup all silently fail (0 rows returned).
-- These policies are permissive — clients still filter by phone/id, but
-- an attacker with the anon key CAN enumerate. Same tradeoff as v21.
-- If you want to tighten later, add row-scoped policies keyed off
-- request.jwt.claims after moving customer/installer flows behind
-- signed sessions.

-- Bookings: SELECT (needed by customer portal + real-time on admin/installer)
DROP POLICY IF EXISTS "bookings select all" ON bookings;
CREATE POLICY "bookings select all" ON bookings FOR SELECT USING (true);

-- Bookings: UPDATE (needed by customer cancel/reschedule + installer complete)
DROP POLICY IF EXISTS "bookings update all" ON bookings;
CREATE POLICY "bookings update all" ON bookings FOR UPDATE USING (true) WITH CHECK (true);

-- Availability slots: UPDATE (needed by customer slot reservation)
DROP POLICY IF EXISTS "slots update all" ON availability_slots;
CREATE POLICY "slots update all" ON availability_slots FOR UPDATE USING (true) WITH CHECK (true);

-- Installers: SELECT (installer portal reads own row for display name)
DROP POLICY IF EXISTS "installers select authenticated" ON installers;
CREATE POLICY "installers select authenticated" ON installers
  FOR SELECT TO authenticated USING (true);

-- SMS settings: no anon access at all (service role only via bypass)
ALTER TABLE sms_settings ENABLE ROW LEVEL SECURITY;

-- 6) Slot constraint alignment (idempotent).
-- v21 dropped UNIQUE(city_id, slot_date, slot_hour) → UNIQUE(slot_date, slot_hour)
-- and made city_id nullable. If your DB already has this, these commands are no-ops.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'availability_slots'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) LIKE '%city_id%slot_date%slot_hour%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE availability_slots DROP CONSTRAINT ' || conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'availability_slots'
        AND c.contype = 'u'
        AND pg_get_constraintdef(c.oid) LIKE '%city_id%slot_date%slot_hour%'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE availability_slots ALTER COLUMN city_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'availability_slots'
      AND c.contype = 'u'
      AND pg_get_constraintdef(c.oid) = 'UNIQUE (slot_date, slot_hour)'
  ) THEN
    ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_date_hour_key UNIQUE (slot_date, slot_hour);
  END IF;
END $$;

-- Storage bucket for installation proofs (installer complete flow)
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('installation-proofs', 'installation-proofs', true, 10485760)
ON CONFLICT (id) DO NOTHING;

-- Authenticated (installer) can upload
DROP POLICY IF EXISTS "installers upload proofs" ON storage.objects;
CREATE POLICY "installers upload proofs" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'installation-proofs');

-- Authenticated (installer) can overwrite own uploads
DROP POLICY IF EXISTS "installers update proofs" ON storage.objects;
CREATE POLICY "installers update proofs" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'installation-proofs');

-- Public can read (needed for public URLs used in admin/installer/customer views)
DROP POLICY IF EXISTS "proofs public read" ON storage.objects;
CREATE POLICY "proofs public read" ON storage.objects
  FOR SELECT USING (bucket_id = 'installation-proofs');
