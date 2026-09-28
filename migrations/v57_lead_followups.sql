-- v57: Follow-ups for LEADS (not to be confused with customer_followups,
-- which are post-sale service reminders for existing customers). A lead
-- follow-up is a sales note like "call back Thursday, was checking prices" —
-- internal only, mirrors customer_followups exactly, scoped to a lead instead.
--
-- Admin-only, same as customer_followups — no anon/sales-user policy, since
-- leads themselves are already admin-only-readable (sales users reach leads
-- only through api/sales/ops.js's service-role endpoint).

CREATE TABLE IF NOT EXISTS lead_followups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  followup_date date NOT NULL,
  note          text NOT NULL,
  created_by    text,              -- admin email
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_followups_lead_idx ON lead_followups(lead_id);
CREATE INDEX IF NOT EXISTS lead_followups_date_idx ON lead_followups(followup_date);

ALTER TABLE lead_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS lead_followups_admin_all ON lead_followups;
REVOKE ALL ON lead_followups FROM anon;

CREATE POLICY lead_followups_admin_all ON lead_followups FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
