-- v50: floor and flat number on bookings
--
-- Captured on the customer booking form (customer/book.html) so the installer
-- knows which floor / flat to go to, and shown on the installer job card, the
-- admin booking detail and the customer portal booking card.
--
-- Free text (not integer): real-world values include "G", "Ground", "12B", "PH".
-- Both are optional. No RLS/trigger change is needed — the anon-update guard
-- (enforce_anon_booking_update) only blocks a fixed list of other columns.
--
-- RUN THIS BEFORE deploying the form change to production. Idempotent.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS floor_no text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS flat_no  text;
