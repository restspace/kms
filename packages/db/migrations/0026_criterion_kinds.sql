-- 0026 — scoring criterion field types (2026-08-12 eval sweep, review area).
--
-- The scorecard editor only ever built numeric scale criteria (name + weight),
-- so dropdown/choice and long-text criteria could not be expressed at all.
--
--   kind = 'score'   — the existing numeric scale row (default; every
--                      pre-0026 criterion keeps behaving exactly as before).
--   kind = 'choice'  — a dropdown; `options` holds the JSON array of option
--                      strings. Excluded from the weighted numeric aggregate
--                      (weight is ignored); the chosen option is stored as a
--                      string in reviews.scores under the criterion id.
--   kind = 'text'    — a long-text / comment field. Optional to fill,
--                      excluded from the numeric aggregate, weight ignored.
--
-- No CHECK constraint: ALTER TABLE ADD COLUMN cannot add one retroactively
-- without a table rebuild, and the API validates the vocabulary at write time
-- (see evaluation.ts criteria routes).

ALTER TABLE scoring_criteria ADD COLUMN kind TEXT NOT NULL DEFAULT 'score';
ALTER TABLE scoring_criteria ADD COLUMN options TEXT;
