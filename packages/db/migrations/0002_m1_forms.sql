-- 0002_m1_forms — M1 additions (docs/04, docs/12 M1).
--
-- submissions.evaluation_plan_id: routing rules "assign to an evaluation plan"
-- needs a home before M3 creates per-reviewer assignments; the workspace and
-- the demo script both read it ("routed to the Workshops evaluation plan").
--
-- submission_forms.participant_roles: the builder's participant-roles panel
-- (role + min/max per role) had no column in 0001; stored as json
-- [{"role":"speaker","min":1,"max":null}, ...]. NULL means the default
-- (speaker only, min 1).

ALTER TABLE submissions ADD COLUMN evaluation_plan_id TEXT REFERENCES evaluation_plans(id);
ALTER TABLE submission_forms ADD COLUMN participant_roles TEXT;

CREATE INDEX idx_submissions_evaluation_plan ON submissions (evaluation_plan_id);
