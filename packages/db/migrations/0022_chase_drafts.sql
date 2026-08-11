-- Assisted chasing (workplan-13 W4a, decisions D5/D6/D7).
--
-- chase_drafts is where the reminder sweep now lands: the cron becomes a
-- *detector* that stages a rendered draft per would-be send, and in the
-- default chase_mode='auto' the same sweep immediately sends the staged row
-- through queueTemplated — so out-of-the-box behaviour is unchanged (Brief.md
-- #3 / FR-COMM-5). In chase_mode='assisted' the row stops at 'staged' and a
-- human clicks Send / Dismiss / Escalate from the chase inbox.
--
-- idem_key carries exactly what today's message_log send key carries
-- (template, contact, entity, offset or overdue-day index), so the existing
-- no-double-nudge guarantee moves from the mailer to the staging step
-- unchanged: one sweep pass and fifty are the same.
--
-- rung (D7) is recorded, never automated: the higher rungs (her own email,
-- cc the chair, text, call) happen outside the tool and the row only records
-- that they happened, and when. acted_by is a bare contact id with no FK,
-- matching bulk_jobs.created_by (0011) and import_batches.created_by (0020).

CREATE TABLE chase_drafts (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subject_of  TEXT NOT NULL,   -- 'task' | 'draft_close' | 'approval' | 'manual'
  subject_id  TEXT,            -- assignment id, form id, submission id
  rung        TEXT NOT NULL DEFAULT 'tool_email'
                CHECK (rung IN ('tool_email','personal_email','cc_chair','text','call')),
  status      TEXT NOT NULL DEFAULT 'staged'
                CHECK (status IN ('staged','sent','dismissed','resolved')),
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  staged_at   TEXT NOT NULL,
  acted_at    TEXT,
  acted_by    TEXT,
  idem_key    TEXT NOT NULL UNIQUE
);

-- The chase inbox lists one event's staged rows; the sweep re-checks by
-- idem_key (covered by the UNIQUE index above).
CREATE INDEX idx_chase_drafts_event_status ON chase_drafts (event_id, status, contact_id);

-- W4d: per-event kill switch. 'auto' (default for all events, new and
-- existing) keeps the spec'd auto-send; 'assisted' is the organiser's
-- explicit opt-in to the human-in-the-loop inbox. Two-value toggle, so a
-- CHECK is safe here (contrast approval_state, which expects to grow values).
ALTER TABLE events ADD COLUMN chase_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (chase_mode IN ('auto','assisted'));
