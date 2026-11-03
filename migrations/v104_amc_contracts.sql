-- v104: AMC (Annual Maintenance Contract) — a per-unit prepaid service
-- contract. A customer pays a discounted amount upfront (e.g. 399 instead of
-- the ~466 standalone total of 1 annual service + 3 quarterly filter
-- changes) covering that cadence for 12 months from start_date.
--
-- This is record-keeping + a flag surfaced where staff schedule/complete a
-- service visit (Service Booking modal, Mark Complete payment modal, Active
-- Units table) — it is NOT wired into booking creation/completion logic
-- itself. Admin stays in control of what actually gets charged.
--
-- status only tracks active/cancelled. "Expired" is a DERIVED display state
-- (end_date < today while status='active'), computed client-side exactly
-- like warrantyFilterOf() already does for filter/service due dates — no
-- cron needed. Renewing a contract inserts a new row rather than updating
-- the old one, so history is preserved; every lookup uses the most recent
-- row per warranty_id (order by start_date desc).

CREATE TABLE IF NOT EXISTS amc_contracts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id        uuid NOT NULL REFERENCES warranties(id),
  customer_id        uuid REFERENCES customers(id),
  start_date         date NOT NULL DEFAULT CURRENT_DATE,
  end_date           date NOT NULL,            -- app sets this to start_date + 365 days
  amount_paid        numeric(10,2) NOT NULL,   -- the discounted amount actually collected (e.g. 399)
  standard_price     numeric(10,2),            -- optional reference price (e.g. 466), to show savings
  payment_method     text,
  payment_reference  text,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  notes              text,
  created_by_name    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_amc_contracts_warranty ON amc_contracts(warranty_id);
CREATE INDEX IF NOT EXISTS idx_amc_contracts_customer ON amc_contracts(customer_id);

-- Same security shape as leads (migrations/v52_leads.sql): admin-only via
-- the existing is_admin() helper, no anon access.
ALTER TABLE amc_contracts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON amc_contracts FROM anon;
DROP POLICY IF EXISTS amc_contracts_admin_all ON amc_contracts;
CREATE POLICY amc_contracts_admin_all ON amc_contracts FOR ALL TO authenticated USING (is_admin()) WITH CHECK (is_admin());

-- verification:
-- SELECT * FROM amc_contracts ORDER BY created_at DESC LIMIT 10;
