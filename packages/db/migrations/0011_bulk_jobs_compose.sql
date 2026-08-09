-- 0011 — allow the 'compose' bulk-job kind (SPK-13).
--
-- The organiser compose flow (POST /app/api/messaging/compose) reuses the
-- existing bulk_jobs queue/expander/status machinery rather than growing a
-- second sending path: a compose snapshots its subject, body and resolved
-- recipient ids into one row, and jobs/bulkJobs.ts's `compose` expander
-- renders it per recipient in bounded ticks. The only thing standing in the
-- way was 0006's CHECK constraint enumerating the three kinds that existed
-- then.
--
-- SQLite cannot ALTER a CHECK constraint, so this is the standard 12-step
-- table rebuild: create the replacement, copy, drop, rename, restore the
-- index. bulk_jobs holds transient job state (rows are minutes old, and the
-- expander is idempotent on replay), and nothing references it by foreign
-- key, so the copy is a plain INSERT ... SELECT with no dependency dance.

CREATE TABLE bulk_jobs_new (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('send-decisions','send-confirmations','remind-tasks','compose')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  params_json TEXT NOT NULL,
  total       INTEGER,
  enqueued    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

INSERT INTO bulk_jobs_new (id, event_id, kind, status, params_json, total, enqueued, created_by, error, created_at, updated_at)
SELECT id, event_id, kind, status, params_json, total, enqueued, created_by, error, created_at, updated_at FROM bulk_jobs;

DROP TABLE bulk_jobs;
ALTER TABLE bulk_jobs_new RENAME TO bulk_jobs;
CREATE INDEX idx_bulk_jobs_status ON bulk_jobs (status, created_at);
