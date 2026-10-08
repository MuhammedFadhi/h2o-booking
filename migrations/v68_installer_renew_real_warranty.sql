-- ============================================================
-- SA'DA H2O — v68 migration
-- Let an installer renew a REAL (source='install') warranty's due dates
-- when completing a Filter Change / Annual Service job in the field —
-- previously only an admin's manual "+Job" button could do this; a real
-- customer's installer-completed service visit silently did nothing to
-- their actual warranty (RLS would have rejected it anyway, even once
-- js/inspection-report.js started trying).
--
-- v66 added the installer-update policy for source='self_reported' only,
-- and the installer-insert policy on warranty_service_history scoped via
-- warranties.booking_id — which for a real warranty is the ORIGINAL
-- INSTALL booking, not whatever booking the installer is completing today.
-- That's the wrong booking to check installer_id against, since the
-- installer doing a later service visit is usually not the one who did the
-- original install.
--
-- Scope here instead: the warranty's customer (matched by phone, same as
-- the rest of this codebase joins customers<->bookings) has ANY booking
-- currently assigned to this installer. Same precedent as v66's pattern,
-- just keyed off the customer instead of the warranty's own stale
-- booking_id.
--
-- Idempotent — safe to re-run.
-- ============================================================

DROP POLICY IF EXISTS warranties_installer_update_real_on_service ON warranties;
CREATE POLICY warranties_installer_update_real_on_service ON warranties FOR UPDATE TO authenticated
  USING (
    source = 'install' AND EXISTS (
      SELECT 1 FROM customers c
      JOIN bookings b ON b.customer_phone = c.phone
      WHERE c.id = warranties.customer_id AND b.installer_id = auth.uid()
    )
  )
  WITH CHECK (
    source = 'install' AND EXISTS (
      SELECT 1 FROM customers c
      JOIN bookings b ON b.customer_phone = c.phone
      WHERE c.id = warranties.customer_id AND b.installer_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS wsh_installer_insert_real ON warranty_service_history;
CREATE POLICY wsh_installer_insert_real ON warranty_service_history FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM warranties w
      JOIN customers c ON c.id = w.customer_id
      JOIN bookings b ON b.customer_phone = c.phone
      WHERE w.id = warranty_service_history.warranty_id
        AND w.source = 'install'
        AND b.installer_id = auth.uid()
    )
  );
