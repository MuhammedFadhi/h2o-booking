-- ============================================================
-- SA'DA H2O — v63 migration
-- Add the inspection_reports table.
--
-- This table exists in production but was never captured in a
-- committed migration (it was created ad-hoc at some point), so it
-- was missing from the dev database when dev was bootstrapped from
-- the migration files — causing "Could not find the table
-- 'public.inspection_reports' in the schema cache" on dev.
--
-- Columns/defaults below were reconstructed from production's live
-- PostgREST schema (OpenAPI spec), so this should match prod exactly.
--
-- Safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS inspection_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id         UUID REFERENCES bookings(id),
  installer_id       UUID REFERENCES installers(id),
  customer_name      TEXT,
  customer_phone     TEXT,
  address            TEXT,
  city_name          TEXT,
  visit_type         TEXT NOT NULL DEFAULT 'installation',
  visit_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  next_service_due   DATE,
  ro_model           TEXT,
  serial_no          TEXT,
  tech_name          TEXT,
  tech_contact       TEXT,
  invoice_no         TEXT,
  feed_tds           INTEGER,
  product_tds        INTEGER,
  components         JSONB NOT NULL,
  remarks            TEXT,
  action_taken       TEXT,
  tech_signature     TEXT,
  customer_signature TEXT,
  customer_ack_name  TEXT,
  status             TEXT NOT NULL DEFAULT 'draft',
  submitted_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inspection_reports_booking_id   ON inspection_reports(booking_id);
CREATE INDEX IF NOT EXISTS idx_inspection_reports_installer_id ON inspection_reports(installer_id);
CREATE INDEX IF NOT EXISTS idx_inspection_reports_phone        ON inspection_reports(customer_phone);

-- Permissive RLS, matching the rest of this app's staff-facing tables
-- (installer portal + admin dashboard both read/write this directly).
ALTER TABLE inspection_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "inspection_reports open" ON inspection_reports;
CREATE POLICY "inspection_reports open" ON inspection_reports FOR ALL USING (true) WITH CHECK (true);
