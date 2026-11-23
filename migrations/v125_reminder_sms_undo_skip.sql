-- v125: let an admin undo a SKIPPED reminder (e.g. skipped by mistake).
-- Only rows with status 'skipped' can be removed; Sent and Failed records can
-- never be deleted, so the SMS history stays complete. The reminder then shows
-- again under "To send". Needs v123. Safe to run again.
--
-- Undo: DROP POLICY IF EXISTS reminder_sms_log_admin_undo_skip ON reminder_sms_log;

DROP POLICY IF EXISTS reminder_sms_log_admin_undo_skip ON reminder_sms_log;
CREATE POLICY reminder_sms_log_admin_undo_skip ON reminder_sms_log
  FOR DELETE TO authenticated USING (public.is_admin() AND status = 'skipped');
