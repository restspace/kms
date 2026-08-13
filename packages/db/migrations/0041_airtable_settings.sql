-- Settings-page Airtable configuration (moves the mirror's gating out of
-- wrangler.toml/env secrets and into the UI). One global singleton row, not
-- per-event: the mirror itself is deployment-global (workplan-9 §5 option (b)
-- — a single Airtable base per deployment, one watermark set in
-- airtable_sync_state), so its configuration is too.
--
-- Precedence (apps/api/src/jobs/airtableSync.ts resolveAirtableConfig):
-- when this row exists, its `enabled` flag replaces the AIRTABLE_SYNC env
-- var, and non-empty api_key/base_id replace the AIRTABLE_API_KEY /
-- AIRTABLE_BASE_ID secrets. No row (or empty credential columns) falls back
-- to the env vars, so existing env-configured deployments keep working
-- untouched.
--
-- api_key holds the Airtable personal access token in plain text, same trust
-- model as the env secret it replaces (D1 is the deployment's private store);
-- the API layer (routes/airtableAdmin.ts) never returns it — GET responses
-- carry only key_set + the last 4 characters.
CREATE TABLE airtable_settings (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  enabled    INTEGER NOT NULL DEFAULT 0,
  api_key    TEXT,
  base_id    TEXT,
  updated_at TEXT NOT NULL
);
