-- v123: record of every reminder SMS (filter change, annual service, warranty
-- ending) sent from the "SMS Reminders" page. Admin only. Safe to run again.
--
-- One reminder = unit + type + due date. Once it is Sent or Skipped it is never
-- offered again for that date (unique index below), so nobody gets it twice.
-- Failed attempts are kept too (any number), and the row can be retried.
--
-- Undo: DROP TABLE IF EXISTS reminder_sms_log;

CREATE TABLE IF NOT EXISTS reminder_sms_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id   uuid REFERENCES warranties(id) ON DELETE SET NULL,
  customer_name text,
  phone         text,
  product       text,
  kind          text NOT NULL CHECK (kind IN ('filter','service','warranty')),
  due_date      date NOT NULL,
  message       text,
  status        text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  reason        text,
  sent_by       text DEFAULT (auth.jwt() ->> 'email'),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- A unit's reminder for one due date can be Sent or Skipped only once.
CREATE UNIQUE INDEX IF NOT EXISTS reminder_sms_log_once
  ON reminder_sms_log (warranty_id, kind, due_date) WHERE status IN ('sent','skipped');
CREATE INDEX IF NOT EXISTS reminder_sms_log_created ON reminder_sms_log (created_at DESC);

ALTER TABLE reminder_sms_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reminder_sms_log_admin_read ON reminder_sms_log;
CREATE POLICY reminder_sms_log_admin_read ON reminder_sms_log
  FOR SELECT TO authenticated USING (public.is_admin());
DROP POLICY IF EXISTS reminder_sms_log_admin_write ON reminder_sms_log;
CREATE POLICY reminder_sms_log_admin_write ON reminder_sms_log
  FOR INSERT TO authenticated WITH CHECK (public.is_admin());
REVOKE ALL ON reminder_sms_log FROM anon;
