-- 0008 — extend submission_participants.role vocabulary (F14/ABS-11).
--
-- Admin submission edit now lets an organiser add a co-speaker retroactively,
-- and the role picker needs 'co-author'/'co-presenter' alongside the existing
-- speaker/co-speaker/moderator/panelist set. SQLite can't ALTER a CHECK
-- constraint in place, so this rebuilds the table (standard 12-step pattern):
-- create the new shape, copy rows, drop the old table, rename, recreate the
-- indexes that pointed at it.

CREATE TABLE submission_participants_new (
  id                  TEXT PRIMARY KEY,
  submission_id       TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'speaker'
                        CHECK (role IN ('speaker','co-speaker','moderator','panelist','co-author','co-presenter')),
  position            INTEGER NOT NULL DEFAULT 0,
  is_primary_contact  INTEGER NOT NULL DEFAULT 0,
  confirmed_at        TEXT,
  answers_json        TEXT,
  UNIQUE (submission_id, contact_id, role)
);

INSERT INTO submission_participants_new
  (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at, answers_json)
SELECT id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at, answers_json
FROM submission_participants;

DROP TABLE submission_participants;
ALTER TABLE submission_participants_new RENAME TO submission_participants;

CREATE INDEX idx_submission_participants_submission ON submission_participants (submission_id);
CREATE INDEX idx_submission_participants_contact ON submission_participants (contact_id);
