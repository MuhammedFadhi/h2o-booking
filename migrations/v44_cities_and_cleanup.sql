-- =============================================================================
-- SA'DA H2O — v44  City list expansion + legacy city-name cleanup
--
-- CONTEXT
--   Both booking pages already use a CITY DROPDOWN populated from this table and
--   filtered by the selected region, so no new free-text city can be entered.
--   The messy values in analytics ("Khobar", "AL KHOBAR", "Rakha ,Alkhobar", ...)
--   are all HISTORICAL - every one was created between 13 Jun and 5 Jul 2026,
--   before the dropdown was in place. Nothing created since is dirty.
--
-- THIS MIGRATION
--   1. Adds the missing districts/cities per region so customers can pick their
--      actual area instead of only the parent city.
--   2. Normalises the legacy free-text booking/customer rows onto canonical
--      names so the "Bookings by city" breakdown stops fragmenting.
--
-- Idempotent - safe to re-run. Edit the city list below to taste.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. CITY LIST - (city, region) pairs; region resolved by name at insert time.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  pair     record;
  v_region uuid;
BEGIN
  FOR pair IN
    SELECT * FROM (VALUES
      ('Dammam',            'Dammam Metro'),
      ('Al Khobar',         'Dammam Metro'),
      ('Dhahran',           'Dammam Metro'),
      ('Qatif',             'Dammam Metro'),
      ('Safwa',             'Dammam Metro'),
      ('Rakah',             'Dammam Metro'),
      ('Thuqbah',           'Dammam Metro'),
      ('Aziziyah',          'Dammam Metro'),
      ('Bandariyah',        'Dammam Metro'),
      ('Julmodah',          'Dammam Metro'),
      ('Saihat',            'Dammam Metro'),
      ('Anak',              'Dammam Metro'),
      ('Tarout',            'Dammam Metro'),
      ('Jubail',            'Jubail Area'),
      ('Fanateer',          'Jubail Area'),
      ('Jubail Industrial', 'Jubail Area'),
      ('Ras Tanura',        'Jubail Area'),
      ('Hofuf',             'Al Ahsa'),
      ('Al Ahsa',           'Al Ahsa'),
      ('Mubarraz',          'Al Ahsa'),
      ('Abqaiq',            'Abqaiq'),
      ('Hafar Al-Batin',    'Hafar Al-Batin'),
      ('Riyadh',            'Riyadh'),
      ('Jeddah',            'Jeddah')
    ) AS t(city_name, region_name)
  LOOP
    SELECT id INTO v_region
      FROM service_regions
     WHERE lower(name) = lower(pair.region_name)
     LIMIT 1;

    IF v_region IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM cities
       WHERE lower(name) = lower(pair.city_name)
         AND region_id = v_region
    ) THEN
      INSERT INTO cities (name, region_id) VALUES (pair.city_name, v_region);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2. NORMALISE LEGACY FREE-TEXT VALUES (bookings + customers)
-- ---------------------------------------------------------------------------
UPDATE bookings SET city_name = 'Al Khobar'
 WHERE city_name IN ('Khobar','AL KHOBAR','Al khobar','Alkhobar','ALKHOBAR','al khobar');

UPDATE bookings SET city_name = 'Rakah'
 WHERE city_name IN ('AL RAKAH','Rakha ,Alkhobar','Rakkah Shamaliyah, Al khobar','DAMMAM RAKKAH');

UPDATE bookings SET city_name = 'Bandariyah'
 WHERE city_name IN ('Al Bandiriya , al khobar');

UPDATE bookings SET city_name = 'Fanateer'
 WHERE city_name IN ('Fanatheer, Al Jubail');

UPDATE bookings SET city_name = 'Dammam'
 WHERE city_name IN ('DAMMAM','dammam');

UPDATE customers SET city = 'Al Khobar'
 WHERE city IN ('Khobar','AL KHOBAR','Al khobar','Alkhobar','ALKHOBAR','al khobar');
UPDATE customers SET city = 'Rakah'
 WHERE city IN ('AL RAKAH','Rakha ,Alkhobar','Rakkah Shamaliyah, Al khobar','DAMMAM RAKKAH');
UPDATE customers SET city = 'Bandariyah'
 WHERE city IN ('Al Bandiriya , al khobar');
UPDATE customers SET city = 'Fanateer'
 WHERE city IN ('Fanatheer, Al Jubail');
UPDATE customers SET city = 'Dammam'
 WHERE city IN ('DAMMAM','dammam');

-- verification (run separately):
--   SELECT city_name, count(*) FROM bookings GROUP BY 1 ORDER BY 2 DESC;
--   SELECT c.name AS city, r.name AS region
--     FROM cities c JOIN service_regions r ON r.id = c.region_id
--    ORDER BY r.name, c.name;
