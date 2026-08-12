-- Session formats as a managed entity (spec-gap CFP-S1).
--
-- Formats were option literals stored on each event's canonical `format`
-- field definition (and copied onto form questions), plus a second hardcoded
-- list in the agenda's Add Session dialog. Renaming a format meant editing
-- every form; the eval expects formats to be configurable "wherever
-- tracks/formats are managed". Tracks are the model: a per-event table whose
-- rows drive the form dropdown at read time (formsAdmin.ts loadQuestions).
--
-- Unlike tracks there is no id column on submissions to resolve into —
-- submissions.format stores the display name and ~15 read surfaces consume
-- that string — so derived options use value = name and nothing references a
-- format by id. Delete therefore needs no cleanup: existing submissions keep
-- the recorded name.
CREATE TABLE formats (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
CREATE INDEX idx_formats_event ON formats (event_id, position);

-- Backfill: one row per option currently stored on each event's canonical
-- `format` field definition, preserving order. Events that customised their
-- option list keep their own names, not the new defaults.
INSERT INTO formats (id, event_id, name, position, updated_at)
SELECT lower(hex(randomblob(16))), fd.event_id,
       COALESCE(json_extract(je.value, '$.label'), json_extract(je.value, '$.value')),
       je.key, datetime('now')
FROM field_definitions fd, json_each(fd.options) je
WHERE fd.key = 'format' AND fd.options IS NOT NULL;

-- Clear the stored copies so the questions opt into the derived list —
-- exactly what 0013_track_options_derived.sql did for `track`. A form that
-- genuinely wants its own format option list can still set one.
UPDATE form_questions SET options = NULL
 WHERE field_id IN (SELECT id FROM field_definitions WHERE key = 'format');

UPDATE field_definitions SET options = NULL WHERE key = 'format';
