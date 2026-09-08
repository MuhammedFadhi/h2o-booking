-- =============================================================================
-- SA'DA H2O — v44  Add 200 GPD & 400 GPD commercial RO systems
--
-- Two new catalogue products (same product photo for both):
--   * 200 GPD Commercial RO System — SAR 2,300
--   * 400 GPD Commercial RO System — SAR 3,450
--
-- Both are serialized (warranty-tracked, QR sticker on the unit) like the other
-- RO purifiers, so the installer creates a pending warranty per unit and the
-- customer activates it by scanning.
--
-- Idempotent — safe to re-run (model_name has a unique constraint; verified).
-- =============================================================================

INSERT INTO product_models (model_name, image_url, description, price_sar, is_catalogue, sort_order, is_serialized)
VALUES
  ('200 GPD Commercial RO System',
   '/assets/products/ro-commercial-gpd.png',
   '200 GPD (~750 L/day) high-capacity reverse osmosis system with pressure tank. Multi-stage filtration on a floor-standing frame — built for shops, offices, clinics, restaurants and large villas.',
   2300, true, 6, true),
  ('400 GPD Commercial RO System',
   '/assets/products/ro-commercial-gpd.png',
   '400 GPD (~1,500 L/day) high-capacity reverse osmosis system with pressure tank. Double the output of the 200 GPD unit — for high-demand commercial sites, labour accommodation, cafeterias and small plants.',
   3450, true, 7, true)
ON CONFLICT (model_name) DO UPDATE
SET image_url     = EXCLUDED.image_url,
    description   = EXCLUDED.description,
    price_sar     = EXCLUDED.price_sar,
    is_catalogue  = EXCLUDED.is_catalogue,
    sort_order    = EXCLUDED.sort_order,
    is_serialized = EXCLUDED.is_serialized;

-- verification:
-- SELECT model_name, price_sar, is_serialized, sort_order FROM product_models
-- WHERE is_catalogue = true ORDER BY sort_order;
