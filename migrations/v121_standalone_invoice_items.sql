-- v121 — Standalone invoices (counter / walk-in sales with no booking).
--
-- Booking invoices take their lines from booking_items. A standalone invoice
-- has no booking, so its lines are stored on the invoice itself:
--   line_items = [{ "description": "RO Purifier", "qty": 1, "unitInclVat": 699 }, ...]
-- unitInclVat is the VAT-inclusive unit price, same as booking_items.unit_price.
--
-- invoices.booking_id is already nullable (v37), so nothing else changes.
-- Idempotent. Run AFTER v112.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS line_items jsonb;

-- Check:
-- SELECT invoice_number, booking_id, line_items FROM invoices WHERE line_items IS NOT NULL;
