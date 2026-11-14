-- Undo v117 (incentive payouts). Run in the SQL editor, then re-run
-- migrations/v116_incentive_auto_earnings.sql to restore its calculation.
-- WARNING: deletes all payout records. Earnings become unpaid again.

DROP FUNCTION IF EXISTS create_incentive_payout(jsonb, date, text, text);
DROP FUNCTION IF EXISTS cancel_incentive_payout(bigint);
DROP VIEW IF EXISTS incentive_balances;
DROP TRIGGER IF EXISTS trg_bookings_incentive_delete ON bookings;
DROP FUNCTION IF EXISTS trg_bookings_incentive_delete();

ALTER TABLE incentive_earnings DROP COLUMN IF EXISTS payout_id;
ALTER TABLE incentive_earnings DROP COLUMN IF EXISTS adjustment;
DROP TABLE IF EXISTS incentive_payout_lines;
DROP TABLE IF EXISTS incentive_payouts;
DROP SEQUENCE IF EXISTS incentive_payout_seq;

DELETE FROM incentive_earnings WHERE booking_id IS NULL;
ALTER TABLE incentive_earnings DROP CONSTRAINT IF EXISTS incentive_earnings_booking_id_fkey;
ALTER TABLE incentive_earnings ADD CONSTRAINT incentive_earnings_booking_id_fkey
  FOREIGN KEY (booking_id) REFERENCES bookings(id) ON DELETE CASCADE;
ALTER TABLE incentive_earnings ALTER COLUMN booking_id SET NOT NULL;
