-- =============================================================================
-- SA'DA H2O — v28  Warranty status + admin activation from completed installs
--
-- Adds admin-controlled warranty activation (Option C):
--   • warranties.status  — active | paused | deactivated
--       auto-imported and QR-claimed warranties are 'active'.
--       admin can pause (suspend), deactivate (void), or reactivate.
--   • warranties.booking_id — links a warranty to the installation booking it
--       was activated from, so one booking maps to at most one warranty
--       (the dedup key for admin activation).
--   • warranties.activated_by / activated_at — audit of who activated it.
--
-- This does NOT auto-create warranties on report submit. Admin activates a
-- completed installation with one click (or in bulk). Chosen over automatic
-- creation because installers do not currently enter serials, so an automatic
-- path would produce QR-less warranties that duplicate when the customer later
-- scans their sticker. Admin activation carries no such risk.
--
-- Idempotent. Safe to re-run. Does NOT alter qr_code's constraints, so it
-- cannot affect the existing 76 rows.
-- Run AFTER v27_warranty_schema.sql and v27_warranty_data.sql.
-- =============================================================================

-- 1) status ------------------------------------------------------------------
ALTER TABLE warranties ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'paused', 'deactivated'));

-- 2) booking link + activation audit -----------------------------------------
ALTER TABLE warranties ADD COLUMN IF NOT EXISTS booking_id uuid
  REFERENCES bookings(id) ON DELETE SET NULL;
ALTER TABLE warranties ADD COLUMN IF NOT EXISTS activated_by text;
ALTER TABLE warranties ADD COLUMN IF NOT EXISTS activated_at timestamptz;

-- One warranty per booking. Partial unique index (only where booking_id is set)
-- so the 76 existing rows, which have no booking_id, are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS warranties_booking_unique
  ON warranties(booking_id) WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS warranties_status_idx ON warranties(status);

-- 3) let the anon guard trigger permit these new columns on admin insert ------
--    The v27 guard forces anon-claim values server-side. Admin activation runs
--    as `authenticated` (not anon), so it already bypasses the guard's anon
--    branch — no change needed there. But make the intent explicit: an admin
--    may set status/booking_id/activated_* freely.
--    (No trigger change required; documented here for the next reader.)

-- 4) RLS: status changes are admin-only --------------------------------------
--    Already covered by the existing warranties_admin_all policy
--    (USING is_admin() WITH CHECK is_admin()). Anon cannot UPDATE at all
--    (guard_anon_warranty_update raises). Nothing to add.

-- 5) backfill --------------------------------------------------------------- -
--    Every existing warranty is 'active' by the column default. No row needs
--    touching. Imported + QR-claimed warranties keep working exactly as before.

-- verification (run separately after) ----------------------------------------
-- SELECT status, count(*) FROM warranties GROUP BY status;
--   → expect all 'active'
-- SELECT count(*) FROM warranties WHERE booking_id IS NOT NULL;
--   → expect 0 until admin activates the first completed install
