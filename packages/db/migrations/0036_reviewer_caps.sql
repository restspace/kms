-- ABS-06: per-round reviewer workload cap. NULL = uncapped. Lives on the
-- pool row, so the cap is PER PLAN: counts compare against this plan's
-- review_assignments only.
ALTER TABLE evaluation_plan_reviewers ADD COLUMN max_assignments INTEGER;
