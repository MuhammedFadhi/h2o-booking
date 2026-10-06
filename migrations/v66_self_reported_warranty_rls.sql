-- ============================================================
-- SA'DA H2O — v66 migration
-- Let an installer write self-reported warranty tracking.
--
-- Same bug class v49 already fixed for warranties itself: an installer's
-- own session is authenticated but not admin, and:
--   1) warranty_service_history has NO insert policy for non-admins at all
--      ("admin writes" per the original v27 schema comment) — so logging
--      a self-reported Filter Change/Annual Service completion silently
--      failed every time.
--   2) warranties has an installer INSERT policy (v49) but no UPDATE
--      policy — so renewing an existing self_reported row on a customer's
--      2nd+ visit would also silently fail.
--
-- Fix: add an installer insert policy on warranty_service_history scoped
-- to a warranty tied to their own assigned booking (mirrors v49's pattern
-- exactly), and an installer update policy on warranties scoped to
-- source='self_reported' only — real (source='install') warranties are
-- untouched by this; installers still can't edit those directly.
--
-- Idempotent — safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS wsh_installer_insert ON warranty_service_history;
CREATE POLICY wsh_installer_insert ON warranty_service_history FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM warranties w
      JOIN bookings b ON b.id = w.booking_id
      WHERE w.id = warranty_service_history.warranty_id AND b.installer_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS warranties_installer_update_self_reported ON warranties;
CREATE POLICY warranties_installer_update_self_reported ON warranties FOR UPDATE TO authenticated
  USING (source = 'self_reported')
  WITH CHECK (source = 'self_reported');
