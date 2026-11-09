-- Removes the Incentives module's tables and ALL incentive data in them.
-- Only run this if the module is being removed.
DROP TABLE IF EXISTS incentive_payments;
DROP TABLE IF EXISTS incentive_entries;
DROP TABLE IF EXISTS incentive_people;
DROP TABLE IF EXISTS incentive_rates;
