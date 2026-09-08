-- =============================================================================
-- SA'DA H2O — v23 self-serve installer assignment
-- Adds: is_installer() function, RLS policies for installers to browse and
--       atomically claim unassigned bookings, sms_settings key for broadcast.
-- Safe to re-run.
-- =============================================================================

-- 1) is_installer() — is the caller in the installers table?
CREATE OR REPLACE FUNCTION public.is_installer() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM installers WHERE id = auth.uid());
$$;
GRANT EXECUTE ON FUNCTION public.is_installer() TO anon, authenticated;

-- 2) Installers can SEE all unassigned upcoming bookings (available pool)
DROP POLICY IF EXISTS bookings_installer_browse_available ON bookings;
CREATE POLICY bookings_installer_browse_available ON bookings FOR SELECT TO authenticated
  USING (installer_id IS NULL AND status = 'upcoming' AND is_installer());

-- 3) Installers can CLAIM an unassigned booking (atomic — RLS enforces both conditions)
DROP POLICY IF EXISTS bookings_installer_claim ON bookings;
CREATE POLICY bookings_installer_claim ON bookings FOR UPDATE TO authenticated
  USING (installer_id IS NULL AND status = 'upcoming' AND is_installer())
  WITH CHECK (installer_id = auth.uid() AND is_installer());

-- 4) New sms_settings key for the "new booking available" broadcast
INSERT INTO sms_settings (key, enabled) VALUES ('new_booking_available', true)
ON CONFLICT (key) DO NOTHING;

-- 5) Supabase Realtime — enable replication on bookings so installer portals
--    can subscribe to INSERTs. Idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND tablename = 'bookings'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE bookings;
  END IF;
END $$;
