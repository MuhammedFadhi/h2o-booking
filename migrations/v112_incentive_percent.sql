-- v112: An incentive amount can be entered as a % of a product's price.
--
-- percent     the % admin typed; empty means a plain SAR amount.
-- base_price  the product price that % was taken from.
--
-- The final SAR value is still saved in rate/amount, so a later product price
-- change never alters an old incentive or a monthly total.
--
-- Run after v111. Idempotent — safe to re-run.

ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS percent numeric;
ALTER TABLE incentive_entries ADD COLUMN IF NOT EXISTS base_price numeric;

ALTER TABLE incentive_entries DROP CONSTRAINT IF EXISTS incentive_entries_percent_check;
ALTER TABLE incentive_entries ADD CONSTRAINT incentive_entries_percent_check
  CHECK (
    (percent IS NULL AND base_price IS NULL)
    OR (percent > 0 AND percent <= 100 AND base_price > 0)
  );
