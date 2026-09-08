-- =============================================================================
-- SA'DA H2O — v43  RLS hardening (PHASE 1 — safe, non-breaking)
--
-- Audit found anon (public key) could read invoices (financial data). No public
-- page reads invoices — only the authenticated admin does — so we lock anon out
-- of the invoices table without affecting any public flow.
--
-- IMPORTANT — what this migration deliberately does NOT do (yet):
--   The public booking page performs three DIRECT anon writes it currently needs:
--     • bookings.update()   (customer/book.html ~L953 — adds product details)
--     • booking_items.insert() (~L961)
--     • customers.upsert()  (~L972)
--   and the claim page reads customers/bookings/warranties as anon (viewProfile).
--   Blocking those would BREAK booking + the customer portal. Fully locking them
--   down requires first moving those writes into the create_booking RPC and the
--   portal reads into a SECURITY DEFINER RPC. That is a separate, carefully-tested
--   phase (v44). This migration is the safe subset that breaks nothing.
--
-- Idempotent. Safe to run anytime.
-- =============================================================================

-- Ensure RLS is on for invoices (it should be, but be explicit).
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

-- Remove any permissive anon read policy on invoices if one exists.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'invoices'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON invoices', pol.policyname);
  END LOOP;
END $$;

-- Authenticated (admin) can do everything on invoices.
CREATE POLICY invoices_admin_all ON invoices
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- anon gets NO access to invoices (no policy = denied under RLS).
-- (Explicitly no anon policy is created.)

-- Note: the SECURITY DEFINER create-invoice path (if any) still works because
-- definer functions bypass RLS. Admin invoice reads use the authenticated role.

-- verification (run separately, as anon, should return 0 / error):
--   select * from invoices limit 1;   -- as anon → blocked
