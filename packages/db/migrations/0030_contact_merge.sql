-- 0030 — organizer-driven contact merge (workplan 14 Wave B, decisions D1/D2).
--
-- 0015 merged duplicates mechanically at migration time (same org + same
-- email) and kept `_contact_merge_map` as its audit. This is the runtime
-- counterpart: an ORGANIZER merges two contacts the tool cannot safely fuse
-- on its own (same name, different emails — or whitespace-variant emails the
-- 0015 unique index never caught), choosing per-field which record's values
-- survive. Per D1 the losing record is TOMBSTONED, never deleted: its row
-- stays, pointing at the survivor, so the merge is recorded and reversible in
-- principle — every FK that referenced the loser is repointed at merge time
-- by the endpoint (adminApi.ts POST /contacts/:id/merge), exactly the 0015
-- treatment applied to one pair.

-- One row per executed merge. winner/loser/actor are bare contact ids with no
-- FK (matching bulk_jobs.created_by, import_batches.created_by,
-- chase_drafts.acted_by): the audit must survive any later deletion of the
-- people it describes, so it must never ride a cascade or block a delete.
--
-- field_resolution is json: { picks: { <field>: 'winner'|'loser' }, and a
-- loser_snapshot of the identity + per-event profile values as they stood the
-- moment before the merge — the only record of them once the loser is
-- tombstoned (its email is rewritten to free the org-wide unique index).
CREATE TABLE contact_merges (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  winner_contact_id  TEXT NOT NULL,
  loser_contact_id   TEXT NOT NULL,
  actor              TEXT,
  field_resolution   TEXT, -- json
  created_at         TEXT NOT NULL
);

CREATE INDEX idx_contact_merges_org ON contact_merges (org_id, created_at);
CREATE INDEX idx_contact_merges_winner ON contact_merges (winner_contact_id);

-- The tombstone pointer. Bare id, no FK, for the same reason as above —
-- deleting the winner later must not cascade into (or be blocked by) the
-- tombstones that point at it. NULL for every live contact.
--
-- Visibility: the loser's event_contacts rows are all removed by the merge
-- (folded into the winner's), so every roster/directory/public read — all of
-- which join event_contacts since 0015 — already excludes it structurally.
-- The reads that DON'T make that join (org-search, the duplicate-candidates
-- endpoint) filter `merged_into IS NULL` explicitly.
ALTER TABLE contacts ADD COLUMN merged_into TEXT;

CREATE INDEX idx_contacts_merged_into ON contacts (merged_into) WHERE merged_into IS NOT NULL;
