-- v122 — ZATCA E-Invoicing page: per-environment settings + per-invoice
-- environment and error, modelled on the Al Amanah (SMA) integration.
--
-- zatca_device_state holds the settings the ZATCA page edits, one row per ZATCA
-- environment (developer-portal / simulation / core), so switching the signing
-- service from simulation to production starts with automatic submission OFF
-- and no Phase 2 date, instead of inheriting the test settings.
--
--   auto_submit        NULL/false = OFF: invoices are only sent when someone
--                      clicks Report. true = every invoice is sent on save.
--   phase2_start_date  Invoices dated before it were Phase 1 documents and are
--                      never sent. While it is NULL nothing can be sent at all,
--                      because there is no way to tell Phase 1 from Phase 2.
--
-- invoices.einvoice_env records WHICH environment accepted the invoice: one
-- reported in simulation still counts as NOT SENT once the system runs in
-- production. einvoice_error keeps ZATCA's rejection for the Pending page.
--
-- Idempotent. Run AFTER v113.

CREATE TABLE IF NOT EXISTS zatca_device_state (
  environment        text PRIMARY KEY,
  auto_submit        boolean,
  phase2_start_date  date,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE zatca_device_state ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS zatca_device_state_auth_all ON zatca_device_state;
-- Admin dashboard only; never readable by anon.
CREATE POLICY zatca_device_state_auth_all ON zatca_device_state
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_env   text;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_error text;
CREATE INDEX IF NOT EXISTS invoices_einvoice_env_status_idx ON invoices (einvoice_env, einvoice_status);

-- Check:
-- SELECT * FROM zatca_device_state;
