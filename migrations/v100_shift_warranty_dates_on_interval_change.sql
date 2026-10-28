-- v100: Cascade a product's interval change to its existing customers.
--
-- v94 made Filter/Service/Warranty intervals per-product, but only new
-- writes (a new install, a customer activation, the next job completion)
-- picked up an edited interval — an existing customer's already-stored
-- filter_expiry/service_expiry/warranty_expiry never moved. Admin/owner
-- asked for existing customers to shift too when they edit a product.
--
-- Shift, not reset: a due date moves by exactly how much the interval
-- changed (e.g. filter 90→50 days moves every affected due date 40 days
-- earlier), so each customer's actual position in their own cycle (some
-- just had a filter change, some are overdue) is preserved — nobody's
-- clock gets reset to day zero just because the catalogue changed.
--
-- SECURITY DEFINER + is_admin() check: bypasses warranties' normal RLS
-- (needed for a single bulk UPDATE instead of fetch-then-write per row
-- from the browser) while still restricting who can trigger it — the
-- browser can't do `SET col = col + interval` with a plain .update().

CREATE OR REPLACE FUNCTION shift_warranty_dates_for_product(
  p_product_type text, p_filter_delta int, p_service_delta int, p_warranty_delta int
) RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE v_count int;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE warranties
  SET filter_expiry   = CASE WHEN p_filter_delta   <> 0 AND filter_expiry   IS NOT NULL THEN filter_expiry   + (p_filter_delta   || ' days')::interval ELSE filter_expiry   END,
      service_expiry  = CASE WHEN p_service_delta  <> 0 AND service_expiry  IS NOT NULL THEN service_expiry  + (p_service_delta  || ' days')::interval ELSE service_expiry  END,
      warranty_expiry = CASE WHEN p_warranty_delta <> 0 AND warranty_expiry IS NOT NULL THEN warranty_expiry + (p_warranty_delta || ' days')::interval ELSE warranty_expiry END
  WHERE product_type = p_product_type;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;
GRANT EXECUTE ON FUNCTION shift_warranty_dates_for_product(text, int, int, int) TO authenticated;

-- verification:
-- SELECT shift_warranty_dates_for_product('7 stage RO - A100', -40, -165, 0);
--   -> returns the number of warranty rows shifted; filter_expiry moves 40
--      days earlier, service_expiry 165 days earlier, warranty_expiry untouched.
