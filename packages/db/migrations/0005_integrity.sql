-- Uniqueness the upsert paths rely on (sweep item P1-5). Dedup first: keep the
-- earliest row per logical key so existing aggregates stay consistent.

DELETE FROM reviews
WHERE assignment_id IS NOT NULL
  AND rowid NOT IN (SELECT MIN(rowid) FROM reviews WHERE assignment_id IS NOT NULL GROUP BY assignment_id);

CREATE UNIQUE INDEX idx_reviews_assignment
  ON reviews (assignment_id) WHERE assignment_id IS NOT NULL;

DELETE FROM task_assignments
WHERE rowid NOT IN (
  SELECT MIN(rowid) FROM task_assignments GROUP BY task_id, contact_id, COALESCE(submission_id, ''));

CREATE UNIQUE INDEX idx_task_assignments_logical
  ON task_assignments (task_id, contact_id, COALESCE(submission_id, ''));

-- Cheap MAX(CAST(SUBSTR(code,6) AS INTEGER)) scans for the code allocator.
CREATE INDEX idx_submissions_event_code ON submissions (event_id, code);
