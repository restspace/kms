-- 0014 — separate "which message is this" from "which batch sent it".
--
-- Until now every bulk expander passed `entityId = "<jobId>:<naturalId>"` so
-- that GET /app/api/bulk-jobs/:id could count a job's messages with
-- `idempotency_key LIKE '%:' || jobId || ':%'`. That made the job id part of
-- message_log.idempotency_key — the UNIQUE column (0001_init.sql:470, marked
-- NFR-11) whose whole purpose is to be the same string whenever the same
-- message is sent again.
--
-- The two facts have different lifetimes and the batch one poisoned the
-- other: every "Remind all" press minted a fresh job id, so the per-day
-- reminder key `task_reminder:<contact>:<jobId>:<assignment>:vmanual-<day>`
-- never repeated and the UNIQUE constraint had nothing to catch. Speakers
-- were re-reminded once per press. (Decisions and confirmations were spared
-- only because they carry a second guard — submissions.notified_at — that
-- reminders have no equivalent of.)
--
-- Batch membership moves to its own column, so the key can go back to naming
-- just the message. The count becomes an indexed equality test instead of a
-- leading-wildcard LIKE, which could never use an index anyway.
ALTER TABLE message_log ADD COLUMN bulk_job_id TEXT;
CREATE INDEX IF NOT EXISTS idx_message_log_bulk_job ON message_log (bulk_job_id);

-- Duplicates suppressed by that UNIQUE constraint used to be invisible: the
-- expander dropped queueTemplated's 'duplicate' outcome on the floor, so a
-- run that correctly sent nothing reported a bare "0 reminders sent" with no
-- reason. Counting them on the job row lets the completion banner say
-- "0 sent, 2 already reminded today".
ALTER TABLE bulk_jobs ADD COLUMN skipped_duplicate INTEGER NOT NULL DEFAULT 0;
