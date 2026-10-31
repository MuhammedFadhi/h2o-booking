-- v103: Widen leads.status from open/converted/lost to a richer pipeline
-- vocabulary that mirrors WhatsApp's own conversation status
-- (open/unanswered/not_interested/follow_up/converted), so a WhatsApp-sourced
-- lead's status can sync 1:1 instead of flattening into open/lost (see
-- admin/dashboard.html's WA_TO_LEAD_STATUS). 'not_interested' takes over
-- 'lost''s role — same lost_reason column, existing 'lost' rows remapped.

UPDATE leads SET status = 'not_interested' WHERE status = 'lost';

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('open', 'unanswered', 'not_interested', 'follow_up', 'converted'));

-- verification:
-- SELECT status, count(*) FROM leads GROUP BY status ORDER BY status;
