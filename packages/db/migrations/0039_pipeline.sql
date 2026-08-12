-- Speaker sourcing pipeline (spec-gap CRM-07/08): a kanban board that tracks
-- prospects from research through confirmed/declined, org-wide like the
-- contact directory it enrolls from.
--
-- Stages are fixed text values validated in the API (identified, researching,
-- contacted, interested, confirmed, declined) rather than a stages table —
-- the workflow vocabulary is the feature, not per-org customisation, and a
-- CHECK here would turn "add a stage later" into a table rebuild.
--
-- pipeline_activity is the card's whole timeline: enrollment, every stage
-- move (written server-side so drag and menu moves record identically), and
-- internal notes interleave by created_at. Purpose-built rather than reusing
-- content_revisions, which is shaped around content snapshots.
CREATE TABLE pipeline_cards (
  id          TEXT NOT NULL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL,
  score       INTEGER,        -- optional 0-100 prospect score at enrollment
  rationale   TEXT,           -- optional free-text "why this person"
  position    REAL NOT NULL DEFAULT 0,  -- ordering within a stage column
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_pipeline_cards_contact ON pipeline_cards (org_id, contact_id);
CREATE INDEX idx_pipeline_cards_stage ON pipeline_cards (org_id, stage, position);

CREATE TABLE pipeline_activity (
  id          TEXT NOT NULL PRIMARY KEY,
  card_id     TEXT NOT NULL REFERENCES pipeline_cards(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('enrolled', 'stage_change', 'note')),
  from_stage  TEXT,           -- stage_change only
  to_stage    TEXT,           -- enrolled + stage_change
  body        TEXT,           -- note text
  author_name TEXT,           -- display name of the staff member acting
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_pipeline_activity_card ON pipeline_activity (card_id, created_at);
