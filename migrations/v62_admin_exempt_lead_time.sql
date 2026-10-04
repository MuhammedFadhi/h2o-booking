-- ============================================================
-- SA'DA H2O — v62 migration
-- Exempt logged-in admins from the 48h booking lead-time check.
--
-- The v22 trigger (enforce_booking_lead_time) only exempted true
-- service-role calls. But the admin dashboard's "Book for Customer"
-- modal creates bookings through the browser's own Supabase client,
-- using the admin's own logged-in session — same JWT role
-- ('authenticated') as an ordinary customer. So admins were being
-- blocked by the same 2-day minimum meant only for self-service
-- customer bookings, even though the original migration's comment
-- said admins should be able to back-date bookings.
--
-- Fix: also exempt any request whose JWT email is in admin_emails
-- (the same is_admin() check already used across RLS policies).
--
-- Safe to re-run.
-- ============================================================

CREATE OR REPLACE FUNCTION enforce_booking_lead_time()
RETURNS TRIGGER AS $$
DECLARE
  jwt_role TEXT;
BEGIN
  -- Best-effort role detection (empty during pg_cron/service_role bypass)
  BEGIN
    jwt_role := coalesce(auth.jwt() ->> 'role', current_setting('request.jwt.claim.role', true));
  EXCEPTION WHEN OTHERS THEN
    jwt_role := NULL;
  END;

  -- Only enforce on customer (anon) or logged-in customer (authenticated)
  -- that is NOT a recognised admin.
  IF jwt_role IN ('anon', 'authenticated') AND NOT is_admin() THEN
    IF NEW.slot_date < (CURRENT_DATE + INTERVAL '2 days')::date THEN
      RAISE EXCEPTION 'Bookings require at least 2 days lead time (earliest: %).', (CURRENT_DATE + INTERVAL '2 days')::date;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
