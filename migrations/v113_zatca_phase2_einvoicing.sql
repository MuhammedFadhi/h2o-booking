-- =============================================================================
-- SA'DA H2O — v113  ZATCA Phase-2 (Integration) e-invoicing
--
-- Phase 2 signs each invoice (UBL 2.1 + ECDSA secp256k1), stamps a 9-tag QR, and
-- REPORTS simplified/B2C invoices to ZATCA (within 24h). The signing itself runs
-- in the zatca-relay service (holds the private key); this migration adds the
-- columns that record the outcome, plus the hash-chain primitives (ICV + PIH).
--
-- Idempotent. Run AFTER v112.
-- =============================================================================

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_uuid       uuid;      -- UBL cbc:UUID
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_icv        bigint;    -- Invoice Counter Value (monotonic)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_pih        text;      -- Previous Invoice Hash (chain)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_hash       text;      -- this invoice's hash (becomes next PIH)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_status     text;      -- pending|reported|cleared|failed
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zatca_qr            text;      -- Phase-2 Base64 TLV QR (9 tags)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS einvoice_response   jsonb;     -- raw ZATCA reporting/clearance result
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS zatca_submitted_at  timestamptz;

-- ICV: a single monotonic counter across ALL invoices for this EGS. A plain
-- sequence is the right primitive (uniqueness + monotonicity; gaps are fine for ICV).
CREATE SEQUENCE IF NOT EXISTS einvoice_icv_seq START 1;

CREATE OR REPLACE FUNCTION next_einvoice_icv()
RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $$
  SELECT nextval('einvoice_icv_seq');
$$;
GRANT EXECUTE ON FUNCTION next_einvoice_icv() TO authenticated;

-- Toggle so the dashboard only offers ZATCA reporting once you're onboarded.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS einvoice_enabled boolean NOT NULL DEFAULT false;

-- verification (run separately):
-- SELECT invoice_number, einvoice_status, einvoice_icv, zatca_submitted_at FROM invoices ORDER BY zatca_submitted_at DESC NULLS LAST LIMIT 10;
-- SELECT einvoice_enabled, vat_number FROM company_settings;
