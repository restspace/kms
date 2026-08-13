-- #18 (eval defect): file collection was only ever configurable per-task, via
-- a task's "Action type = File upload" — there was no event-level default an
-- organiser could set once. Two small columns on `events`, following the
-- same ad-hoc-column pattern as chase_mode (0022_chase_drafts.sql):
--
--  default_file_upload_enabled: when set, the Tasks tab's "New task" form
--    pre-fills Action type to File upload instead of Acknowledge
--    (TaskCreateForm.tsx).
--  default_file_allowed_types: JSON string[] of accepted content types,
--    applied to a file_upload task's file_requests row at creation time
--    whenever the task doesn't already carry an explicit file_request_id
--    (adminApi.ts's POST /tasks) — the same "json string[]" shape
--    file_requests.allowed_types already uses (0001_init.sql), so no new
--    parsing logic is needed on the read side (portal.ts's uploadPolicyFor).
--    NULL means "no event default configured yet", which keeps a fresh
--    event's task creation behaviour exactly as it was before this migration.
ALTER TABLE events ADD COLUMN default_file_upload_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN default_file_allowed_types TEXT;
