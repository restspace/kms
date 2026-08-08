-- Minimal slice of the domain model (docs/02). The remaining entities land in M0
-- proper; this migration exists so the hello-world page reads from the real
-- system of record rather than a hard-coded constant.
CREATE TABLE IF NOT EXISTS events (
  id                  TEXT PRIMARY KEY,
  org_id              TEXT NOT NULL,
  slug                TEXT NOT NULL,
  name                TEXT NOT NULL,
  theme               TEXT,
  timezone            TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  location            TEXT,
  starts_on           TEXT NOT NULL,
  ends_on             TEXT NOT NULL,
  airtable_record_id  TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS events_org_slug ON events (org_id, slug);
