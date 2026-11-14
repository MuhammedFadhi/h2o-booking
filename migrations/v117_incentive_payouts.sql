-- v117: Pay Out incentives without losing history.
--
-- incentive_payouts       one row per payment (PAY-0001): date, cash/bank,
--                         note, total, who paid, and cancellation if undone.
-- incentive_payout_lines  how much each person got in that payment.
-- incentive_earnings      + payout_id (which payment paid it; empty = unpaid)
--                         + adjustment (true for a correction row).
-- incentive_balances      view: earned / paid / balance due per person.
--
-- Paid incentives are locked. If a paid booking later changes (un-completed,
-- other installer, other products), the paid rows stay and a correction row
-- (+ or -) is added to the person's unpaid balance instead.
-- A paid incentive also survives if its booking is deleted.
--
-- create_incentive_payout(people, paid_on, method, note) -> payout number
-- cancel_incentive_payout(payout_no)  -> its incentives become unpaid again
--
-- Undo: deploy-notes/v117_incentive_payouts_undo.sql
-- Run after v116_incentive_auto_earnings.sql. Idempotent — safe to re-run.

-- 1. Tables ----------------------------------------------------------------------

CREATE SEQUENCE IF NOT EXISTS incentive_payout_seq;

CREATE TABLE IF NOT EXISTS incentive_payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_no    bigint NOT NULL UNIQUE DEFAULT nextval('incentive_payout_seq'),
  paid_on      date NOT NULL,
  method       text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','bank')),
  note         text,
  amount       numeric(12,2) NOT NULL,
  paid_by      text,
  cancelled_at timestamptz,
  cancelled_by text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS incentive_payout_lines (
  payout_id   uuid NOT NULL REFERENCES incentive_payouts(id) ON DELETE CASCADE,
  person_type text NOT NULL CHECK (person_type IN ('sales','installer')),
  person_id   uuid NOT NULL,
  person_name text,
  amount      numeric(12,2) NOT NULL,
  PRIMARY KEY (payout_id, person_type, person_id)
);

ALTER TABLE incentive_earnings ADD COLUMN IF NOT EXISTS payout_id uuid REFERENCES incentive_payouts(id) ON DELETE SET NULL;
ALTER TABLE incentive_earnings ADD COLUMN IF NOT EXISTS adjustment boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_incentive_earnings_payout ON incentive_earnings (payout_id);
CREATE INDEX IF NOT EXISTS idx_incentive_earnings_person ON incentive_earnings (person_type, person_id);

-- Keep paid history when a booking is deleted (unpaid rows go, see trigger below).
ALTER TABLE incentive_earnings ALTER COLUMN booking_id DROP NOT NULL;
ALTER TABLE incentive_earnings DROP CONSTRAINT IF EXISTS incentive_earnings_booking_id_fkey;
ALTER TABLE incentive_earnings ADD CONSTRAINT incentive_earnings_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION trg_bookings_incentive_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM incentive_earnings WHERE booking_id = OLD.id AND payout_id IS NULL;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_bookings_incentive_delete ON bookings;
CREATE TRIGGER trg_bookings_incentive_delete
  BEFORE DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION trg_bookings_incentive_delete();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['incentive_payouts','incentive_payout_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON %I FROM anon', t);
    EXECUTE format('GRANT SELECT ON %I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', t || '_admin', t);
    EXECUTE format('CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (public.is_admin())', t || '_admin', t);
  END LOOP;
END $$;

CREATE OR REPLACE VIEW incentive_balances WITH (security_invoker = true) AS
SELECT person_type, person_id, max(person_name) AS person_name,
       COALESCE(sum(amount), 0) AS earned,
       COALESCE(sum(amount) FILTER (WHERE payout_id IS NOT NULL), 0) AS paid,
       COALESCE(sum(amount) FILTER (WHERE payout_id IS NULL), 0) AS balance
FROM incentive_earnings
GROUP BY person_type, person_id;

REVOKE ALL ON incentive_balances FROM anon;
GRANT SELECT ON incentive_balances TO authenticated;

-- 2. Calculation that never touches paid rows ------------------------------------

CREATE OR REPLACE FUNCTION recompute_incentive_earnings(p_booking uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  b       bookings%ROWTYPE;
  v_day   date;
  v_agent uuid;
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
    SELECT 'sales'::text AS role, v_agent AS pid WHERE v_done AND v_agent IS NOT NULL
    UNION ALL
    SELECT 'installer', b.installer_id WHERE v_done AND b.installer_id IS NOT NULL
  ), desired AS (
    SELECT DISTINCT ON (w.role, i.product)
           e.batch_no, w.role, e.person_type, e.person_id, e.person_name, i.product, i.qty, e.rate
    FROM who w
    CROSS JOIN items i
    JOIN incentive_entries e
      ON e.person_type = w.role AND e.person_id = w.pid AND e.product_name = i.product
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

-- 3. Pay out and cancel -----------------------------------------------------------

CREATE OR REPLACE FUNCTION create_incentive_payout(p_people jsonb, p_paid_on date, p_method text, p_note text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_no bigint; v_total numeric;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admins only'; END IF;
  IF p_paid_on IS NULL THEN RAISE EXCEPTION 'Paid date is required'; END IF;
  IF jsonb_typeof(p_people) <> 'array' OR jsonb_array_length(p_people) = 0 THEN RAISE EXCEPTION 'Select at least one person'; END IF;

  CREATE TEMP TABLE IF NOT EXISTS _inc_pay_people (person_type text, person_id uuid) ON COMMIT DROP;
  TRUNCATE _inc_pay_people;
  INSERT INTO _inc_pay_people SELECT DISTINCT x.person_type, x.person_id
  FROM jsonb_to_recordset(p_people) AS x(person_type text, person_id uuid);

  PERFORM 1 FROM incentive_earnings e
  WHERE e.payout_id IS NULL AND (e.person_type, e.person_id) IN (SELECT person_type, person_id FROM _inc_pay_people)
  FOR UPDATE;

  SELECT sum(t) INTO v_total FROM (
    SELECT sum(e.amount) AS t FROM incentive_earnings e
    WHERE e.payout_id IS NULL AND (e.person_type, e.person_id) IN (SELECT person_type, person_id FROM _inc_pay_people)
    GROUP BY e.person_type, e.person_id HAVING sum(e.amount) > 0
  ) s;
  IF v_total IS NULL THEN RAISE EXCEPTION 'Nothing to pay for the selected people'; END IF;

  INSERT INTO incentive_payouts (paid_on, method, note, amount, paid_by)
  VALUES (p_paid_on, COALESCE(NULLIF(p_method, ''), 'cash'), NULLIF(btrim(p_note), ''), v_total, auth.jwt() ->> 'email')
  RETURNING id, payout_no INTO v_id, v_no;

  INSERT INTO incentive_payout_lines (payout_id, person_type, person_id, person_name, amount)
  SELECT v_id, e.person_type, e.person_id, max(e.person_name), sum(e.amount)
  FROM incentive_earnings e
  WHERE e.payout_id IS NULL AND (e.person_type, e.person_id) IN (SELECT person_type, person_id FROM _inc_pay_people)
  GROUP BY e.person_type, e.person_id HAVING sum(e.amount) > 0;

  UPDATE incentive_earnings e SET payout_id = v_id
  FROM incentive_payout_lines l
  WHERE l.payout_id = v_id AND e.person_type = l.person_type AND e.person_id = l.person_id AND e.payout_id IS NULL;

  RETURN v_no;
END $$;

CREATE OR REPLACE FUNCTION cancel_incentive_payout(p_payout_no bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid; v_bookings uuid[]; v_b uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'Admins only'; END IF;
  SELECT id INTO v_id FROM incentive_payouts WHERE payout_no = p_payout_no AND cancelled_at IS NULL FOR UPDATE;
  IF v_id IS NULL THEN RAISE EXCEPTION 'Payout not found or already cancelled'; END IF;

  SELECT array_agg(DISTINCT booking_id) INTO v_bookings
  FROM incentive_earnings WHERE payout_id = v_id AND booking_id IS NOT NULL;

  UPDATE incentive_payouts SET cancelled_at = now(), cancelled_by = auth.jwt() ->> 'email' WHERE id = v_id;
  UPDATE incentive_earnings SET payout_id = NULL WHERE payout_id = v_id;

  -- Rebuild those bookings, so correction rows match what is still paid.
  FOREACH v_b IN ARRAY COALESCE(v_bookings, ARRAY[]::uuid[]) LOOP
    PERFORM recompute_incentive_earnings(v_b);
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION create_incentive_payout(jsonb, date, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION create_incentive_payout(jsonb, date, text, text) TO authenticated;
REVOKE ALL ON FUNCTION cancel_incentive_payout(bigint) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION cancel_incentive_payout(bigint) TO authenticated;
