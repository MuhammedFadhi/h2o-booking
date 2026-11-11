-- v114: Group incentives by Save, with an ID such as INC-0001.
--
-- batch_no  shared by every entry saved together in one Add Incentive popup.
--           Shown as INC-0001 on the Entries screen.
--
-- save_incentive_batch(p_batch_no, p_rows)
--   p_batch_no NULL  -> new Save: takes the next number and inserts p_rows.
--   p_batch_no given -> Edit: replaces that Save's entries with p_rows.
--   Runs in one transaction, so a failed Edit never leaves half a Save.
--   Admin only (is_admin()), and RLS still applies.
--
-- Existing entries are numbered by the time they were saved: all rows from
-- one Save share the same created_at, so they get the same number.
--
-- Run after v112 (v113 is the WhatsApp bot file). Idempotent — safe to re-run.

ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS batch_no bigint;
CREATE INDEX IF NOT EXISTS idx_incentive_entries_batch ON incentive_entries (batch_no);

CREATE SEQUENCE IF NOT EXISTS incentive_batch_seq;

WITH saves AS (
  SELECT created_at,
         row_number() OVER (ORDER BY created_at)
           + (SELECT COALESCE(MAX(batch_no), 0) FROM incentive_entries) AS n
  FROM (SELECT DISTINCT created_at FROM incentive_entries WHERE batch_no IS NULL) d
)
UPDATE incentive_entries e SET batch_no = saves.n
FROM saves
WHERE e.created_at = saves.created_at AND e.batch_no IS NULL;

SELECT setval('incentive_batch_seq',
  GREATEST((SELECT MAX(batch_no) FROM incentive_entries), 1),
  (SELECT MAX(batch_no) IS NOT NULL FROM incentive_entries));

CREATE OR REPLACE FUNCTION save_incentive_batch(p_batch_no bigint, p_rows jsonb)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_no bigint := p_batch_no;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Admins only';
  END IF;
  IF jsonb_typeof(p_rows) <> 'array' OR jsonb_array_length(p_rows) = 0 THEN
    RAISE EXCEPTION 'Nothing to save';
  END IF;

  IF v_no IS NULL THEN
    v_no := nextval('incentive_batch_seq');
  ELSE
    DELETE FROM incentive_entries WHERE batch_no = v_no;
  END IF;

  INSERT INTO incentive_entries (
    batch_no, entry_date, end_date, person_type, person_id, person_name, group_key,
    item_type, product_name, qty, rate, percent, base_price, created_by
  )
  SELECT v_no, r.entry_date, r.end_date, r.person_type, r.person_id, r.person_name, r.group_key,
         r.item_type, r.product_name, r.qty, r.rate, r.percent, r.base_price, r.created_by
  FROM jsonb_populate_recordset(NULL::incentive_entries, p_rows) r;

  RETURN v_no;
END $$;

REVOKE ALL ON FUNCTION save_incentive_batch(bigint, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_incentive_batch(bigint, jsonb) TO authenticated;
GRANT USAGE ON SEQUENCE incentive_batch_seq TO authenticated;
