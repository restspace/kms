-- Feature columns/tables for the fix batch: internal notes (manual review,
-- approved), per-participant configured answers (sweep item P1-7),
-- multi-track submissions (Swyx-1/2 gap), and coarse bulk email jobs
-- (sweep item P2-19).

ALTER TABLE submissions ADD COLUMN notes TEXT;
ALTER TABLE contacts ADD COLUMN notes TEXT;
ALTER TABLE submission_participants ADD COLUMN answers_json TEXT;

-- submissions.track_id remains the *primary* track (agenda/grids/back-compat);
-- this join table is the authoritative multi-set.
CREATE TABLE submission_tracks (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  track_id      TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, track_id)
);
CREATE INDEX idx_submission_tracks_track ON submission_tracks (track_id);

INSERT INTO submission_tracks (submission_id, track_id)
SELECT id, track_id FROM submissions WHERE track_id IS NOT NULL;

CREATE TABLE bulk_jobs (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('send-decisions','send-confirmations','remind-tasks')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed')),
  params_json TEXT NOT NULL,
  total       INTEGER,
  enqueued    INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_bulk_jobs_status ON bulk_jobs (status, created_at);
