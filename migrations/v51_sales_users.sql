-- v51: Sales users — a role that can add bookings and see only its own.
--
-- sales_users
--   id = the Supabase Auth user id (same convention as installers.id).
--   Locked down: RLS on, NO policies, privileges revoked. Nothing but the
--   service role (the server API in api/sales/* and api/admin/user-ops.js)
--   can read or write it, so a sales login has no direct database access
--   beyond what any public visitor already has.
--
-- bookings.created_by_user
--   The auth user id of the sales user who created the booking. "My bookings"
--   in the sales portal = rows with created_by_user = the caller's id.
--   Stays NULL for customer and admin-created bookings.
--
-- Idempotent — safe to re-run. Run BEFORE using the sales portal.

CREATE TABLE IF NOT EXISTS sales_users (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  email       text NOT NULL UNIQUE,
  phone       text, 

  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE sales_users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sales_users FROM anon, authenticated;

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS created_by_user uuid;
CREATE INDEX IF NOT EXISTS idx_bookings_created_by_user ON bookings (created_by_user);
