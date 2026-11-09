-- v110: Incentives — admin-only record of staff incentives and penalties.
--
-- incentive_rates    the client's chart; admins can edit it.
-- incentive_people   which chart group each sales user / installer belongs to.
-- incentive_entries  one row per person per award. rate and person_name are
--                    copied in, so later rate or account changes never alter
--                    history. amount is always qty * rate.
-- incentive_payments the "Paid" tick, per person per month.
--
-- Access: admins and owners only, through is_admin(). Sales users, installers
-- and the public have no access. Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS incentive_rates (
  group_key  text NOT NULL,
  item_type  text NOT NULL CHECK (item_type IN ('non_uv','uv','dispenser','filter_replacement','penalty')),
  rate       numeric(10,2) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_key, item_type)
);

CREATE TABLE IF NOT EXISTS incentive_people (
  person_type text NOT NULL CHECK (person_type IN ('sales','installer')),
  person_id   uuid NOT NULL,
  group_key   text NOT NULL,
  PRIMARY KEY (person_type, person_id)
);

CREATE TABLE IF NOT EXISTS incentive_entries (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date  date NOT NULL,
  person_type text NOT NULL CHECK (person_type IN ('sales','installer')),
  person_id   uuid NOT NULL,
  person_name text NOT NULL,
  group_key   text,
  earned_as   text NOT NULL DEFAULT 'own' CHECK (earned_as IN ('own','referral','demo')),
  item_type   text NOT NULL CHECK (item_type IN ('non_uv','uv','dispenser','filter_replacement','penalty')),
  qty         integer NOT NULL CHECK (qty > 0),
  rate        numeric(10,2) NOT NULL,
  amount      numeric(12,2) GENERATED ALWAYS AS (qty * rate) STORED,
  booking_ref text,
  note        text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incentive_entries_date ON incentive_entries (entry_date);
CREATE INDEX IF NOT EXISTS idx_incentive_entries_person ON incentive_entries (person_type, person_id);

CREATE TABLE IF NOT EXISTS incentive_payments (
  person_type text NOT NULL CHECK (person_type IN ('sales','installer')),
  person_id   uuid NOT NULL,
  month       date NOT NULL,
  amount      numeric(12,2) NOT NULL,
  paid_at     timestamptz NOT NULL DEFAULT now(),
  paid_by     text,
  PRIMARY KEY (person_type, person_id, month)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incentive_rates','incentive_people','incentive_entries','incentive_payments'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin())', t || '_admin', t);
  END LOOP;
END $$;

-- The client's chart. ON CONFLICT keeps any rate an admin has since edited.
INSERT INTO incentive_rates (group_key, item_type, rate) VALUES
  ('lead_handler','non_uv',20),('lead_handler','uv',25),('lead_handler','dispenser',10),
  ('kiosk','non_uv',20),('kiosk','uv',25),('kiosk','dispenser',10),
  ('h2o_installer','non_uv',10),('h2o_installer','uv',15),('h2o_installer','dispenser',10),
  ('h2o_installer','filter_replacement',5),('h2o_installer','penalty',-50),
  ('ho_installer','non_uv',30),('ho_installer','uv',30),('ho_installer','dispenser',10),
  ('installer_referral','non_uv',25),('installer_referral','uv',25),('installer_referral','dispenser',10),
  ('shop','non_uv',30),('shop','uv',35),('shop','dispenser',15),
  ('demo_sale','non_uv',10),('demo_sale','uv',10)
ON CONFLICT (group_key, item_type) DO NOTHING;

-- Starting group for staff whose account matches a name on the chart. Anyone
-- not matched can be assigned from the Incentives > People screen.
INSERT INTO incentive_people (person_type, person_id, group_key)
SELECT 'sales', id, CASE
    WHEN name ILIKE 'fateen%' THEN 'lead_handler'
    WHEN name ILIKE 'ramsid%' OR name ILIKE 'vidhu%' THEN 'kiosk'
    ELSE 'shop' END
FROM sales_users
WHERE name ILIKE 'fateen%' OR name ILIKE 'ramsid%' OR name ILIKE 'vidhu%'
   OR name ILIKE 'basit%' OR name ILIKE 'zayan%' OR name ILIKE 'gaddafi%'
ON CONFLICT DO NOTHING;

INSERT INTO incentive_people (person_type, person_id, group_key)
SELECT 'installer', id, CASE
    WHEN name ILIKE 'roshan%' OR name ILIKE 'zafar%' OR name ILIKE 'faheem%' THEN 'h2o_installer'
    ELSE 'ho_installer' END
FROM installers
WHERE name ILIKE 'roshan%' OR name ILIKE 'zafar%' OR name ILIKE 'faheem%'
   OR name ILIKE 'asfer%' OR name ILIKE 'afser%' OR name ILIKE '%khan%'
   OR name ILIKE 'murshid%' OR name ILIKE 'asim%'
ON CONFLICT DO NOTHING;
