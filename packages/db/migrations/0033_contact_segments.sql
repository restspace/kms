-- CRM-09: saved Speaker-roster segments. kind='dynamic' stores the filter
-- object the grid was showing; kind='curated' freezes an explicit id list.
-- No CHECK on kind (0026 precedent: validate in the API, keep ALTERs cheap).
-- member_ids is a JSON array of contact ids, queried via json_each - a member
-- table is deliberately not built (no per-member metadata, lists are small).
CREATE TABLE contact_segments (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'dynamic',
  filters    TEXT,
  member_ids TEXT,
  created_by TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_contact_segments_event ON contact_segments (event_id, name);
