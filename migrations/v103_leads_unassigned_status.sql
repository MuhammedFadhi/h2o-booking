-- v103: Add 'unassigned' to leads.status — a WhatsApp-sourced lead now
-- starts here (mirroring the WhatsApp conversation's own 'unassigned'
-- default, v102) instead of 'open', since nobody's actually engaged with it
-- yet (see api/webhooks/whatsapp.js's findOrCreateConversation). Sales-
-- agent-created leads are unaffected — they still start 'open'
-- (api/sales/ops.js's createLead).

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_status_check;
ALTER TABLE leads ADD CONSTRAINT leads_status_check
  CHECK (status IN ('unassigned', 'open', 'unanswered', 'not_interested', 'follow_up', 'converted'));

-- verification:
-- SELECT status, count(*) FROM leads GROUP BY status ORDER BY status;
