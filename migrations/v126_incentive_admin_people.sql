-- v126: admins (and master admins / owners) can get incentives too.
--
-- Many bookings name an office admin as the sales agent (e.g. "Fateen"). Until
-- now only Sales Users and Installers could be picked for an incentive, so those
-- sales earned nothing. This adds a third person type 'admin':
--   * incentive tables accept person_type 'admin'
--   * incentive_admin_people(): the admins/owners list for the picker
--   * a booking's sales agent that is not a Sales User but matches exactly one
--     admin/owner name earns as that admin (Sales Users still come first)
-- Needs v110–v118. Safe to run again. Nothing existing is changed or removed.
--
-- Undo: re-run the recompute_incentive_earnings from v117 and drop
--   incentive_admin_people(), incentive_admin_by_name(text).

-- 1. Allow 'admin' wherever a person type is stored.
DO $$
DECLARE t text; c record;
BEGIN
  FOREACH t IN ARRAY ARRAY['incentive_entries','incentive_people','incentive_payments','incentive_earnings','incentive_payout_lines'] LOOP
    FOR c IN SELECT con.conname FROM pg_constraint con
             WHERE con.conrelid = ('public.' || t)::regclass AND con.contype = 'c'
               AND pg_get_constraintdef(con.oid) ILIKE '%person_type%' LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (person_type IN (''sales'',''installer'',''admin''))', t, t || '_person_type_check');
  END LOOP;
END $$;

-- 2. Admins + owners with their login id (looked up by email if not saved).
CREATE OR REPLACE FUNCTION incentive_admin_list()
RETURNS TABLE (id uuid, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT ON (uid) uid, nm FROM (
    SELECT COALESCE(a.user_id, (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(a.email) LIMIT 1)) AS uid,
           COALESCE(NULLIF(trim(a.name), ''), a.email) AS nm
    FROM admin_emails a
    UNION ALL
    SELECT COALESCE(o.user_id, (SELECT u.id FROM auth.users u WHERE lower(u.email) = lower(o.email) LIMIT 1)),
           COALESCE(NULLIF(trim(o.name), ''), o.email)
    FROM owner_emails o
  ) x WHERE uid IS NOT NULL ORDER BY uid, nm;
$$;
REVOKE ALL ON FUNCTION incentive_admin_list() FROM PUBLIC, anon, authenticated;

-- For the incentive picker (admins only).
CREATE OR REPLACE FUNCTION incentive_admin_people()
RETURNS TABLE (id uuid, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admins only'; END IF;
  RETURN QUERY SELECT l.id, l.name FROM incentive_admin_list() l ORDER BY l.name;
END $$;
REVOKE ALL ON FUNCTION incentive_admin_people() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION incentive_admin_people() TO authenticated;

-- The admin whose name matches a booking's sales agent (exact, one match only).
CREATE OR REPLACE FUNCTION incentive_admin_by_name(p_name text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(l.id::text)::uuid END
  FROM incentive_admin_list() l
  WHERE p_name IS NOT NULL AND lower(trim(l.name)) = lower(trim(p_name));
$$;
REVOKE ALL ON FUNCTION incentive_admin_by_name(text) FROM PUBLIC, anon, authenticated;

-- 3. Same as v117, plus: the seller can be an admin (person_type 'admin', role 'sales').
CREATE OR REPLACE FUNCTION recompute_incentive_earnings(p_booking uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b       bookings%ROWTYPE;
  v_day   date;
  v_agent uuid;
  v_admin uuid;
  v_done  boolean := false;
BEGIN
  DELETE FROM incentive_earnings WHERE booking_id = p_booking AND payout_id IS NULL;
  SELECT * INTO b FROM bookings WHERE id = p_booking;
  IF NOT FOUND THEN RETURN; END IF;

  IF b.status = 'completed' THEN
    v_day := COALESCE((b.completed_at AT TIME ZONE 'Asia/Riyadh')::date, b.slot_date);
    v_done := v_day IS NOT NULL;
    v_agent := COALESCE(b.sales_agent_id,
      CASE WHEN b.sales_agent IS NULL THEN (SELECT s.id FROM sales_users s WHERE s.id = b.created_by_user) END);
    IF v_agent IS NULL THEN v_admin := incentive_admin_by_name(b.sales_agent); END IF;
  END IF;

  WITH raw AS (
    SELECT bi.product_model AS model, bi.qty FROM booking_items bi WHERE bi.booking_id = p_booking AND v_done
    UNION ALL
    SELECT b.product_model, COALESCE(b.product_qty, 1)
    WHERE v_done AND b.product_model IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = p_booking)
  ), items AS (
    SELECT incentive_product_name(model) AS product, sum(qty)::int AS qty
    FROM raw WHERE model IS NOT NULL GROUP BY 1
  ), who AS (
    SELECT 'sales'::text AS role, 'sales'::text AS ptype, v_agent AS pid WHERE v_done AND v_agent IS NOT NULL
    UNION ALL
    SELECT 'sales', 'admin', v_admin WHERE v_done AND v_admin IS NOT NULL
    UNION ALL
    SELECT 'installer', 'installer', b.installer_id WHERE v_done AND b.installer_id IS NOT NULL
  ), desired AS (
    SELECT DISTINCT ON (w.role, i.product)
           e.batch_no, w.role, e.person_type, e.person_id, e.person_name, i.product, i.qty, e.rate
    FROM who w
    CROSS JOIN items i
    JOIN incentive_entries e
      ON e.person_type = w.ptype AND e.person_id = w.pid AND e.product_name = i.product
     AND e.batch_no IS NOT NULL AND e.end_date IS NOT NULL
     AND v_day BETWEEN e.entry_date AND e.end_date
     AND e.rate > 0 AND i.qty > 0
    ORDER BY w.role, i.product, e.batch_no DESC
  ), paid AS (
    SELECT role, person_type, person_id, max(person_name) AS person_name, product_name AS product,
           max(batch_no) AS batch_no, sum(amount) AS amt
    FROM incentive_earnings
    WHERE booking_id = p_booking AND payout_id IS NOT NULL
    GROUP BY role, person_type, person_id, product_name
  )
  INSERT INTO incentive_earnings (booking_id, batch_no, role, person_type, person_id, person_name, product_name, qty, rate, earned_on, adjustment)
  SELECT p_booking, d.batch_no, d.role, d.person_type, d.person_id, d.person_name, d.product, d.qty, d.rate, v_day, false
  FROM desired d
  WHERE NOT EXISTS (SELECT 1 FROM paid p WHERE p.role = d.role AND p.person_id = d.person_id AND p.product = d.product)
  UNION ALL
  SELECT p_booking, COALESCE(d.batch_no, p.batch_no), p.role, p.person_type, p.person_id, p.person_name, p.product, 1,
         COALESCE(d.qty * d.rate, 0) - p.amt,
         COALESCE(v_day, (now() AT TIME ZONE 'Asia/Riyadh')::date), true
  FROM paid p
  LEFT JOIN desired d ON d.role = p.role AND d.person_id = p.person_id AND d.product = p.product
  WHERE COALESCE(d.qty * d.rate, 0) - p.amt <> 0;
END $$;
