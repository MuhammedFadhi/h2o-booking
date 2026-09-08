-- =============================================================================
-- SA'DA H2O — v37  Jeddah region · Promo codes · Payment + Invoice lifecycle
--
-- THREE features in one migration:
--   1. Add Jeddah to service_regions (+ a Jeddah city).
--   2. promo_codes table (percent/amount discounts, validity window, active flag,
--      usage counter) + booking fields recording which code a customer used and
--      how much they saved.
--   3. Booking lifecycle: installer finishes -> 'installed' (warranty activates
--      here); admin adds payment mode + invoice -> 'completed'. Adds the money +
--      date columns, an invoices table, and MIGRATES existing 'completed'
--      bookings back to 'installed' so the office backfills their payment/invoice.
--
-- Idempotent. Run AFTER v36.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. JEDDAH REGION + CITY
-- ---------------------------------------------------------------------------
INSERT INTO service_regions (key, name, name_ar, city_labels, sort_order)
SELECT 'jeddah', 'Jeddah', 'جدة', 'Jeddah', 100
WHERE NOT EXISTS (SELECT 1 FROM service_regions WHERE key = 'jeddah');

-- a matching city so the booking city picker + installer filter have it
INSERT INTO cities (name, name_ar, region_id)
SELECT 'Jeddah', 'جدة', r.id
FROM service_regions r
WHERE r.key = 'jeddah'
  AND NOT EXISTS (SELECT 1 FROM cities c WHERE c.name = 'Jeddah');

-- ---------------------------------------------------------------------------
-- 2. PROMO CODES
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS promo_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL,
  discount_type text NOT NULL DEFAULT 'percent' CHECK (discount_type IN ('percent','amount')),
  discount_value numeric NOT NULL CHECK (discount_value >= 0),
  valid_from    date,
  valid_until   date,
  is_active     boolean NOT NULL DEFAULT true,
  usage_count   int NOT NULL DEFAULT 0,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- codes are matched case-insensitively; keep them unique regardless of case
CREATE UNIQUE INDEX IF NOT EXISTS promo_codes_code_lower_uidx ON promo_codes (lower(code));

ALTER TABLE promo_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS promo_anon_read   ON promo_codes;
DROP POLICY IF EXISTS promo_auth_all    ON promo_codes;
-- anon (public booking page) may READ active codes to validate them; only admin writes.
CREATE POLICY promo_anon_read ON promo_codes FOR SELECT TO anon USING (true);
CREATE POLICY promo_auth_all  ON promo_codes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Atomic usage increment (called when a booking successfully applies a code).
-- SECURITY DEFINER so anon can bump the counter without a broad UPDATE grant.
CREATE OR REPLACE FUNCTION increment_promo_usage(p_code text)
RETURNS void LANGUAGE sql SECURITY DEFINER AS $$
  UPDATE promo_codes SET usage_count = usage_count + 1, updated_at = now()
  WHERE lower(code) = lower(p_code);
$$;
GRANT EXECUTE ON FUNCTION increment_promo_usage(text) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. BOOKING LIFECYCLE: money + dates + invoice
-- ---------------------------------------------------------------------------
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS order_total     numeric;   -- pre-discount total (from basket)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS promo_code      text;      -- code the customer applied
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS discount_amount numeric;   -- SAR taken off
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS payment_method  text;      -- cash | card | tabby | tamara
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_number  text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_url     text;      -- optional uploaded file
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS installed_at    timestamptz; -- when installer finished
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoiced_at     timestamptz; -- when payment/invoice recorded

-- Invoices table (richer records for the Invoices tab + VAT SMS). One per booking
-- for now, but modelled as its own table so it can grow.
CREATE TABLE IF NOT EXISTS invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id     uuid REFERENCES bookings(id) ON DELETE SET NULL,
  invoice_number text NOT NULL,
  customer_name  text,
  customer_phone text,
  amount         numeric,        -- net (pre-VAT) if known
  vat_amount     numeric,        -- 15% VAT if known
  total          numeric,        -- gross
  payment_method text,
  file_url       text,           -- uploaded invoice PDF/image (optional)
  issued_at      timestamptz NOT NULL DEFAULT now(),
  sms_sent_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_booking_idx ON invoices(booking_id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_number_uidx ON invoices (lower(invoice_number));

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS invoices_anon_read ON invoices;
DROP POLICY IF EXISTS invoices_auth_all  ON invoices;
-- anon can READ an invoice (so a customer viewing their own booking link can see it);
-- only admin writes. (Customer-facing view is by booking reference, not a list.)
CREATE POLICY invoices_anon_read ON invoices FOR SELECT TO anon USING (true);
CREATE POLICY invoices_auth_all  ON invoices FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. MIGRATE EXISTING 'completed' -> 'installed'
--    The new terminal state after install is 'installed'. Existing completed
--    bookings had no payment/invoice captured, so they become 'installed' and
--    the office will add payment details to truly 'complete' them.
--    Preserve the historical completion moment as installed_at.
-- ---------------------------------------------------------------------------

-- First widen the status CHECK constraint to allow the new 'installed' value.
-- The existing constraint (bookings_status_check) doesn't include it, so the
-- UPDATE below would fail without this. Drop-and-recreate with the full set.
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_status_check;
ALTER TABLE bookings ADD CONSTRAINT bookings_status_check
  CHECK (status IN ('upcoming','in_progress','installed','completed','cancelled'));

UPDATE bookings
SET status = 'installed',
    installed_at = COALESCE(installed_at, completed_at, now())
WHERE status = 'completed';

-- ---------------------------------------------------------------------------
-- 5. STORAGE: invoices bucket (for optional uploaded invoice files)
--    Buckets live in storage.buckets; create it here so the admin upload works.
--    Public read so a shared invoice link opens for the customer.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
SELECT 'invoices', 'invoices', true
WHERE NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'invoices');

-- allow authenticated (admin) to upload/update; anyone to read (public bucket).
DROP POLICY IF EXISTS invoices_bucket_read   ON storage.objects;
DROP POLICY IF EXISTS invoices_bucket_write  ON storage.objects;
CREATE POLICY invoices_bucket_read  ON storage.objects FOR SELECT USING (bucket_id = 'invoices');
CREATE POLICY invoices_bucket_write ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'invoices') WITH CHECK (bucket_id = 'invoices');

-- verification (run separately):
-- SELECT status, count(*) FROM bookings GROUP BY status;
-- SELECT name FROM service_regions ORDER BY sort_order;
-- SELECT code, discount_type, discount_value, is_active, usage_count FROM promo_codes;
