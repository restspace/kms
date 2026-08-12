-- Flip evaluation_plans.anonymise_submitters to opt-out (default 1) instead
-- of opt-in (default 0) — reviewer anonymity should be the default an
-- organiser has to turn off, not a box they have to remember to tick.
--
-- SQLite can't ALTER a column's DEFAULT in place, so this rebuilds the table
-- (standard 12-step pattern, same as 0008/0011/0015): create the new shape,
-- copy every row's *existing* value across unchanged, drop the old table,
-- rename, recreate the index. Only NEW rows (new plans, after this migration)
-- pick up the new default 1 — an existing plan keeps whatever value it
-- already had, explicit or not; this does not retroactively flip anyone's
-- live plan.
-- Includes opens_at/closes_at (0012 §ABS-01, added after 0001 via ALTER TABLE)
-- so the rebuild carries every column the live table actually has.
--
-- Other tables (evaluation_assignments, etc.) hold a live FK to
-- evaluation_plans(id); defer_foreign_keys lets the DROP/rename pair inside
-- this single migration statement-batch complete before FKs are re-checked,
-- same as 0015's contacts rebuild.
PRAGMA defer_foreign_keys = ON;

CREATE TABLE evaluation_plans_new (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  scoring_scale_min     INTEGER NOT NULL DEFAULT 1,
  scoring_scale_max     INTEGER NOT NULL DEFAULT 5,
  anonymise_submitters  INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL,
  opens_at              TEXT,
  closes_at             TEXT
);

INSERT INTO evaluation_plans_new
  (id, event_id, name, description, status, scoring_scale_min, scoring_scale_max, anonymise_submitters, created_at, opens_at, closes_at)
SELECT id, event_id, name, description, status, scoring_scale_min, scoring_scale_max, anonymise_submitters, created_at, opens_at, closes_at
FROM evaluation_plans;

DROP TABLE evaluation_plans;
ALTER TABLE evaluation_plans_new RENAME TO evaluation_plans;

CREATE INDEX idx_evaluation_plans_event ON evaluation_plans (event_id);
