-- v58: Lead priority (Hot / Warm / Cold) — sales sets this when adding a
-- lead, so both the sales portal and admin console can see how urgently it
-- needs following up. Defaults to 'warm' (existing rows too) rather than
-- NULL, so every lead has a real value to display/filter on.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS priority text;
ALTER TABLE leads ALTER COLUMN priority SET DEFAULT 'warm';
UPDATE leads SET priority = 'warm' WHERE priority IS NULL;
ALTER TABLE leads ALTER COLUMN priority SET NOT NULL;

ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_priority_check;
ALTER TABLE leads ADD CONSTRAINT leads_priority_check CHECK (priority IN ('hot','warm','cold'));

CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority);
