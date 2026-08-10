-- 0012 — evaluation rounds: plan membership, plan reviewer pool, open/close window.
--
-- Why (eval findings CFP-10 / ABS-01 / the "0 submissions" assign bug):
--
--   1. A plan's submission set only ever existed as `submissions.evaluation_plan_id`
--      — a single column written by form *routing rules* on submit and by nothing
--      else. There was no way for an organiser to put an existing submission into
--      a round, so `POST /evaluation/plans/:id/assign` always found zero rows and
--      created zero review_assignments. `evaluation_plan_submissions` is the real
--      many-to-many membership docs/06 §4 describes ("assigned by filter … or by
--      explicit selection"), and it also lets one submission sit in several
--      concurrent rounds, which the single column could never express.
--
--      The legacy column is NOT dropped: routing rules (submit.tsx), the grid's
--      `Ratings:` column and the REST/admin queries still read it, and it stays
--      the "primary plan" of a submission. Membership is therefore read as the
--      union of the two, and the rows that already exist are backfilled below.
--
--   2. `evaluation_plan_reviewers` is the plan's reviewer pool. Reviewer identity
--      still lives in `event_users` (contacts with the reviewer role, per docs/06
--      §4) — this table only records which of them belong to which round, so the
--      editor can pre-check them and "remind all lagging" has a scope.
--
--   3. `opens_at` / `closes_at` are the optional review window (ABS-01). NULL on
--      either side means "no bound", so an untouched plan behaves exactly as
--      before: always open. Stored as ISO-8601 text like every other timestamp.

ALTER TABLE evaluation_plans ADD COLUMN opens_at TEXT;
ALTER TABLE evaluation_plans ADD COLUMN closes_at TEXT;

CREATE TABLE evaluation_plan_submissions (
  plan_id        TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  added_at       TEXT NOT NULL,
  PRIMARY KEY (plan_id, submission_id)
);

CREATE INDEX idx_evaluation_plan_submissions_submission
  ON evaluation_plan_submissions (submission_id);

CREATE TABLE evaluation_plan_reviewers (
  plan_id     TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  PRIMARY KEY (plan_id, contact_id)
);

CREATE INDEX idx_evaluation_plan_reviewers_contact
  ON evaluation_plan_reviewers (contact_id);

-- Backfill: every submission already routed to a plan is a member of it.
INSERT OR IGNORE INTO evaluation_plan_submissions (plan_id, submission_id, added_at)
SELECT s.evaluation_plan_id, s.id, COALESCE(s.updated_at, s.created_at)
FROM submissions s
JOIN evaluation_plans p ON p.id = s.evaluation_plan_id
WHERE s.evaluation_plan_id IS NOT NULL;

-- Backfill: anyone already holding an assignment in a plan is in its pool.
INSERT OR IGNORE INTO evaluation_plan_reviewers (plan_id, contact_id, added_at)
SELECT ra.plan_id, ra.reviewer_contact_id, COALESCE(ra.assigned_at, '1970-01-01T00:00:00Z')
FROM review_assignments ra;
