-- v124: one "campaign" record per press of Send on the SMS Reminders page.
-- Each reminder SMS (reminder_sms_log, v123) points at the campaign it was sent in,
-- and the view adds up total / sent / failed per campaign. Admin only. Needs v123.
-- Safe to run again.
--
-- Undo:
--   DROP VIEW IF EXISTS reminder_sms_campaign_summary;
--   ALTER TABLE reminder_sms_log DROP COLUMN IF EXISTS campaign_id;
--   DROP TABLE IF EXISTS reminder_sms_campaigns; DROP SEQUENCE IF EXISTS reminder_sms_campaign_seq;

CREATE SEQUENCE IF NOT EXISTS reminder_sms_campaign_seq;

CREATE TABLE IF NOT EXISTS reminder_sms_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_no bigint NOT NULL UNIQUE DEFAULT nextval('reminder_sms_campaign_seq'),
  planned     int NOT NULL DEFAULT 0,
  sent_by     text DEFAULT (auth.jwt() ->> 'email'),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE reminder_sms_log ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES reminder_sms_campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS reminder_sms_log_campaign ON reminder_sms_log (campaign_id);

ALTER TABLE reminder_sms_campaigns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reminder_sms_campaigns_admin_read ON reminder_sms_campaigns;
CREATE POLICY reminder_sms_campaigns_admin_read ON reminder_sms_campaigns
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS reminder_sms_campaigns_admin_write ON reminder_sms_campaigns;
CREATE POLICY reminder_sms_campaigns_admin_write ON reminder_sms_campaigns
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
REVOKE ALL ON reminder_sms_campaigns FROM anon;
GRANT USAGE ON SEQUENCE reminder_sms_campaign_seq TO authenticated;

-- One line per campaign with its totals (respects the admin-only rules above).
CREATE OR REPLACE VIEW reminder_sms_campaign_summary WITH (security_invoker = true) AS
SELECT c.id, c.campaign_no, c.created_at, c.sent_by, c.planned,
       count(l.id)                                  AS total,
       count(l.id) FILTER (WHERE l.status = 'sent')   AS sent,
       count(l.id) FILTER (WHERE l.status = 'failed') AS failed,
       count(l.id) FILTER (WHERE l.kind = 'filter')   AS filter_count,
       count(l.id) FILTER (WHERE l.kind = 'service')  AS service_count,
       count(l.id) FILTER (WHERE l.kind = 'warranty') AS warranty_count
FROM reminder_sms_campaigns c
LEFT JOIN reminder_sms_log l ON l.campaign_id = c.id
GROUP BY c.id;
