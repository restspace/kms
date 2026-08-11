-- Sessionboard import plumbing (workplan-11 §5.4-5.5, §8 step 2).
--
-- import_batches (§5.5, G8) is the undo/report backbone: every commit run
-- (sessions or contacts, generic CSV or a Sessionboard export) gets one row
-- here, and every row it *creates* is stamped with the batch id so undo can
-- delete exactly those rows and no others — updated/merged rows are left
-- alone in v1 (see the migration's companion doc for why: storing
-- per-column before-values is a much bigger change, and the fill-blanks-
-- only merge policy already bounds the blast radius). summary_json holds
-- the per-row action/message plan so both the undo confirmation and the
-- report.csv endpoint can render off the same stored data without
-- re-deriving it.
--
-- created_by is a bare contact id with no FK, matching bulk_jobs.created_by
-- (0011) and features.created_by (0006) — actor-id columns in this schema
-- are consistently unenforced so a deleted admin doesn't cascade-void
-- history.
--
-- target/source are both closed vocabularies (CHECK) rather than free text:
-- target says which entity table the batch populated (sessions →
-- submissions, contacts → event_contacts), source records which column-
-- alias/status-map profile ran, defaulting to 'generic' for the plain-CSV
-- wizard path with 'sessionboard' the only vendor profile shipped so far.
--
-- import_batch_id lands on submissions, event_contacts AND
-- submission_participants (the speaker↔session links created while linking
-- speakers to sessions, §5.2, are just as much "created by this batch" as
-- the submission/contact rows) so undo's cascade covers all three.
--
-- extra (§5.4, G7) is a nullable JSON object of {original CSV header:
-- value} for columns the import left unmapped — the cheap alternative to
-- promoting every unknown column into contact_field_definitions (out of
-- scope here, see workplan-11 §9.3). Read-only "Imported fields" display
-- reads straight off this column; no join, no separate table.

CREATE TABLE import_batches (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  target        TEXT NOT NULL CHECK (target IN ('sessions','contacts')),
  source        TEXT NOT NULL DEFAULT 'generic'
                  CHECK (source IN ('generic','sessionboard')),
  filename      TEXT,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  summary_json  TEXT
);

CREATE INDEX idx_import_batches_event ON import_batches (event_id, created_at);

ALTER TABLE submissions             ADD COLUMN import_batch_id TEXT;
ALTER TABLE event_contacts          ADD COLUMN import_batch_id TEXT;
ALTER TABLE submission_participants ADD COLUMN import_batch_id TEXT;

ALTER TABLE submissions    ADD COLUMN extra TEXT;
ALTER TABLE event_contacts ADD COLUMN extra TEXT;

-- Plain indexes, not partial: no CREATE INDEX ... WHERE precedent exists
-- elsewhere in this schema, and the undo endpoint's delete is always
-- `WHERE import_batch_id = ?` (an equality lookup, not a NULL-exclusion
-- scan) so a partial index buys nothing here.
CREATE INDEX idx_submissions_import_batch ON submissions (import_batch_id);
CREATE INDEX idx_event_contacts_import_batch ON event_contacts (import_batch_id);
CREATE INDEX idx_submission_participants_import_batch ON submission_participants (import_batch_id);
