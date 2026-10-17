-- =============================================================================
-- SA'DA H2O — v70  Promo codes: restrict a code to specific products
--
-- Adds applicable_products (text[]) to promo_codes. NULL or an empty array
-- means the code applies to every product (unchanged behavior for every
-- existing code); a non-empty array means the discount only applies to
-- basket line items whose product model is in the list — values match
-- product_models.model_name exactly.
--
-- Idempotent. Run AFTER v37 (promo_codes table).
-- =============================================================================

ALTER TABLE promo_codes ADD COLUMN IF NOT EXISTS applicable_products text[];

-- verification (run separately):
-- SELECT code, applicable_products FROM promo_codes;
