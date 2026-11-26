-- v129: "No invoice needed" on a booking.
--
-- A finished job (installed / serviced) normally waits in the Invoices page's
-- Pending tab until it is invoiced. Free visits — warranty filter changes, AMC
-- visits, goodwill/FOC repairs, inspections — never get an invoice, so the
-- office marks them "No invoice needed" with a reason and they leave Pending.
--
-- Only ADDS nullable columns (plus one boolean with a default) — no data is
-- changed or removed. Safe to run twice.

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_not_needed        boolean NOT NULL DEFAULT false;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_not_needed_reason text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_not_needed_note   text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_not_needed_by     text;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS invoice_not_needed_at     timestamptz;
