-- File version chain + cross-role file comments (lane W2-C).
--
-- Version identity lives on file_request_uploads: every upload against a file
-- request already appends a row, so the chain was latent in the data. It is
-- materialised (rather than derived per-query) because two downstream features
-- need it cheaply: a ZIP-bundle export that must pick exactly the current
-- version, and the files library, which shows a version count per chain.
--
-- A "chain" is one (file_request_id, contact_id, submission_id) triple: the
-- same speaker answering the same request for the same submission. Re-uploading
-- appends version N+1 and clears is_current on the previous row.

ALTER TABLE file_request_uploads ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE file_request_uploads ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1;

-- Backfill: ordinal by uploaded_at within the chain, id as the tiebreak so the
-- numbering is deterministic when two rows share a timestamp.
UPDATE file_request_uploads
SET version = (
  SELECT COUNT(*)
  FROM file_request_uploads p
  WHERE p.file_request_id = file_request_uploads.file_request_id
    AND p.contact_id = file_request_uploads.contact_id
    AND COALESCE(p.submission_id, '') = COALESCE(file_request_uploads.submission_id, '')
    AND (p.uploaded_at < file_request_uploads.uploaded_at
      OR (p.uploaded_at = file_request_uploads.uploaded_at AND p.id <= file_request_uploads.id))
);

UPDATE file_request_uploads
SET is_current = CASE
  WHEN version = (
    SELECT MAX(p.version)
    FROM file_request_uploads p
    WHERE p.file_request_id = file_request_uploads.file_request_id
      AND p.contact_id = file_request_uploads.contact_id
      AND COALESCE(p.submission_id, '') = COALESCE(file_request_uploads.submission_id, '')
  ) THEN 1 ELSE 0 END;

CREATE INDEX idx_file_request_uploads_chain
  ON file_request_uploads (file_request_id, contact_id, submission_id, version);
CREATE INDEX idx_file_request_uploads_current
  ON file_request_uploads (file_request_id, is_current);
CREATE INDEX idx_file_request_uploads_asset
  ON file_request_uploads (file_asset_id);

-- Comments are scoped to a *version* (file_request_upload_id), not to the
-- chain: a remark like "slide 12 is unreadable" is about the bytes that were
-- on screen when it was written, and losing that anchor on re-upload would
-- misattribute it to the new deck. The thread the UI renders is the union of
-- comments across the chain, ordered by created_at, each labelled with the
-- version it was left on — so a comment on v1 stays visible (and replyable)
-- after v2 lands.
--
-- Authors are contacts on both sides: admins/owners hold event_users seats that
-- point at contacts, so one nullable FK covers speaker and organiser. The role
-- is stamped at write time (a reviewer promoted to admin later must not rewrite
-- history) and the display name is denormalised so a deleted contact does not
-- turn an existing thread anonymous.
CREATE TABLE file_comments (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  file_request_upload_id TEXT NOT NULL REFERENCES file_request_uploads(id) ON DELETE CASCADE,
  file_asset_id          TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
  author_contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  author_role            TEXT NOT NULL CHECK (author_role IN ('speaker','reviewer','admin','owner')),
  author_name            TEXT,
  body                   TEXT NOT NULL,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_file_comments_upload ON file_comments (file_request_upload_id, created_at);
CREATE INDEX idx_file_comments_event ON file_comments (event_id, created_at);
