-- =============================================================================
-- SA'DA H2O — v27  Warranty CRM schema
--
-- Ports the standalone PHP/MySQL warranty CRM (h2o.sadawater.com/regis/) into
-- this Supabase project. Structure mirrors the original 1:1 — same columns,
-- same names, same 90/365/730-day rules. Only forced changes:
--
--   users.id (int)      → customers.id (uuid)   — merged on normalized phone
--   product_id          → qr_code               — clearer; it IS the QR sticker
--   products            → product_models        — 'products' is too generic here
--   service_history     → warranty_service_history
--   followups.created_by/assigned_to (int FK → users) → text (admin email)
--                         the old users table is gone; admins live in
--                         admin_emails + auth.users now.
--
-- Idempotent. Safe to re-run. No SMS/relay changes.
-- Run BEFORE v27_warranty_data.sql.
-- =============================================================================

-- 1) product_models -----------------------------------------------------------
--    Was `products`. Joined by name (not FK), exactly as the original did, so
--    that importing an unknown model auto-creates it.
CREATE TABLE IF NOT EXISTS product_models (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_name  text NOT NULL UNIQUE,     -- was products.product_type
  image_url   text,                     -- was products.product_image
  description text,
  created_at  timestamptz DEFAULT now()
);


-- 2) warranties ---------------------------------------------------------------
--    One row per physical unit. A customer may have many — each unit carries
--    its own QR sticker, so qr_code is NOT NULL UNIQUE (as the original).
CREATE TABLE IF NOT EXISTS warranties (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  qr_code           text NOT NULL UNIQUE,   -- was product_id, e.g. A100042687234
  product_type      text NOT NULL,          -- → product_models.model_name
  client_code       text,                   -- legacy field numbering, e.g. KBR0012
  quantity          integer NOT NULL DEFAULT 1,
  registration_date date NOT NULL,
  filter_expiry     timestamptz,            -- +90d,  pushed by a 'filter' job
  service_expiry    timestamptz,            -- +365d, pushed by a 'service' job
  warranty_expiry   timestamptz,            -- +730d, never pushed
  legacy_id         integer,                -- old MySQL warranties.id, traceability
  created_at        timestamptz DEFAULT now(),
  updated_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warranties_customer_idx ON warranties(customer_id);
CREATE INDEX IF NOT EXISTS warranties_qr_idx       ON warranties(qr_code);
CREATE INDEX IF NOT EXISTS warranties_legacy_idx   ON warranties(legacy_id);


-- 3) warranty_service_history -------------------------------------------------
CREATE TABLE IF NOT EXISTS warranty_service_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warranty_id  uuid NOT NULL REFERENCES warranties(id) ON DELETE CASCADE,
  service_type text NOT NULL CHECK (service_type IN ('activation','filter','service','other')),
  notes        text,
  created_at   timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS wsh_warranty_idx ON warranty_service_history(warranty_id);


-- 4) customer_followups -------------------------------------------------------
--    INTERNAL SALES NOTES. Contains lines like "Said 'we will manage ourselves'"
--    and "Arab who is near showroom." The customer must NEVER see these.
--    RLS below is admin-only — no anon access of any kind.
CREATE TABLE IF NOT EXISTS customer_followups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  followup_date date NOT NULL,
  note          text NOT NULL,
  created_by    text,              -- admin email (was int FK → users)
  assigned_to   text,              -- admin email (was int FK → users)
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done')),
  created_at    timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followups_customer_idx ON customer_followups(customer_id);
CREATE INDEX IF NOT EXISTS followups_date_idx     ON customer_followups(followup_date);


-- 5) bookings → warranties link ----------------------------------------------
--    Nullable, no UI yet. Lets a future service/filter booking name the unit
--    it's for. Today every booking is booking_type='installation' and no
--    customer has two units, so nothing needs to set this.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS warranty_id uuid
  REFERENCES warranties(id) ON DELETE SET NULL;


-- 6) updated_at maintenance ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_warranties_touch ON warranties;
CREATE TRIGGER trg_warranties_touch
  BEFORE UPDATE ON warranties
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


-- 7) Anon claim guard ---------------------------------------------------------
--    When a customer claims a QR from the claim page they are `anon` (there is
--    no customer session token in this app — see the v26 audit note). So anon
--    must be able to INSERT. This trigger makes that safe by ignoring whatever
--    the client sent for the commercially meaningful fields and computing them
--    server-side, exactly like the PHP's calculateExpiries() did.
--
--    Result: an anon claim can only ever create a warranty registered TODAY
--    with standard 90/365/730 terms and quantity 1. No forging a 10-year
--    warranty by editing the POST body.
CREATE OR REPLACE FUNCTION public.guard_anon_warranty_insert()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'anon' THEN
    RETURN NEW;   -- admin path: trusted, set whatever
  END IF;
  NEW.registration_date := CURRENT_DATE;
  NEW.filter_expiry     := (CURRENT_DATE + INTERVAL '90 days');
  NEW.service_expiry    := (CURRENT_DATE + INTERVAL '365 days');
  NEW.warranty_expiry   := (CURRENT_DATE + INTERVAL '730 days');
  NEW.quantity          := 1;
  NEW.client_code       := NULL;
  NEW.legacy_id         := NULL;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_anon_warranty ON warranties;
CREATE TRIGGER trg_guard_anon_warranty
  BEFORE INSERT ON warranties
  FOR EACH ROW EXECUTE FUNCTION public.guard_anon_warranty_insert();


-- 8) Anon may not mutate a warranty once created ------------------------------
CREATE OR REPLACE FUNCTION public.guard_anon_warranty_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'anon' THEN
    RAISE EXCEPTION 'anon may not modify a warranty';
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_guard_anon_warranty_upd ON warranties;
CREATE TRIGGER trg_guard_anon_warranty_upd
  BEFORE UPDATE ON warranties
  FOR EACH ROW EXECUTE FUNCTION public.guard_anon_warranty_update();


-- 9) Auto-log the activation row ----------------------------------------------
--    The PHP inserted this by hand after every registration. Doing it in a
--    trigger means anon never needs INSERT rights on the history table.
--    SECURITY DEFINER so it runs regardless of the caller's grants.
CREATE OR REPLACE FUNCTION public.log_warranty_activation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
BEGIN
  -- The bulk data import supplies its own history rows; skip those.
  IF NEW.legacy_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO warranty_service_history (warranty_id, service_type, notes)
  VALUES (NEW.id, 'activation', 'Initial product activation and registration');
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_log_warranty_activation ON warranties;
CREATE TRIGGER trg_log_warranty_activation
  AFTER INSERT ON warranties
  FOR EACH ROW EXECUTE FUNCTION public.log_warranty_activation();


-- =============================================================================
-- RLS — follows the v26 posture exactly.
-- =============================================================================

-- product_models: public read (customers see model image + description), admin writes
ALTER TABLE product_models ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS product_models_anon_read   ON product_models;
DROP POLICY IF EXISTS product_models_authed_read ON product_models;
DROP POLICY IF EXISTS product_models_admin_all   ON product_models;

CREATE POLICY product_models_anon_read   ON product_models FOR SELECT TO anon          USING (TRUE);
CREATE POLICY product_models_authed_read ON product_models FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY product_models_admin_all   ON product_models FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());


-- warranties:
--   SELECT anon — required by the claim page ("is this QR taken?") before any
--                 login, and by the portal's My Units tab. Matches the existing
--                 posture on bookings/customers. Known caveat, same as v26:
--                 without customer session tokens this is readable by anyone
--                 with the anon key. Closing it needs customer JWTs — a
--                 separate piece of work, flagged but not in scope here.
--   INSERT anon — the claim. Neutered by the trigger above.
--   UPDATE/DELETE anon — blocked.
ALTER TABLE warranties ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS warranties_anon_read   ON warranties;
DROP POLICY IF EXISTS warranties_anon_insert ON warranties;
DROP POLICY IF EXISTS warranties_authed_read ON warranties;
DROP POLICY IF EXISTS warranties_admin_all   ON warranties;

CREATE POLICY warranties_anon_read   ON warranties FOR SELECT TO anon          USING (TRUE);
CREATE POLICY warranties_authed_read ON warranties FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY warranties_anon_insert ON warranties FOR INSERT TO anon          WITH CHECK (TRUE);
CREATE POLICY warranties_admin_all   ON warranties FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());


-- warranty_service_history: read-only for anon (portal timeline), admin writes
ALTER TABLE warranty_service_history ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS wsh_anon_read   ON warranty_service_history;
DROP POLICY IF EXISTS wsh_authed_read ON warranty_service_history;
DROP POLICY IF EXISTS wsh_admin_all   ON warranty_service_history;

CREATE POLICY wsh_anon_read   ON warranty_service_history FOR SELECT TO anon          USING (TRUE);
CREATE POLICY wsh_authed_read ON warranty_service_history FOR SELECT TO authenticated USING (TRUE);
CREATE POLICY wsh_admin_all   ON warranty_service_history FOR ALL    TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());


-- customer_followups: ADMIN ONLY. No anon policy at all — internal sales notes.
ALTER TABLE customer_followups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS followups_admin_all ON customer_followups;
DROP POLICY IF EXISTS followups_anon_read ON customer_followups;

REVOKE ALL ON customer_followups FROM anon;

CREATE POLICY followups_admin_all ON customer_followups FOR ALL TO authenticated
  USING (is_admin()) WITH CHECK (is_admin());
