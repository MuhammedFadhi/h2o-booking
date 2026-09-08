-- =============================================================================
-- SA'DA H2O — v30  Admin activity log
--
-- A lightweight audit trail: who did what, when. Records consequential admin
-- actions (cancel/complete/reschedule a booking, activate/pause/deactivate a
-- warranty, edit a name, bulk operations). Read-only history for accountability
-- as the team grows.
--
-- Deliberately simple: one flat table, admin-only, append-only in practice.
-- The app writes entries; nothing deletes them from the UI.
--
-- Idempotent. Run AFTER v29_reminder_dedup.sql.
-- =============================================================================

CREATE TABLE IF NOT EXISTS activity_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor       text,                       -- admin email (from the session)
  action      text NOT NULL,              -- machine key, e.g. 'booking.cancel'
  summary     text NOT NULL,              -- human sentence for the log view
  entity_type text,                       -- 'booking' | 'warranty' | 'customer' | 'followup'
  entity_id   text,                       -- the affected row's id (text — ids vary)
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_log_created_idx ON activity_log(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_log_entity_idx  ON activity_log(entity_type, entity_id);

ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;

-- Admin-only: read + insert. No update/delete policy → history can't be
-- rewritten from the client even by an admin (append-only by omission).
DROP POLICY IF EXISTS activity_log_admin_read   ON activity_log;
DROP POLICY IF EXISTS activity_log_admin_insert ON activity_log;
CREATE POLICY activity_log_admin_read   ON activity_log FOR SELECT TO authenticated USING (is_admin());
CREATE POLICY activity_log_admin_insert ON activity_log FOR INSERT TO authenticated WITH CHECK (is_admin());

-- Anon has no access at all (no policy for anon = denied under RLS).

-- verification (run separately after):
-- SELECT count(*) FROM activity_log;   → 0 until the app logs its first action
