-- Lightweight version history for submission content edits. Every writable
-- surface that changes title/description (admin PUT /submissions/:id,
-- speaker portal POST /:slug/submissions/:id/edit) inserts one snapshot row
-- of the PREVIOUS values immediately before its UPDATE, so a row here is
-- always "what it looked like before this edit" — the current values live on
-- `submissions` itself and need no separate "latest" row.
--
-- Full title+description snapshot rather than field-level diffs: both fields
-- are short text, a submission is edited rarely, and a full snapshot makes
-- "what did it say before edit N" a single row read with no reconstruction.
-- No rollback UI is built on this (out of scope) — it exists to make history
-- capturable and retrievable via API.
CREATE TABLE content_revisions (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  description    TEXT,
  -- Who made the edit that superseded this snapshot, and through which
  -- surface — a contact for both admin staff (event_users -> contacts) and
  -- speakers (portal), so one nullable FK covers both, same convention as
  -- file_comments.author_contact_id (0007). Name is denormalised so a later
  -- contact deletion doesn't turn history anonymous.
  edited_by      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  edited_by_name TEXT,
  source         TEXT NOT NULL CHECK (source IN ('admin', 'portal')),
  edited_at      TEXT NOT NULL
);

CREATE INDEX idx_content_revisions_submission ON content_revisions (submission_id, edited_at DESC);
CREATE INDEX idx_content_revisions_event ON content_revisions (event_id);
