-- ============================================================
-- SA'DA H2O — v70 migration
-- Splits the single combined "Dammam & Khobar" service region into
-- separate Dammam, Khobar, Qatif, and Saihat regions, matching the
-- grouping the office actually works with. Also moves Julmodah into
-- the existing Jubail region (it was miscategorized under Dammam &
-- Khobar). Safwa is unassigned (region_id = NULL) rather than
-- deleted — recoverable later, just invisible to the region pickers
-- for now.
--
-- The existing combined region's id (ed34ebaa-...) is renamed in
-- place to "Khobar" rather than replaced, so any booking/slot rows
-- that already reference this service_region_id keep pointing at a
-- still-correct region (the Khobar-area cities stay on this same id).
--
-- New regions (Dammam, Qatif, Saihat) are inserted guarded by
-- WHERE NOT EXISTS on their key, so re-running this migration is safe.
-- ============================================================

-- 1. Rename the existing combined region to Khobar, keep its id —
--    everything that already points at it (bookings, slots) stays valid.
UPDATE service_regions
SET key = 'khobar', name = 'Khobar', name_ar = 'الخبر',
    city_labels = 'Al Khobar, Aziziyah, Bandariyah, Dhahran, Thuqbah',
    sort_order = 11
WHERE id = 'ed34ebaa-4f2d-49de-bcd0-abc2734384fb';

-- 2. New regions split out from it: Dammam, Qatif, Saihat.
INSERT INTO service_regions (key, name, name_ar, city_labels, sort_order)
SELECT 'dammam', 'Dammam', 'الدمام', 'Dammam, Rakah', 10
WHERE NOT EXISTS (SELECT 1 FROM service_regions WHERE key = 'dammam');

INSERT INTO service_regions (key, name, name_ar, city_labels, sort_order)
SELECT 'qatif', 'Qatif', 'القطيف', 'Anak, Qatif, Tarout', 12
WHERE NOT EXISTS (SELECT 1 FROM service_regions WHERE key = 'qatif');

INSERT INTO service_regions (key, name, name_ar, city_labels, sort_order)
SELECT 'saihat', 'Saihat', NULL, 'Saihat', 13
WHERE NOT EXISTS (SELECT 1 FROM service_regions WHERE key = 'saihat');

-- 3. Reassign cities to their new regions.
UPDATE cities SET region_id = (SELECT id FROM service_regions WHERE key = 'dammam')
WHERE name IN ('Dammam', 'Rakah');

UPDATE cities SET region_id = (SELECT id FROM service_regions WHERE key = 'qatif')
WHERE name IN ('Anak', 'Qatif', 'Tarout');

UPDATE cities SET region_id = (SELECT id FROM service_regions WHERE key = 'saihat')
WHERE name = 'Saihat';

-- Julmodah moves into the existing Jubail region.
UPDATE cities SET region_id = (SELECT id FROM service_regions WHERE key = 'jubail')
WHERE name = 'Julmodah';

-- Safwa: unassigned rather than deleted.
UPDATE cities SET region_id = NULL WHERE name = 'Safwa';

-- Khobar keeps its remaining cities (Al Khobar, Aziziyah, Bandariyah,
-- Dhahran, Thuqbah) automatically — their region_id didn't change,
-- only the region's own name/label did in step 1.
