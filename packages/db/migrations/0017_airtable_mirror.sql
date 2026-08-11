-- Airtable mirror plumbing (workplan-9 §4.3-4.4, §10.2).
--
-- The mirror is a cron-driven watermark sweep (apps/api/src/jobs/airtableSync.ts),
-- not per-write outbox jobs — see workplan-9 §4.1/4.2 for why. That sweep reads
-- `updated_at > watermark` per table, so every mirrored table needs updated_at:
-- tasks/reviews had only created_at (backfilled from it); tracks/rooms/tags had
-- no timestamps at all (backfilled to the migration run time — every existing
-- row mirrors on the first sweep anyway, since the initial watermark is epoch).
--
-- airtable_record_id makes re-sync idempotent (workplan-9 D4): a row that
-- already has one gets an Airtable update, not a duplicate create. Nullable,
-- unindexed — always looked up by D1 row id, never the reverse.
--
-- airtable_sync_state holds one watermark per table, global rather than
-- per-event: this deployment mirrors into a single global Airtable base
-- (workplan-9 §5 option (b) — single-tenant-deployment feature), so per-event
-- watermarks would add fan-out complexity with nothing to gain.
--
-- airtable_pending_deletes (workplan-9 §10.2): delete routes stage the doomed
-- rows' airtable_record_ids here (same db.batch, ordered before the DELETE);
-- the sweep drains it so the mirror doesn't accumulate stale rows.

ALTER TABLE tasks   ADD COLUMN updated_at TEXT;
ALTER TABLE reviews ADD COLUMN updated_at TEXT;
ALTER TABLE tracks  ADD COLUMN updated_at TEXT;
ALTER TABLE rooms   ADD COLUMN updated_at TEXT;
ALTER TABLE tags    ADD COLUMN updated_at TEXT;

UPDATE tasks   SET updated_at = created_at;
UPDATE reviews SET updated_at = created_at;
UPDATE tracks  SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
UPDATE rooms   SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');
UPDATE tags    SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now');

ALTER TABLE events      ADD COLUMN airtable_record_id TEXT;
ALTER TABLE submissions ADD COLUMN airtable_record_id TEXT;
ALTER TABLE contacts    ADD COLUMN airtable_record_id TEXT;
ALTER TABLE tasks       ADD COLUMN airtable_record_id TEXT;
ALTER TABLE reviews     ADD COLUMN airtable_record_id TEXT;
ALTER TABLE tracks      ADD COLUMN airtable_record_id TEXT;
ALTER TABLE rooms       ADD COLUMN airtable_record_id TEXT;
ALTER TABLE tags        ADD COLUMN airtable_record_id TEXT;

CREATE TABLE airtable_sync_state (
  table_name     TEXT PRIMARY KEY,
  last_synced_at TEXT NOT NULL
);

CREATE TABLE airtable_pending_deletes (
  table_name TEXT NOT NULL,
  record_id  TEXT NOT NULL, -- the Airtable rec... id, not a D1 uuid
  queued_at  TEXT NOT NULL,
  PRIMARY KEY (table_name, record_id)
);
