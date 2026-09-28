-- =============================================================================
-- Fixes a bug from v54: CREATE OR REPLACE FUNCTION does NOT treat "same name,
-- one new trailing parameter with a DEFAULT" as replacing the existing
-- function — Postgres creates a genuinely separate overload instead. So after
-- v54 ran, TWO versions of create_booking() existed at once:
--   (uuid,text,text,text,uuid,text,numeric,numeric)        — the original
--   (uuid,text,text,text,uuid,text,numeric,numeric,text)   — v54's version
--
-- Every call to create_booking() then failed with "Could not choose the best
-- candidate function" — Postgres can't tell the two apart, since a call that
-- omits p_booking_type matches BOTH (the 9-arg one via its default). This
-- broke every booking-creation path, including "Book for Customer", which
-- never even asked for the p_booking_type change.
--
-- Fix: drop the old 8-arg overload outright, leaving only the 9-arg one
-- (p_booking_type still defaults to 'installation', so every caller that
-- doesn't pass it — the public booking page, "Book for Customer" — is
-- unaffected). Idempotent: DROP ... IF EXISTS, safe to re-run.
-- =============================================================================

DROP FUNCTION IF EXISTS public.create_booking(uuid, text, text, text, uuid, text, numeric, numeric);

GRANT EXECUTE ON FUNCTION public.create_booking(uuid,text,text,text,uuid,text,numeric,numeric,text) TO anon, authenticated;
