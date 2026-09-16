-- v47: add name + user_id to admin_emails
-- name  — shown in the admin console's Administrators table.
-- user_id — caches the auth.users id for an admin so password resets don't
--           need to page through every auth user looking for an email match
--           (the GoTrue admin API has no exact-match "get user by email").
-- Idempotent — safe to re-run.

ALTER TABLE admin_emails ADD COLUMN IF NOT EXISTS name text;
ALTER TABLE admin_emails ADD COLUMN IF NOT EXISTS user_id uuid;
