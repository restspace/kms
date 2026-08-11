-- Per-submission comment thread (workplan 7): timestamp, author, body, shown
-- on the organiser Detail tab and the reviewer scoring screen. The thread is
-- the discussion surface for a submission across a review round.
--
-- Same author shape as file_comments (0007): nullable contact FK + role
-- stamped at write time + denormalised display name, so admins/owners and
-- reviewers share one table and a deleted contact does not anonymise history.
-- Deliberately NOT merged with file_comments into a polymorphic table — those
-- rows are anchored to an upload version for reasons this thread does not
-- share.
--
-- Round context (plan_id, assignment_id) is nullable: an organiser comment
-- belongs to no round, and a plan deleted later must not take the discussion
-- with it.
--
-- kind='rationale' rows are the reviewer's per-review comment folded into the
-- thread (posted at score-save time, carrying plan/assignment ids so an export
-- can still join score to rationale). reviews.comment is deprecated in place:
-- no longer written or read, but kept so this backfill stays reversible.

CREATE TABLE submission_comments (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  submission_id     TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  plan_id           TEXT REFERENCES evaluation_plans(id) ON DELETE SET NULL,
  assignment_id     TEXT REFERENCES review_assignments(id) ON DELETE SET NULL,
  author_contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  author_role       TEXT NOT NULL CHECK (author_role IN ('reviewer','admin','owner')),
  author_name       TEXT,
  kind              TEXT NOT NULL DEFAULT 'discussion'
                      CHECK (kind IN ('rationale','discussion')),
  body              TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_submission_comments_submission ON submission_comments (submission_id, created_at);
CREATE INDEX idx_submission_comments_event ON submission_comments (event_id, created_at);
CREATE INDEX idx_submission_comments_author ON submission_comments (author_contact_id);

-- Backfill: every existing review comment becomes a kind='rationale' row.
-- Deterministic id ('sc-' || review id) plus OR IGNORE makes a re-run a no-op.
-- author_role is hardcoded 'reviewer' because that is what a row in `reviews`
-- means, whatever seat the contact holds today.
INSERT OR IGNORE INTO submission_comments
  (id, event_id, submission_id, plan_id, assignment_id, author_contact_id,
   author_role, author_name, kind, body, created_at)
SELECT
  'sc-' || r.id, p.event_id, r.submission_id, r.plan_id, r.assignment_id,
  r.reviewer_contact_id, 'reviewer',
  NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
  'rationale', r.comment, r.created_at
FROM reviews r
JOIN evaluation_plans p ON p.id = r.plan_id
LEFT JOIN contacts c ON c.id = r.reviewer_contact_id
WHERE r.comment IS NOT NULL AND TRIM(r.comment) != '';
