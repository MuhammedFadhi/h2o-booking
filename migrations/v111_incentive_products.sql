-- v111: Incentives are recorded per product over a date range.
--
-- product_name  the product chosen in the Add Incentive popup.
-- entry_date    now means the Start Date.
-- end_date      optional; empty means the single day entry_date.
-- period_date   the month an entry counts in: end_date, or entry_date if empty.
-- item_type     gains 'commercial' for the GPD systems, which have no chart rate.
--
-- Run after v110. Idempotent — safe to re-run.

ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS product_name text;
ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS end_date date;
ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS period_date date
  GENERATED ALWAYS AS (COALESCE(end_date, entry_date)) STORED;

ALTER TABLE incentive_entries DROP CONSTRAINT IF EXISTS incentive_entries_item_type_check;
ALTER TABLE incentive_entries ADD CONSTRAINT incentive_entries_item_type_check
  CHECK (item_type IN ('non_uv','uv','dispenser','filter_replacement','penalty','commercial'));

ALTER TABLE incentive_entries DROP CONSTRAINT IF EXISTS incentive_entries_end_after_start;
ALTER TABLE incentive_entries ADD CONSTRAINT incentive_entries_end_after_start
  CHECK (end_date IS NULL OR end_date >= entry_date);

CREATE INDEX IF NOT EXISTS idx_incentive_entries_period ON incentive_entries (period_date);
