-- v91: Fix the upsert targets added in v90.
--
-- v90 made the (external_system, external_id) / (channel, external_id)
-- unique indexes PARTIAL (WHERE external_id IS NOT NULL), so a row with no
-- external_id wouldn't collide with another row with no external_id.
-- PostgREST's upsert (?on_conflict=col1,col2 + Prefer: resolution=merge-
-- duplicates) issues a plain `ON CONFLICT (col1, col2)`, which Postgres
-- refuses to match against a partial index — error 42P10, "there is no
-- unique or exclusion constraint matching the ON CONFLICT specification".
-- Confirmed live: the CRM's first real lead.created delivery failed with
-- exactly this error.
--
-- A plain (non-partial) unique index has the same practical effect here —
-- NULL is never considered equal to another NULL for uniqueness purposes in
-- Postgres, so rows with no external_id still coexist freely — while also
-- being a valid ON CONFLICT target.

DROP INDEX IF EXISTS idx_leads_external_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_external_unique
  ON leads (external_system, external_id);

DROP INDEX IF EXISTS idx_crm_messages_external_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_messages_external_unique
  ON crm_messages (channel, external_id);
