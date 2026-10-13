-- ============================================================
-- SA'DA H2O — v69 migration
-- Installers can save their own signature once (from a new Profile
-- section in installer/portal.html) and have it auto-fill the
-- technician signature on every inspection report, instead of
-- redrawing it on every single job.
--
-- installers_installer_self (v26) only grants SELECT on an installer's
-- own row — there's no UPDATE policy at all yet. Scope this new one
-- tightly to just the saved_signature column, same precedent as the
-- warranty RLS migrations (v66/v68) scoping installer writes narrowly
-- rather than opening up the whole row.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE installers ADD COLUMN IF NOT EXISTS saved_signature TEXT;

GRANT UPDATE (saved_signature) ON installers TO authenticated;

DROP POLICY IF EXISTS installers_installer_update_own_signature ON installers;
CREATE POLICY installers_installer_update_own_signature
  ON installers FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());
