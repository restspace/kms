-- 0009 — per-event custom fields for contacts (SPK-15).
--
-- Speaker/contact records only ever had the fixed field set (name, email,
-- company, job title, mobile, pronouns, biography, notes) and Settings had
-- no way to add an event-specific one ("travel preferences", "dietary
-- needs", ...). Mirrors the submission-forms shape already in 0001
-- (form_questions defs + submission_answers values, keyed PRIMARY KEY(parent,
-- field) with ON DELETE CASCADE both ways) rather than inventing a new
-- pattern — a definitions table the settings card edits, and a values table
-- keyed by (contact_id, field_id).
--
-- Deliberately its own tables rather than reusing field_definitions (which
-- already has a 'contact' scope, but that scope is populated by the
-- submission-form builder's participant-question flow via formsAdmin.ts and
-- referenced by form_questions.field_id — sharing it here would mean a
-- Settings-card delete could hit a row a submission form still points at).
-- A deliberately small type set — this is a settings-card feature, not a
-- second field-library builder.

CREATE TABLE contact_field_definitions (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key       TEXT NOT NULL,
  label     TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('text', 'select', 'multiline')),
  options   TEXT, -- json string[]; only meaningful when type = 'select'
  position  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, key)
);

CREATE INDEX idx_contact_field_definitions_event ON contact_field_definitions (event_id, position);

CREATE TABLE contact_field_values (
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  field_id    TEXT NOT NULL REFERENCES contact_field_definitions(id) ON DELETE CASCADE,
  value       TEXT,
  PRIMARY KEY (contact_id, field_id)
);

CREATE INDEX idx_contact_field_values_contact ON contact_field_values (contact_id);
