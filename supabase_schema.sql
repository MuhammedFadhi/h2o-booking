-- ============================================================
-- SADA Water - Supabase Database Schema
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- CITIES TABLE
-- ============================================================
CREATE TABLE cities (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  name_ar VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

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

-- ============================================================
-- INSTALLERS TABLE
-- ============================================================
CREATE TABLE installers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================
-- AVAILABILITY SLOTS TABLE
-- Admin creates these to control what customers can book
-- ============================================================
CREATE TABLE availability_slots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  city_id UUID REFERENCES cities(id) ON DELETE CASCADE,
  slot_date DATE NOT NULL,
  slot_hour INTEGER NOT NULL CHECK (slot_hour >= 0 AND slot_hour <= 23),
  is_available BOOLEAN DEFAULT TRUE,
  is_booked BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(city_id, slot_date, slot_hour)
);

-- ============================================================
-- BOOKINGS TABLE
-- ============================================================
CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_name VARCHAR(100) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
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

-- ============================================================
-- FUNCTION: Generate booking reference
-- ============================================================
CREATE OR REPLACE FUNCTION generate_booking_reference()
RETURNS TRIGGER AS $$
BEGIN
  NEW.booking_reference := 'SW-' || TO_CHAR(NOW(), 'YYYYMMDD') || '-' || UPPER(SUBSTRING(NEW.id::TEXT, 1, 6));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_booking_reference
BEFORE INSERT ON bookings
FOR EACH ROW EXECUTE FUNCTION generate_booking_reference();

-- ============================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ============================================================

ALTER TABLE cities ENABLE ROW LEVEL SECURITY;
ALTER TABLE installers ENABLE ROW LEVEL SECURITY;
ALTER TABLE availability_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE bookings ENABLE ROW LEVEL SECURITY;

-- Cities: public read
CREATE POLICY "Cities are viewable by everyone" ON cities FOR SELECT USING (true);

-- Availability slots: public read for available slots
CREATE POLICY "Available slots are viewable by everyone" ON availability_slots
  FOR SELECT USING (is_available = true);

-- Bookings: allow insert by anyone (customer booking)
CREATE POLICY "Anyone can create a booking" ON bookings FOR INSERT WITH CHECK (true);

-- Admin policies (using service role key - bypasses RLS)
-- Installers and admin management use service role key on server side

-- ============================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================
CREATE INDEX idx_availability_slots_city_date ON availability_slots(city_id, slot_date);
CREATE INDEX idx_bookings_slot ON bookings(slot_id);
CREATE INDEX idx_bookings_installer ON bookings(installer_id);
CREATE INDEX idx_bookings_status ON bookings(status);
CREATE INDEX idx_bookings_date ON bookings(slot_date);

-- ============================================================
-- AUTH: Create admin user
-- Run this separately after setting up auth in Supabase dashboard
-- Create user with email: admin@sadawater.com and your password
-- Then run:
-- INSERT INTO auth.users ... (done via Supabase dashboard)
-- ============================================================

-- ============================================================
-- SAMPLE AVAILABILITY (for testing - next 7 days, various hours)
-- ============================================================
-- You can add slots via the admin dashboard instead
