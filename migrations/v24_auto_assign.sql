-- =============================================================================
-- SA'DA H2O — v24 automated round-robin installer assignment
-- Idempotent. Safe to re-run.
-- =============================================================================

-- Picks the active installer with the fewest ongoing jobs (upcoming + in_progress)
-- and assigns them to the booking. Tie-broken by installer created_at ASC (fair).
-- Advisory xact lock serializes concurrent calls so two bookings arriving at once
-- get spread across different installers instead of colliding on the same "least loaded".
CREATE OR REPLACE FUNCTION public.auto_assign_installer(booking_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  chosen_id uuid;
BEGIN
  -- Serialize concurrent assignments so ranking sees consistent counts.
  PERFORM pg_advisory_xact_lock(hashtext('sada_auto_assign'));

  -- No-op if already assigned.
  IF EXISTS (SELECT 1 FROM bookings WHERE id = booking_id AND installer_id IS NOT NULL) THEN
    RETURN NULL;
  END IF;

  SELECT i.id INTO chosen_id
    FROM installers i
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS active_count
        FROM bookings b
       WHERE b.installer_id = i.id
         AND b.status IN ('upcoming', 'in_progress')
    ) stats ON TRUE
   WHERE i.is_active = TRUE
   ORDER BY COALESCE(stats.active_count, 0) ASC,
            i.created_at ASC
   LIMIT 1;

  IF chosen_id IS NULL THEN
    RETURN NULL;   -- No active installers; caller falls back to broadcast.
  END IF;

  UPDATE bookings
     SET installer_id = chosen_id
   WHERE id = booking_id
     AND installer_id IS NULL;

  RETURN chosen_id;
END;
$$;

REVOKE ALL ON FUNCTION public.auto_assign_installer(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.auto_assign_installer(uuid) TO anon, authenticated;
