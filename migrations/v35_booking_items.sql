-- =============================================================================
-- SA'DA H2O — v35  Multi-product bookings (booking_items)
--
-- A booking can hold several product lines: e.g. 2× RO + 1× dispenser. Each RO
-- unit is serialized (needs its own QR scan → its own warranty); dispensers are
-- not serialized (no QR, no warranty). This adds a child table for the line items
-- while keeping bookings.product_model/product_qty as a summary of the primary
-- line, so all existing displays and the warranty flow keep working unchanged.
--
--  - booking_items: one row per product line on a booking.
--  - is_serialized: true = RO (QR + warranty per unit); false = dispenser.
--  - Catalogue gets is_serialized too, so the form/installer know which need QR.
--  - Backfill: every existing booking's summary product becomes one booking_item.
--
-- Idempotent. Run AFTER v34.
-- =============================================================================

-- catalogue: which products are serialized (RO) vs not (dispenser)
ALTER TABLE product_models ADD COLUMN IF NOT EXISTS is_serialized boolean NOT NULL DEFAULT true;
-- the dispenser is the only non-serialized catalogue item
UPDATE product_models
SET is_serialized = false
WHERE lower(model_name) LIKE '%dispenser%';

-- line items
CREATE TABLE IF NOT EXISTS booking_items (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id    uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  product_model text NOT NULL,
  qty           int  NOT NULL DEFAULT 1 CHECK (qty >= 1),
  unit_price    numeric,
  is_serialized boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_booking_items_booking ON booking_items(booking_id);

-- RLS: mirror bookings — anon (public booking page) may insert/read; admin full.
ALTER TABLE booking_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_items_anon_read   ON booking_items;
DROP POLICY IF EXISTS booking_items_anon_insert ON booking_items;
DROP POLICY IF EXISTS booking_items_auth_all    ON booking_items;

CREATE POLICY booking_items_anon_read   ON booking_items FOR SELECT TO anon USING (true);
CREATE POLICY booking_items_anon_insert ON booking_items FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY booking_items_auth_all    ON booking_items FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Backfill: turn each existing booking's summary product into one line item,
-- if it has no items yet. Price + serialized flag come from the catalogue when
-- the model is known; unknown/legacy models default to serialized (safe — they
-- were ROs) with null price.
INSERT INTO booking_items (booking_id, product_model, qty, unit_price, is_serialized)
SELECT b.id,
       COALESCE(NULLIF(btrim(b.product_model), ''), '7-Stage RO Purifier'),
       COALESCE(b.product_qty, 1),
       pm.price_sar,
       COALESCE(pm.is_serialized, true)
FROM bookings b
LEFT JOIN product_models pm
  ON pm.model_name = COALESCE(NULLIF(btrim(b.product_model), ''), '7-Stage RO Purifier')
WHERE NOT EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = b.id);

-- verification (run separately):
-- SELECT count(*) FROM booking_items;                    -- ≈ one per existing booking
-- SELECT model_name, is_serialized FROM product_models WHERE is_catalogue ORDER BY sort_order;
