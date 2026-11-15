-- v116: Incentives are earned automatically from completed bookings.
--
-- A Save on the Incentives page is now a RULE: these people, these products,
-- From..To (both required), amount per unit sold (SAR, or % already turned
-- into SAR from the list price when the rule was saved).
--
-- When a booking is Completed, its sales agent and its installer each earn
-- rule.rate x qty for every product in a matching rule. The day checked
-- against From..To is the completion day in Saudi time (slot_date if a
-- booking has no completed_at). If two rules overlap, the newest one counts.
-- Earnings are recalculated when a booking is completed, un-completed, its
-- agent/installer/products change, or a rule is saved or deleted.
--
--   bookings.sales_agent_id   account of the sales agent. Filled from the
--                             sales_agent name (exact, unique match).
--   incentive_earnings        one row per booking x role x product earned.
--   incentive_product_name()  links old/colour spellings to the 7 products.
--
-- Run after v114 (v115 is the WhatsApp conversation lock file). Idempotent — safe to re-run.

-- 1. Sales agent account -------------------------------------------------------

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS sales_agent_id uuid;

CREATE OR REPLACE FUNCTION incentive_sales_user_by_name(p_name text)
RETURNS uuid LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT CASE WHEN count(*) = 1 THEN min(id::text)::uuid END
  FROM sales_users
  WHERE p_name IS NOT NULL AND lower(btrim(name)) = lower(btrim(p_name));
$$;

CREATE OR REPLACE FUNCTION bookings_set_sales_agent_id()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  NEW.sales_agent_id := incentive_sales_user_by_name(NULLIF(btrim(NEW.sales_agent), ''));
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_bookings_sales_agent_id ON bookings;
CREATE TRIGGER trg_bookings_sales_agent_id
  BEFORE INSERT OR UPDATE OF sales_agent ON bookings
  FOR EACH ROW EXECUTE FUNCTION bookings_set_sales_agent_id();

UPDATE bookings b SET sales_agent_id = incentive_sales_user_by_name(b.sales_agent)
WHERE b.sales_agent IS NOT NULL
  AND b.sales_agent_id IS DISTINCT FROM incentive_sales_user_by_name(b.sales_agent);

-- 2. Product names -------------------------------------------------------------
-- Drops a colour suffix ("... — Black") and links old names to the 7 products.

CREATE OR REPLACE FUNCTION incentive_product_name(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE lower(btrim(split_part(p, ' — ', 1)))
    WHEN '7-stage ro purifier'      THEN '7 stage RO - A100'
    WHEN 'a100'                     THEN '7 stage RO - A100'
    WHEN '7-stage ro purifier + uv' THEN '7 stage RO - A1UV'
    WHEN 'a1uv'                     THEN '7 stage RO - A1UV'
    ELSE btrim(split_part(p, ' — ', 1))
  END;
$$;

-- 3. Earnings ------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS incentive_earnings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id   uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  batch_no     bigint,
  role         text NOT NULL CHECK (role IN ('sales','installer')),
  person_type  text NOT NULL CHECK (person_type IN ('sales','installer')),
  person_id    uuid NOT NULL,
  person_name  text,
  product_name text NOT NULL,
  qty          integer NOT NULL CHECK (qty > 0),
  rate         numeric(10,2) NOT NULL,
  amount       numeric(12,2) GENERATED ALWAYS AS (qty * rate) STORED,
  earned_on    date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_incentive_earnings_booking ON incentive_earnings (booking_id);
CREATE INDEX IF NOT EXISTS idx_incentive_earnings_day ON incentive_earnings (earned_on);
CREATE INDEX IF NOT EXISTS idx_incentive_earnings_batch ON incentive_earnings (batch_no);

ALTER TABLE incentive_earnings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON incentive_earnings FROM anon;
GRANT SELECT ON incentive_earnings TO authenticated;
DROP POLICY IF EXISTS incentive_earnings_admin ON incentive_earnings;
CREATE POLICY incentive_earnings_admin ON incentive_earnings
  FOR SELECT TO authenticated USING (public.is_admin());

-- 4. Calculation ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION recompute_incentive_earnings(p_booking uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b       bookings%ROWTYPE;
  v_day   date;
  v_agent uuid;
BEGIN
  DELETE FROM incentive_earnings WHERE booking_id = p_booking;
  SELECT * INTO b FROM bookings WHERE id = p_booking;
  IF NOT FOUND OR b.status IS DISTINCT FROM 'completed' THEN RETURN; END IF;

  v_day := COALESCE((b.completed_at AT TIME ZONE 'Asia/Riyadh')::date, b.slot_date);
  IF v_day IS NULL THEN RETURN; END IF;
  -- No agent picked: a booking made in the Sales portal belongs to its creator.
  v_agent := COALESCE(b.sales_agent_id,
    CASE WHEN b.sales_agent IS NULL THEN (SELECT s.id FROM sales_users s WHERE s.id = b.created_by_user) END);

  WITH raw AS (
    SELECT bi.product_model AS model, bi.qty FROM booking_items bi WHERE bi.booking_id = p_booking
    UNION ALL
    SELECT b.product_model, COALESCE(b.product_qty, 1)
    WHERE b.product_model IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM booking_items bi WHERE bi.booking_id = p_booking)
  ), items AS (
    SELECT incentive_product_name(model) AS product, sum(qty)::int AS qty
    FROM raw WHERE model IS NOT NULL GROUP BY 1
  ), who AS (
    SELECT 'sales'::text AS role, v_agent AS pid WHERE v_agent IS NOT NULL
    UNION ALL
    SELECT 'installer', b.installer_id WHERE b.installer_id IS NOT NULL
  )
  INSERT INTO incentive_earnings (booking_id, batch_no, role, person_type, person_id, person_name, product_name, qty, rate, earned_on)
  SELECT DISTINCT ON (w.role, i.product)
         p_booking, e.batch_no, w.role, e.person_type, e.person_id, e.person_name, i.product, i.qty, e.rate, v_day
  FROM who w
  CROSS JOIN items i
  JOIN incentive_entries e
    ON e.person_type = w.role AND e.person_id = w.pid AND e.product_name = i.product
   AND e.batch_no IS NOT NULL AND e.end_date IS NOT NULL
   AND v_day BETWEEN e.entry_date AND e.end_date
   AND e.rate > 0 AND i.qty > 0
  ORDER BY w.role, i.product, e.batch_no DESC;
END $$;

REVOKE ALL ON FUNCTION recompute_incentive_earnings(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION recompute_incentive_earnings(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION trg_bookings_incentive_earnings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'completed' OR (TG_OP = 'UPDATE' AND OLD.status = 'completed') THEN
    PERFORM recompute_incentive_earnings(NEW.id);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_bookings_incentive_earnings ON bookings;
CREATE TRIGGER trg_bookings_incentive_earnings
  AFTER INSERT OR UPDATE OF status, completed_at, slot_date, installer_id, sales_agent, sales_agent_id, product_model, product_qty
  ON bookings FOR EACH ROW EXECUTE FUNCTION trg_bookings_incentive_earnings();

CREATE OR REPLACE FUNCTION trg_booking_items_incentive_earnings()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_booking uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN v_booking := OLD.booking_id; ELSE v_booking := NEW.booking_id; END IF;
  IF EXISTS (SELECT 1 FROM bookings WHERE id = v_booking AND status = 'completed')
     OR EXISTS (SELECT 1 FROM incentive_earnings WHERE booking_id = v_booking) THEN
    PERFORM recompute_incentive_earnings(v_booking);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_booking_items_incentive_earnings ON booking_items;
CREATE TRIGGER trg_booking_items_incentive_earnings
  AFTER INSERT OR UPDATE OR DELETE ON booking_items
  FOR EACH ROW EXECUTE FUNCTION trg_booking_items_incentive_earnings();

-- 5. Saving and deleting rules -------------------------------------------------
-- Same as v114, plus: To is required, and completed bookings in the old and
-- new date range are recalculated.

CREATE OR REPLACE FUNCTION incentive_recompute_range(p_from date, p_to date)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL THEN RETURN; END IF;
  PERFORM recompute_incentive_earnings(id) FROM bookings
  WHERE status = 'completed'
    AND COALESCE((completed_at AT TIME ZONE 'Asia/Riyadh')::date, slot_date) BETWEEN p_from AND p_to;
END $$;

REVOKE ALL ON FUNCTION incentive_recompute_range(date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION incentive_recompute_range(date, date) TO authenticated;

CREATE OR REPLACE FUNCTION save_incentive_batch(p_batch_no bigint, p_rows jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_no bigint := p_batch_no;
  v_old_from date; v_old_to date; v_from date; v_to date;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admins only';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Nothing to save';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_rows) r WHERE NULLIF(r->>'end_date', '') IS NULL) THEN
    RAISE EXCEPTION 'To date is required';
  END IF;

  IF v_no IS NULL THEN
    v_no := nextval('incentive_batch_seq');
  ELSE
    SELECT min(entry_date), max(COALESCE(end_date, entry_date)) INTO v_old_from, v_old_to
    FROM incentive_entries WHERE batch_no = v_no;
    DELETE FROM incentive_entries WHERE batch_no = v_no;
  END IF;

  INSERT INTO incentive_entries (
    batch_no, entry_date, end_date, person_type, person_id, person_name, group_key,
    item_type, product_name, qty, rate, percent, base_price, created_by
  )
  SELECT v_no, r.entry_date, r.end_date, r.person_type, r.person_id, r.person_name, r.group_key,
         r.item_type, r.product_name, r.qty, r.rate, r.percent, r.base_price, r.created_by
  FROM jsonb_populate_recordset(NULL::incentive_entries, p_rows) r;

  SELECT min(entry_date), max(end_date) INTO v_from, v_to FROM incentive_entries WHERE batch_no = v_no;
  PERFORM incentive_recompute_range(LEAST(v_from, COALESCE(v_old_from, v_from)), GREATEST(v_to, COALESCE(v_old_to, v_to)));

  RETURN v_no;
END $$;

CREATE OR REPLACE FUNCTION delete_incentive_batch(p_batch_no bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE v_from date; v_to date;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admins only';
  END IF;
  SELECT min(entry_date), max(COALESCE(end_date, entry_date)) INTO v_from, v_to
  FROM incentive_entries WHERE batch_no = p_batch_no;
  DELETE FROM incentive_entries WHERE batch_no = p_batch_no;
  PERFORM incentive_recompute_range(v_from, v_to);
END $$;

REVOKE ALL ON FUNCTION save_incentive_batch(bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_incentive_batch(bigint, jsonb) TO authenticated;
REVOKE ALL ON FUNCTION delete_incentive_batch(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION delete_incentive_batch(bigint) TO authenticated;

-- 6. Calculate for bookings already completed ------------------------------------

SELECT count(*) AS completed_bookings_checked
FROM (SELECT recompute_incentive_earnings(id) FROM bookings WHERE status = 'completed') x;
