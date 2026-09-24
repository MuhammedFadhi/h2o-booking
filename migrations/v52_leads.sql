-- v52: Lead management for the sales role.
--
-- A lead is a low-commitment contact a sales user captures before there's a
-- firm appointment — just enough to follow up on. It stays 'open' until the
-- sales user either converts it into a real booking (via api/sales/ops.js's
-- create-booking, which now accepts an optional leadId and marks the lead
-- converted + links it — see v51_sales_users.sql for the sales role itself)
-- or marks it lost.
--
-- Same security shape as bookings: admins get full RLS access, sales users
-- get none directly — they reach this table only through api/sales/ops.js,
-- which uses the service-role key and enforces "your own leads only" itself.

CREATE TABLE IF NOT EXISTS leads (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text NOT NULL,
  phone                 text NOT NULL,
  region_id             uuid REFERENCES service_regions(id),
  city_name             text,
  source                text,
  product_interest      text,
  notes                 text,
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'converted', 'lost')),
  lost_reason           text,
  created_by_user       uuid,
  created_by_name       text,
  converted_booking_id  uuid REFERENCES bookings(id) ON DELETE SET NULL,
  converted_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_created_by_user ON leads (created_by_user);
CREATE INDEX IF NOT EXISTS idx_leads_status          ON leads (status);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leads FROM anon;
DROP POLICY IF EXISTS leads_admin_all ON leads;
CREATE POLICY leads_admin_all ON leads FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());
-- No anon policy at all — leads are never customer-facing. No policy for the
-- plain 'authenticated' role either — a signed-in sales user who isn't an
-- admin has no direct grant, matching how they have zero direct access to
-- sales_users or bookings; the server (service role) is the only path in.
