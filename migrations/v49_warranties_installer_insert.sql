-- v49: allow installers to create PENDING warranties for their own jobs
--
-- Bug: warranties RLS only grants INSERT to anon (warranties_anon_insert)
-- and to authenticated users who pass is_admin() (warranties_admin_all).
-- Installers are authenticated but not admins, so createPendingWarranties()
-- — called from the installer portal right after completing an install —
-- has been silently failing for every installer-completed job, not just
-- ones through the new merged report+completion flow. It went unnoticed
-- because activate_pending_warranty() (the customer's QR-scan RPC) self-
-- heals: if no pending warranty exists yet, it just creates an active one
-- from scratch. So customer activation kept working — the office just
-- never got visibility into "installed, awaiting scan" units in between.
--
-- Fix: scope INSERT to installers acting on their OWN assigned booking,
-- matching the existing bookings_installer_update / bookings_installer_claim
-- pattern already used elsewhere in this schema.
--
-- Idempotent — safe to re-run.

DROP POLICY IF EXISTS warranties_installer_insert ON warranties;
CREATE POLICY warranties_installer_insert ON warranties FOR INSERT TO authenticated
  WITH CHECK (
    booking_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM bookings b WHERE b.id = warranties.booking_id AND b.installer_id = auth.uid()
    )
  );
