-- =============================================================================
-- SA'DA H2O — v22 self-contained migration
-- Works from a fresh Supabase project OR on top of an existing v21 database.
-- Every block is guarded with IF NOT EXISTS / DO $$ ... $$ so re-running is safe.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─────────────────────────────────────────────────────────────────────────────
-- 0) BASE TABLES (from v21 supabase_schema.sql — idempotent)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  name_ar VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed cities only if the table is empty (don't duplicate)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cities LIMIT 1) THEN
    INSERT INTO cities (name, name_ar) VALUES
      ('Dammam', 'الدمام'),
      ('Al Khobar', 'الخبر'),
      ('Dhahran', 'الظهران'),
      ('Jubail', 'الجبيل'),
      ('Qatif', 'القطيف'),
      ('Hafar Al-Batin', 'حفر الباطن'),
      ('Ras Tanura', 'رأس تنورة'),
      ('Abqaiq', 'بقيق'),
      ('Al Ahsa', 'الأحساء'),
      ('Safwa', 'صفوى');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS installers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS availability_slots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
  slot_date DATE NOT NULL,
  slot_hour INTEGER NOT NULL CHECK (slot_hour >= 0 AND slot_hour <= 23),
  is_available BOOLEAN DEFAULT TRUE,
  is_booked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_name VARCHAR(100) NOT NULL,
  customer_email VARCHAR(255),
  customer_phone VARCHAR(20) NOT NULL,
  city_id UUID REFERENCES cities(id),
  city_name VARCHAR(100),
  latitude DECIMAL(10, 8),
  longitude DECIMAL(11, 8),
  location_address TEXT,
  slot_id UUID REFERENCES availability_slots(id),
  slot_date DATE NOT NULL,
  slot_hour INTEGER NOT NULL,
  installer_id UUID REFERENCES installers(id),
  status VARCHAR(50) DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'in_progress', 'completed', 'cancelled')),
  booking_reference VARCHAR(20) UNIQUE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_availability_slots_city_date ON availability_slots(city_id, slot_date);
CREATE INDEX IF NOT EXISTS idx_availability_slots_date_hour ON availability_slots(slot_date, slot_hour);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id);
CREATE INDEX IF NOT EXISTS idx_bookings_installer ON bookings(installer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(slot_date);
CREATE INDEX IF NOT EXISTS idx_bookings_phone ON bookings(customer_phone);

-- booking_reference trigger (from v21)
CREATE OR REPLACE FUNCTION generate_booking_reference()
RETURNS TRIGGER AS $$
BEGIN
  NEW.booking_reference := 'SW-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(NEW.id::TEXT, 1, 6));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_booking_reference ON bookings;
CREATE TRIGGER set_booking_reference
BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();

-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ADMIN EMAIL ALLOWLIST + is_admin() function
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_emails (
  email text PRIMARY KEY,
  created_at timestamptz DEFAULT now()
);
INSERT INTO admin_emails (email) VALUES ('yasircp123@gmail.com')
ON CONFLICT (email) DO NOTHING;
ALTER TABLE admin_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_emails_self ON admin_emails;
CREATE POLICY admin_emails_self ON admin_emails FOR SELECT TO authenticated
  USING (email = auth.jwt() ->> 'email');

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_emails WHERE email = auth.jwt() ->> 'email'
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) MISSING COLUMNS on bookings (safe on fresh install too)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booking_type text
  CHECK (booking_type IN ('installation','maintenance','repair','relocation'));
UPDATE bookings SET booking_type = 'installation' WHERE booking_type IS NULL;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_by text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS rescheduled_at timestamptz;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_photo_url text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_qr_url text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS proof_qr_code text;

-- customer_email optional (v21 had NOT NULL; new flow allows empty)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'bookings' AND column_name = 'customer_email' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE bookings ALTER COLUMN customer_email DROP NOT NULL;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3) SUPPORTING TABLES: customers, sms_settings, sms_throttle
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS customers (
  phone text PRIMARY KEY,
  name text,
  city text,
  address text,
  latitude numeric(10,8),
  longitude numeric(11,8),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS sms_settings (
  key text PRIMARY KEY,
  enabled boolean DEFAULT true,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO sms_settings (key, enabled) VALUES
  ('otp', true), ('confirmation', true), ('booking_link', true),
  ('installer_assigned', true), ('cancellation', true), ('reschedule', true),
  ('reopen', true), ('completion', true), ('reminder', true), ('service_due', true)
ON CONFLICT (key) DO NOTHING;
ALTER TABLE sms_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS sms_throttle (
  phone text PRIMARY KEY,
  send_count int DEFAULT 0,
  last_send_at timestamptz DEFAULT now(),
  window_start timestamptz DEFAULT now()
);
ALTER TABLE sms_throttle ENABLE ROW LEVEL SECURITY;
-- No policies on sms_throttle — service role from the SMS relay only.

-- ─────────────────────────────────────────────────────────────────────────────
-- 4) RLS POLICIES
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE installers ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- CITIES: public read, admin write
DROP POLICY IF EXISTS cities_public_read ON cities;
CREATE POLICY cities_public_read ON cities FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS cities_admin_write ON cities;
CREATE POLICY cities_admin_write ON cities FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- INSTALLERS
DROP POLICY IF EXISTS installers_admin_all ON installers;
CREATE POLICY installers_admin_all ON installers FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS installers_self_read ON installers;
CREATE POLICY installers_self_read ON installers FOR SELECT TO authenticated USING (id = auth.uid());
DROP POLICY IF EXISTS installers_public_read ON installers;
CREATE POLICY installers_public_read ON installers FOR SELECT TO anon USING (true);

-- AVAILABILITY SLOTS
DROP POLICY IF EXISTS slots_public_read ON availability_slots;
CREATE POLICY slots_public_read ON availability_slots FOR SELECT TO anon, authenticated USING (is_available = true);
DROP POLICY IF EXISTS slots_admin_all ON availability_slots;
CREATE POLICY slots_admin_all ON availability_slots FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS slots_anon_book ON availability_slots;
CREATE POLICY slots_anon_book ON availability_slots FOR UPDATE TO anon
  USING (is_available = true)
  WITH CHECK (is_available = true);

-- BOOKINGS
DROP POLICY IF EXISTS "Anyone can create a booking" ON bookings;  -- clean up v21 policy name
DROP POLICY IF EXISTS bookings_anon_insert ON bookings;
CREATE POLICY bookings_anon_insert ON bookings FOR INSERT TO anon WITH CHECK (true);
DROP POLICY IF EXISTS bookings_anon_read ON bookings;
CREATE POLICY bookings_anon_read ON bookings FOR SELECT TO anon USING (true);
DROP POLICY IF EXISTS bookings_anon_update ON bookings;
CREATE POLICY bookings_anon_update ON bookings FOR UPDATE TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS bookings_admin_all ON bookings;
CREATE POLICY bookings_admin_all ON bookings FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
DROP POLICY IF EXISTS bookings_installer_read ON bookings;
CREATE POLICY bookings_installer_read ON bookings FOR SELECT TO authenticated USING (installer_id = auth.uid());
DROP POLICY IF EXISTS bookings_installer_update ON bookings;
CREATE POLICY bookings_installer_update ON bookings FOR UPDATE TO authenticated USING (installer_id = auth.uid()) WITH CHECK (installer_id = auth.uid());

-- CUSTOMERS
DROP POLICY IF EXISTS customers_anon_write ON customers;
CREATE POLICY customers_anon_write ON customers FOR ALL TO anon USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS customers_admin_all ON customers;
CREATE POLICY customers_admin_all ON customers FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- SMS_SETTINGS
DROP POLICY IF EXISTS sms_settings_admin ON sms_settings;
CREATE POLICY sms_settings_admin ON sms_settings FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- ─────────────────────────────────────────────────────────────────────────────
-- 5) STORAGE bucket for installer proof photos
-- ─────────────────────────────────────────────────────────────────────────────

INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('installation-proofs', 'installation-proofs', true, 10485760)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit;

DROP POLICY IF EXISTS "proofs read"   ON storage.objects;
DROP POLICY IF EXISTS "proofs write"  ON storage.objects;
DROP POLICY IF EXISTS "proofs update" ON storage.objects;
CREATE POLICY "proofs read"   ON storage.objects FOR SELECT TO anon, authenticated USING (bucket_id = 'installation-proofs');
CREATE POLICY "proofs write"  ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'installation-proofs');
CREATE POLICY "proofs update" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'installation-proofs') WITH CHECK (bucket_id = 'installation-proofs');

-- ─────────────────────────────────────────────────────────────────────────────
-- 6) availability_slots constraint alignment
--    v21 used UNIQUE(city_id, slot_date, slot_hour); v22 uses UNIQUE(slot_date, slot_hour)
--    because slots are city-agnostic in the current admin dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE cn text;
BEGIN
  -- Drop the composite that includes city_id if it exists
  SELECT c.conname INTO cn FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'availability_slots'
     AND c.contype = 'u'
     AND pg_get_constraintdef(c.oid) LIKE '%city_id%slot_date%slot_hour%';
  IF cn IS NOT NULL THEN
    EXECUTE 'ALTER TABLE availability_slots DROP CONSTRAINT ' || quote_ident(cn);
  END IF;

  -- Add UNIQUE(slot_date, slot_hour) if missing
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

-- Make city_id nullable (admin creates slots without a city)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'availability_slots' AND column_name = 'city_id' AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE availability_slots ALTER COLUMN city_id DROP NOT NULL;
  END IF;
END $$;

-- Done.
