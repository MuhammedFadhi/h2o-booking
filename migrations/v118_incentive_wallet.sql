-- v118: "My Wallet" for staff portals (sales + installer).
-- One read-only function that returns ONLY the signed-in person's incentives
-- and the payments they received. Staff get no direct access to the tables.
-- Needs v116 + v117 first. Safe to run again.
--
-- Undo: DROP FUNCTION IF EXISTS public.my_incentive_wallet();

CREATE OR REPLACE FUNCTION public.my_incentive_wallet()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'earnings', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'earned_on', e.earned_on,
               'booking', b.booking_reference,
               'product', e.product_name,
               'qty', e.qty,
               'amount', e.amount,
               'adjustment', e.adjustment,
               'paid_on', p.paid_on,
               'payout_no', p.payout_no
             ) ORDER BY e.earned_on DESC, e.id)
      FROM incentive_earnings e
      LEFT JOIN bookings b ON b.id = e.booking_id
      LEFT JOIN incentive_payouts p ON p.id = e.payout_id AND p.cancelled_at IS NULL
      WHERE e.person_id = auth.uid()), '[]'::jsonb),
    'payouts', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'payout_no', p.payout_no,
               'paid_on', p.paid_on,
               'method', p.method,
               'amount', l.amount
             ) ORDER BY p.paid_on DESC, p.payout_no DESC)
      FROM incentive_payout_lines l
      JOIN incentive_payouts p ON p.id = l.payout_id
      WHERE l.person_id = auth.uid() AND p.cancelled_at IS NULL), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION public.my_incentive_wallet() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_incentive_wallet() TO authenticated;
