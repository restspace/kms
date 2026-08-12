-- Workplan 14 Wave E (decision D8): content_revisions grows from a
-- submissions-only history into the one revisions table for every entity type
-- (submission title/description, event_contacts profile fields, event
-- settings). One table, one history UI — no second table, no second component.
--
-- 0023's submission_id was NOT NULL with an FK, which no non-submission row
-- can satisfy, so this is a rebuild (same create/copy/drop/rename pattern as
-- 0008/0011/0015) rather than plain ADD COLUMNs:
--   * entity_type   — discriminator; existing rows are all 'submission'.
--                     Deliberately no CHECK list so a new entity type is a
--                     code change, not another rebuild.
--   * entity_id     — generic id (contact id for 'contact', event id for
--                     'settings'). Nullable: the pre-existing submission
--                     insert paths keep writing submission_id only, and stay
--                     valid unchanged; submission reads key on submission_id.
--   * submission_id — kept for back-compat, now nullable, FK + CASCADE as
--                     before. Backfilled into entity_id for existing rows.
--   * payload       — JSON snapshot of the watched fields for non-submission
--                     entities (title/description stay dedicated columns for
--                     submissions; title therefore relaxes to nullable).
-- Non-submission rows carry no per-entity FK (SQLite can't FK conditionally);
-- deletion hygiene rides event_id's existing ON DELETE CASCADE.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE content_revisions_new (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  entity_type    TEXT NOT NULL DEFAULT 'submission',
  entity_id      TEXT,
  submission_id  TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  title          TEXT,
  description    TEXT,
  payload        TEXT,
  edited_by      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  edited_by_name TEXT,
  source         TEXT NOT NULL CHECK (source IN ('admin', 'portal')),
  edited_at      TEXT NOT NULL
);

INSERT INTO content_revisions_new
  (id, event_id, entity_type, entity_id, submission_id, title, description,
   edited_by, edited_by_name, source, edited_at)
SELECT id, event_id, 'submission', submission_id, submission_id, title, description,
       edited_by, edited_by_name, source, edited_at
FROM content_revisions;

DROP TABLE content_revisions;
ALTER TABLE content_revisions_new RENAME TO content_revisions;

CREATE INDEX idx_content_revisions_submission ON content_revisions (submission_id, edited_at DESC);
CREATE INDEX idx_content_revisions_entity ON content_revisions (entity_type, entity_id, edited_at DESC);
CREATE INDEX idx_content_revisions_event ON content_revisions (event_id);
