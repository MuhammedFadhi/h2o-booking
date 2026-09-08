-- =============================================================================
-- SA'DA H2O — v25 service regions + revert to self-serve installer claim
-- - Introduces service_regions (grouped cities) as the slot/booking scope.
-- - Adds Hofuf + Riyadh to cities.
-- - Backfills every existing slot to Dammam Metro so old data still shows.
-- - Swaps availability_slots UNIQUE to (region, date, hour).
-- - Drops auto_assign_installer() — installers self-claim from the Available tab.
-- Idempotent. Safe to re-run.
-- =============================================================================

-- 1) service_regions ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_regions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  name_ar TEXT,
  city_labels TEXT NOT NULL,
  sort_order INT DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO service_regions (key, name, name_ar, city_labels, sort_order) VALUES
  ('dammam-metro', 'Dammam Metro', 'الدمام الكبرى', 'Dammam, Al Khobar, Dhahran, Qatif, Safwa', 10),
  ('jubail',       'Jubail Area',  'الجبيل',        'Jubail, Ras Tanura',                     20),
  ('ahsa',         'Al Ahsa',      'الأحساء',       'Hofuf, Al Ahsa',                         30),
  ('abqaiq',       'Abqaiq',       'بقيق',          'Abqaiq',                                 40),
  ('hafar',        'Hafar Al-Batin','حفر الباطن',   'Hafar Al-Batin',                         50),
  ('riyadh',       'Riyadh',       'الرياض',        'Riyadh',                                 60)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE service_regions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS regions_public_read ON service_regions;
CREATE POLICY regions_public_read ON service_regions FOR SELECT TO anon, authenticated USING (TRUE);
DROP POLICY IF EXISTS regions_admin_write ON service_regions;
CREATE POLICY regions_admin_write ON service_regions FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- 2) cities.region_id + missing cities ---------------------------------------
ALTER TABLE cities ADD COLUMN IF NOT EXISTS region_id UUID REFERENCES service_regions(id);

UPDATE cities c SET region_id = (SELECT id FROM service_regions WHERE key='dammam-metro') WHERE c.name IN ('Dammam','Al Khobar','Dhahran','Qatif','Safwa');
UPDATE cities c SET region_id = (SELECT id FROM service_regions WHERE key='jubail')        WHERE c.name IN ('Jubail','Ras Tanura');
UPDATE cities c SET region_id = (SELECT id FROM service_regions WHERE key='ahsa')          WHERE c.name IN ('Al Ahsa','Hofuf');
UPDATE cities c SET region_id = (SELECT id FROM service_regions WHERE key='abqaiq')        WHERE c.name = 'Abqaiq';
UPDATE cities c SET region_id = (SELECT id FROM service_regions WHERE key='hafar')         WHERE c.name = 'Hafar Al-Batin';

INSERT INTO cities (name, name_ar, region_id)
SELECT 'Hofuf', 'الهفوف', (SELECT id FROM service_regions WHERE key='ahsa')
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name='Hofuf');

INSERT INTO cities (name, name_ar, region_id)
SELECT 'Riyadh', 'الرياض', (SELECT id FROM service_regions WHERE key='riyadh')
WHERE NOT EXISTS (SELECT 1 FROM cities WHERE name='Riyadh');

-- 3) availability_slots.service_region_id ------------------------------------
ALTER TABLE availability_slots ADD COLUMN IF NOT EXISTS service_region_id UUID REFERENCES service_regions(id);

-- Backfill legacy NULL slots to Dammam Metro (was the implicit default).
UPDATE availability_slots
   SET service_region_id = (SELECT id FROM service_regions WHERE key='dammam-metro')
 WHERE service_region_id IS NULL;

ALTER TABLE availability_slots ALTER COLUMN service_region_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_slots_region_date_hour ON availability_slots(service_region_id, slot_date, slot_hour);

-- Swap UNIQUE(slot_date, slot_hour) → UNIQUE(service_region_id, slot_date, slot_hour).
DO $$
DECLARE cn text;
BEGIN
  SELECT c.conname INTO cn FROM pg_constraint c
   JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'availability_slots'
     AND c.contype = 'u'
     AND pg_get_constraintdef(c.oid) = 'UNIQUE (slot_date, slot_hour)';
  IF cn IS NOT NULL THEN EXECUTE 'ALTER TABLE availability_slots DROP CONSTRAINT ' || quote_ident(cn); END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname='availability_slots' AND c.contype='u'
       AND pg_get_constraintdef(c.oid) LIKE '%service_region_id%slot_date%slot_hour%'
  ) THEN
    ALTER TABLE availability_slots ADD CONSTRAINT availability_slots_region_date_hour_key UNIQUE (service_region_id, slot_date, slot_hour);
  END IF;
END $$;

-- 4) bookings.service_region_id ----------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS service_region_id UUID REFERENCES service_regions(id);
CREATE INDEX IF NOT EXISTS idx_bookings_region ON bookings(service_region_id);

-- 5) revert auto-assign ------------------------------------------------------
DROP FUNCTION IF EXISTS public.auto_assign_installer(uuid);
