-- ============================================================
-- SA'DA H2O — v65 migration
-- Distinguish a real SA'DA-installed unit (has a QR sticker, genuine
-- 2-year product warranty) from a self-reported tracking row (created
-- for a customer whose only relationship with us is a standalone
-- service visit — e.g. a Filter Change on a non-SA'DA or unregistered
-- unit, no QR code, no formal warranty).
--
-- Existing rows all default to 'install' — no behavior change for
-- them. The customer portal's "My Units" card (js/warranty.js) will
-- branch its styling on this column.
--
-- Safe to re-run.
-- ============================================================

ALTER TABLE warranties ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'install';
ALTER TABLE warranties DROP CONSTRAINT IF EXISTS warranties_source_check;
ALTER TABLE warranties ADD CONSTRAINT warranties_source_check CHECK (source IN ('install', 'self_reported'));
