-- ============================================================
-- SA'DA H2O — v64 migration
-- Remove the 48h/2-day minimum booking lead time entirely.
--
-- v22 added a trigger blocking customer (anon/authenticated) bookings
-- less than 2 days out; v62 exempted admins specifically. Decision
-- now: customers should be able to self-book any genuinely free slot,
-- same as admins always could — no minimum notice at all.
--
-- Drops the trigger (keeps the function defined but unused, in case
-- this is ever revisited — harmless either way since nothing calls it
-- once the trigger is gone).
--
-- Safe to re-run.
-- ============================================================

DROP TRIGGER IF EXISTS trg_bookings_lead_time ON bookings;
