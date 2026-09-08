-- =============================================================================
-- SA'DA H2O — v36  Real product images
--
-- The catalogue's image_url was a generic placeholder (/assets/models/purifier-generic.png)
-- for every product. The booking form worked around this with a hard-coded map, but the
-- warranty/customer display (js/warranty.js) reads image_url straight from the DB and so
-- showed the placeholder. This points each product at its real photo so every surface
-- (booking form, warranty view, admin) shares one correct source.
--
-- Images live in the repo at /assets/products/ (committed + deployed on Vercel).
-- The dispenser has two colours; the catalogue holds one row, so it points at the black
-- one as the representative image (colour is chosen per-booking, not per-catalogue).
--
-- Idempotent. Run AFTER v34.
-- =============================================================================

UPDATE product_models SET image_url = '/assets/products/ro-7stage.png'        WHERE model_name = '7-Stage RO Purifier';
UPDATE product_models SET image_url = '/assets/products/ro-7stage-uv.png'      WHERE model_name = '7-Stage RO Purifier + UV';
UPDATE product_models SET image_url = '/assets/products/ro-6stage-smart.png'   WHERE model_name = '6-Stage Smart RO';
UPDATE product_models SET image_url = '/assets/products/ro-7stage-smart.png'   WHERE model_name = '7-Stage Smart RO';
UPDATE product_models SET image_url = '/assets/products/dispenser-black.png'   WHERE model_name = 'RO Water Dispenser (Hot/Cold)';

-- verification (run separately):
-- SELECT model_name, image_url FROM product_models WHERE is_catalogue ORDER BY sort_order;
