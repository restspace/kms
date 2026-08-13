-- Workplan 15, waves 1a/2/3: the decision meeting and the outcomes it produces.
--
-- target_slots is a TARGET, never a cap (workplan 15 D1). The decision call's
-- binding constraint is the count per track, but the same archive shows slots
-- moving between tracks all season, so nothing here refuses a save; a track
-- over target just renders in the error tone. NULL = untracked.
ALTER TABLE tracks ADD COLUMN target_slots INTEGER;

-- W2, conditional accept. A flag ALONGSIDE status='accepted', not a status
-- value (D4, reusing the approval_state shape from 0021): a speaker is
-- accepted *and* owes a business co-presenter, and the two axes are
-- independent. A status value would force every status='accepted' query in
-- the codebase into an IN list.
ALTER TABLE submissions ADD COLUMN accept_condition TEXT;   -- the proviso, free text
ALTER TABLE submissions ADD COLUMN condition_met_at TEXT;   -- UTC ISO, NULL = outstanding

-- W3, revise and resubmit. Conceptually a third decision outcome, stored as a
-- flag for the same reason (D5): submissions.status carries a CHECK from
-- 0001_init.sql, SQLite cannot widen a CHECK without a full table rebuild, and
-- 14 child tables hold REFERENCES submissions(id) — a risky migration for what
-- is only a vocabulary change. No CHECK here either (0026 precedent);
-- validated in the route against DECISION_OUTCOMES.
--
-- A 'revise' row stays in decline_queue/declined so every state machine that
-- already exists (scheduling, notification, queue counts) is untouched; the
-- decision letter and the exported `outcome` column are what differ.
ALTER TABLE submissions ADD COLUMN decision_outcome TEXT;   -- NULL | 'revise'
ALTER TABLE submissions ADD COLUMN revise_guidance TEXT;    -- what to change, speaker-facing

-- Lineage, so "did they act on the guidance?" is answerable. The guidance
-- itself is never copied forward — next year's form looks it up at render time
-- on the org-scoped contact (D7), because a copy forks the moment someone
-- edits it.
ALTER TABLE submissions ADD COLUMN resubmission_of TEXT REFERENCES submissions(id) ON DELETE SET NULL;

CREATE INDEX idx_submissions_decision_outcome ON submissions (event_id, decision_outcome);
CREATE INDEX idx_submissions_resubmission_of ON submissions (resubmission_of);
