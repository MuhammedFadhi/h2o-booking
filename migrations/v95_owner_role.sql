-- v95: Owner role — same full access as Admin, just a separate identity/label.
--
-- Mirrors admin_emails exactly (allowlist table + self-read-only RLS policy;
-- all writes go through the service-role-only /api/admin/user-ops). is_admin()
-- now also recognizes owner_emails, so every existing RLS policy and every
-- is_admin() check (client RPC + the server-side requireAdmin()) already
-- covers owners too — no other policy needs to change.

CREATE TABLE IF NOT EXISTS owner_emails (
  email text PRIMARY KEY,
  name text,
  user_id uuid,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE owner_emails ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_emails_self ON owner_emails;
CREATE POLICY owner_emails_self ON owner_emails FOR SELECT TO authenticated
  USING (email = auth.jwt() ->> 'email');

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM admin_emails WHERE email = auth.jwt() ->> 'email'
  ) OR EXISTS (
    SELECT 1 FROM owner_emails WHERE email = auth.jwt() ->> 'email'
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated;
