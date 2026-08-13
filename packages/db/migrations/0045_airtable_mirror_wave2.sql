-- Airtable mirror, second wave: the eight tables workplan-9 left out because
-- they were either not built yet (pipeline, comments) or judged internal
-- (event_contacts, message_log, files, portal responses). Same one-way
-- watermark sweep as 0017 — this migration only supplies what that sweep
-- needs: an updated_at column per table, an airtable_record_id per table, and
-- a stable single-column key to write the record id back against.
--
-- Difference from 0017: updated_at is maintained by TRIGGERS here, not by the
-- mutating routes. 0017's five tables are written from a handful of admin
-- routes; these eight are written from ~20 files (event_contacts alone is
-- touched by the importer, green room, portal, CFP, bulk jobs and the CRM), and
-- "every writer must remember to set updated_at" stops being a mechanical
-- convention at that fan-out. The triggers make it structural instead, at the
-- cost of one extra UPDATE per row write on these tables.
--
-- Each trigger is guarded two ways:
--   WHEN NEW.updated_at IS OLD.updated_at
--     — a writer that sets updated_at itself wins (pipeline_cards already
--       does), and, with recursive_triggers on, the trigger's own UPDATE
--       fails this guard so it cannot recurse.
--   AND NEW.airtable_record_id IS OLD.airtable_record_id
--     — the sweep's own record-id write-back is not a content change. Without
--       this, every freshly created row would come back dirty on the next
--       sweep and cost one redundant update.

-- ---------------------------------------------------------------------------
-- 1. event_contacts needs a single-column key. It is the one mirrored table
--    with a composite primary key (event_id, contact_id) and no id, and the
--    sweep writes record ids back with `UPDATE ... WHERE <key> = ?`. A virtual
--    generated column costs no storage, cannot drift, and needs no backfill;
--    it is called mirror_id rather than id so that `SELECT ec.*` in the
--    existing joins cannot shadow a joined contacts.id or events.id.
-- ---------------------------------------------------------------------------

ALTER TABLE event_contacts ADD COLUMN mirror_id TEXT
  GENERATED ALWAYS AS (event_id || ':' || contact_id) VIRTUAL;

CREATE INDEX idx_event_contacts_mirror_id ON event_contacts (mirror_id);

-- ---------------------------------------------------------------------------
-- 2. Mirror columns. pipeline_cards already carries updated_at (0039) and is
--    the only one of the eight that does.
-- ---------------------------------------------------------------------------

ALTER TABLE event_contacts        ADD COLUMN updated_at TEXT;
ALTER TABLE message_log           ADD COLUMN updated_at TEXT;
ALTER TABLE submission_comments   ADD COLUMN updated_at TEXT;
ALTER TABLE pipeline_activity     ADD COLUMN updated_at TEXT;
ALTER TABLE file_assets           ADD COLUMN updated_at TEXT;
ALTER TABLE file_requests         ADD COLUMN updated_at TEXT;
ALTER TABLE portal_form_responses ADD COLUMN updated_at TEXT;

ALTER TABLE event_contacts        ADD COLUMN airtable_record_id TEXT;
ALTER TABLE message_log           ADD COLUMN airtable_record_id TEXT;
ALTER TABLE submission_comments   ADD COLUMN airtable_record_id TEXT;
ALTER TABLE pipeline_cards        ADD COLUMN airtable_record_id TEXT;
ALTER TABLE pipeline_activity     ADD COLUMN airtable_record_id TEXT;
ALTER TABLE file_assets           ADD COLUMN airtable_record_id TEXT;
ALTER TABLE file_requests         ADD COLUMN airtable_record_id TEXT;
ALTER TABLE portal_form_responses ADD COLUMN airtable_record_id TEXT;

-- Backfill from whatever each table already records as its own timestamp. The
-- values only have to be <= now: the first sweep for a table has no watermark
-- and starts from epoch, so every existing row mirrors regardless.
UPDATE event_contacts        SET updated_at = added_at;
UPDATE message_log           SET updated_at = COALESCE(sent_at, created_at);
UPDATE submission_comments   SET updated_at = created_at;
UPDATE pipeline_activity     SET updated_at = created_at;
UPDATE file_assets           SET updated_at = created_at;
UPDATE file_requests         SET updated_at = created_at;
UPDATE portal_form_responses SET updated_at = submitted_at;

-- ---------------------------------------------------------------------------
-- 3. Triggers. Millisecond precision matches the ISO strings JS writes
--    (new Date().toISOString()), so watermark comparisons — plain string >= —
--    stay well ordered across rows written by SQL and by application code.
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_event_contacts_touch_ins AFTER INSERT ON event_contacts
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE event_contacts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_event_contacts_touch_upd AFTER UPDATE ON event_contacts
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE event_contacts SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_message_log_touch_ins AFTER INSERT ON message_log
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE message_log SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_message_log_touch_upd AFTER UPDATE ON message_log
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE message_log SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_submission_comments_touch_ins AFTER INSERT ON submission_comments
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE submission_comments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_submission_comments_touch_upd AFTER UPDATE ON submission_comments
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE submission_comments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_pipeline_cards_touch_upd AFTER UPDATE ON pipeline_cards
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE pipeline_cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_pipeline_activity_touch_ins AFTER INSERT ON pipeline_activity
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE pipeline_activity SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_pipeline_activity_touch_upd AFTER UPDATE ON pipeline_activity
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE pipeline_activity SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_file_assets_touch_ins AFTER INSERT ON file_assets
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE file_assets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_file_assets_touch_upd AFTER UPDATE ON file_assets
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE file_assets SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_file_requests_touch_ins AFTER INSERT ON file_requests
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE file_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_file_requests_touch_upd AFTER UPDATE ON file_requests
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE file_requests SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_portal_form_responses_touch_ins AFTER INSERT ON portal_form_responses
FOR EACH ROW WHEN NEW.updated_at IS NULL
BEGIN
  UPDATE portal_form_responses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trg_portal_form_responses_touch_upd AFTER UPDATE ON portal_form_responses
FOR EACH ROW WHEN NEW.updated_at IS OLD.updated_at AND NEW.airtable_record_id IS OLD.airtable_record_id
BEGIN
  UPDATE portal_form_responses SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE rowid = NEW.rowid;
END;
