-- 0015 — org-level contact identity (tests/workplan-5-contact-identity.md).
--
-- One contact record per person per ORGANISATION, so their submissions, sessions
-- and history can be read across every event in the org. `contacts.event_id`
-- becomes `contacts.org_id`; per-event profile fields move to a new
-- `event_contacts` join table, which carries BOTH membership and profile.
--
-- Why profile-on-the-join-table (workplan §1): the join is the tenancy guard AND
-- the fetch, so a call site that forgets the guard loses the columns it came for
-- rather than silently widening access from event to org.
--
-- The workplan names this migration 0013; 0013 and 0014 were taken by the time it
-- was implemented, hence 0015.
--
-- `notes` (added by 0006, absent from the workplan's §1 column list) is treated as
-- a PROFILE column: it holds one event team's private remarks about a person, and
-- promoting it to org level would disclose those to every other event in the org.
--
-- Non-destructive: `_contacts_premerge` and `_contact_merge_map` are kept as the
-- only record of the pre-merge split and the only way to review a bad merge.

-- `contacts` is referenced by 18 tables, 13 of them ON DELETE CASCADE. The
-- drop-and-rename in step 5 would fire every one of those cascades mid-migration
-- without this.
PRAGMA defer_foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- 1. Snapshot — the pre-merge truth. Deliberately never dropped.
-- ---------------------------------------------------------------------------

CREATE TABLE _contacts_premerge AS SELECT * FROM contacts;

-- ---------------------------------------------------------------------------
-- 2. Elect survivors: group by (org_id, lower(trim(email))), survivor is the
--    lowest created_at, tie-broken by id. Every original row gets a map entry,
--    including survivors (mapping to themselves) — the verification script
--    asserts exactly that.
-- ---------------------------------------------------------------------------

CREATE TABLE _contact_merge_map (
  old_id    TEXT PRIMARY KEY,
  new_id    TEXT NOT NULL,
  org_id    TEXT NOT NULL,
  event_id  TEXT NOT NULL
);

INSERT INTO _contact_merge_map (old_id, new_id, org_id, event_id)
SELECT
  p.id,
  (SELECT q.id
     FROM _contacts_premerge q
     JOIN events qe ON qe.id = q.event_id
    WHERE qe.org_id = e.org_id
      AND lower(trim(q.email)) = lower(trim(p.email))
    ORDER BY q.created_at ASC, q.id ASC
    LIMIT 1),
  e.org_id,
  p.event_id
FROM _contacts_premerge p
JOIN events e ON e.id = p.event_id;

CREATE INDEX idx_contact_merge_map_new ON _contact_merge_map (new_id);

-- Row counts for the eight tables whose dedupe below can legitimately drop rows.
-- Captured BEFORE any delete so the verification script can prove that every
-- dropped row was a genuine merge collision rather than collateral damage. The
-- other ten tables are plain UPDATEs and cannot change row count; the orphan
-- checks cover those.
CREATE TABLE _contact_merge_audit (
  table_name   TEXT PRIMARY KEY,
  rows_before  INTEGER NOT NULL,
  rows_after   INTEGER
);

-- One statement per table: D1 caps the number of terms in a compound SELECT far
-- below stock SQLite, so a single UNION ALL of all eight is rejected outright.
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'event_users', COUNT(*) FROM event_users;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'contact_tags', COUNT(*) FROM contact_tags;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'submission_participants', COUNT(*) FROM submission_participants;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'review_assignments', COUNT(*) FROM review_assignments;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'task_assignments', COUNT(*) FROM task_assignments;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'calendar_invites', COUNT(*) FROM calendar_invites;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'contact_field_values', COUNT(*) FROM contact_field_values;
INSERT INTO _contact_merge_audit (table_name, rows_before) SELECT 'evaluation_plan_reviewers', COUNT(*) FROM evaluation_plan_reviewers;

-- ---------------------------------------------------------------------------
-- 3. Repoint children — BEFORE any delete. Doing this after the drop would
--    destroy data silently through the 13 CASCADEs.
--
--    Eight of the 18 tables carry a uniqueness constraint that includes the
--    contact: merging two rows that sat in the SAME event can now collide. The
--    old UNIQUE (event_id, email) made that impossible except where two rows
--    differed only by email case or surrounding whitespace, so these deletes are
--    expected to remove zero rows on clean data; the verification script reports
--    the count either way rather than trusting that.
--
--    Loser election is min(rowid) — arbitrary but deterministic. For event_users
--    that could in principle drop the higher-privilege row, so it is ordered by
--    role rank instead.
-- ---------------------------------------------------------------------------

-- event_users — PRIMARY KEY (event_id, contact_id). Keep the strongest role.
DELETE FROM event_users
 WHERE rowid NOT IN (
   SELECT rowid FROM (
     SELECT rowid,
            ROW_NUMBER() OVER (
              PARTITION BY event_id,
                           (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
              ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, rowid
            ) AS rn
       FROM event_users
   ) WHERE rn = 1
 );

UPDATE event_users
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- contact_tags — PRIMARY KEY (contact_id, tag_id).
DELETE FROM contact_tags
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM contact_tags
    GROUP BY (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id), tag_id
 );

UPDATE contact_tags
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- submission_participants — UNIQUE (submission_id, contact_id, role).
DELETE FROM submission_participants
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM submission_participants
    GROUP BY submission_id,
             (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id),
             role
 );

UPDATE submission_participants
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- review_assignments — UNIQUE (plan_id, submission_id, reviewer_contact_id).
DELETE FROM review_assignments
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM review_assignments
    GROUP BY plan_id, submission_id,
             (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = reviewer_contact_id)
 );

UPDATE review_assignments
   SET reviewer_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = reviewer_contact_id)
 WHERE reviewer_contact_id IN (SELECT old_id FROM _contact_merge_map);

-- task_assignments — UNIQUE INDEX (task_id, contact_id, COALESCE(submission_id,'')).
DELETE FROM task_assignments
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM task_assignments
    GROUP BY task_id,
             (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id),
             COALESCE(submission_id, '')
 );

UPDATE task_assignments
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- calendar_invites — UNIQUE (session_id, contact_id).
DELETE FROM calendar_invites
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM calendar_invites
    GROUP BY session_id,
             (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 );

UPDATE calendar_invites
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- contact_field_values — PRIMARY KEY (contact_id, field_id). field_id is
-- event-scoped, so cross-event merges do not collide; same-event ones can.
DELETE FROM contact_field_values
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM contact_field_values
    GROUP BY (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id), field_id
 );

UPDATE contact_field_values
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- evaluation_plan_reviewers — PRIMARY KEY (plan_id, contact_id).
DELETE FROM evaluation_plan_reviewers
 WHERE rowid NOT IN (
   SELECT MIN(rowid) FROM evaluation_plan_reviewers
    GROUP BY plan_id,
             (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 );

UPDATE evaluation_plan_reviewers
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

-- The remaining ten carry no contact-bearing uniqueness constraint: a plain
-- repoint is total and lossless.

UPDATE portal_accounts
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE submissions
   SET submitter_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = submitter_contact_id)
 WHERE submitter_contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE reviews
   SET reviewer_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = reviewer_contact_id)
 WHERE reviewer_contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE portal_form_responses
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE file_request_uploads
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE file_assets
   SET uploaded_by_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = uploaded_by_contact_id)
 WHERE uploaded_by_contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE message_log
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE api_tokens
   SET created_by_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = created_by_contact_id)
 WHERE created_by_contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE auth_tokens
   SET contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = contact_id)
 WHERE contact_id IN (SELECT old_id FROM _contact_merge_map);

UPDATE file_comments
   SET author_contact_id = (SELECT m.new_id FROM _contact_merge_map m WHERE m.old_id = author_contact_id)
 WHERE author_contact_id IN (SELECT old_id FROM _contact_merge_map);

-- ---------------------------------------------------------------------------
-- 4. Rebuild `contacts` org-scoped. SQLite cannot alter a FK or UNIQUE in place.
--
--    The FK to `events` is REMOVED, not repointed: keeping ON DELETE CASCADE
--    against an event would mean deleting one event wipes contacts belonging to
--    the whole org. The org FK cascades instead, which is the correct ownership.
-- ---------------------------------------------------------------------------

CREATE TABLE contacts_new (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  salutation    TEXT,
  honorific     TEXT,
  pronouns      TEXT,
  gender        TEXT,
  mobile_phone  TEXT,
  links         TEXT, -- json {linkedin, twitter, facebook, website}
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Email is normalised on the way in so it matches the unique index below and the
-- lower(trim()) grouping the survivor election used.
INSERT INTO contacts_new
  (id, org_id, email, first_name, last_name, salutation, honorific,
   pronouns, gender, mobile_phone, links, created_at, updated_at)
SELECT p.id, e.org_id, lower(trim(p.email)), p.first_name, p.last_name,
       p.salutation, p.honorific, p.pronouns, p.gender, p.mobile_phone,
       p.links, p.created_at, p.updated_at
  FROM _contacts_premerge p
  JOIN events e ON e.id = p.event_id
 WHERE p.id IN (SELECT DISTINCT new_id FROM _contact_merge_map);

DROP TABLE contacts;
ALTER TABLE contacts_new RENAME TO contacts;

CREATE UNIQUE INDEX idx_contacts_org_email ON contacts (org_id, lower(email));
CREATE INDEX idx_contacts_org ON contacts (org_id);

-- ---------------------------------------------------------------------------
-- 5. `event_contacts` — membership AND per-event profile. One row per ORIGINAL
--    premerge row, so no per-event answer is elected away.
-- ---------------------------------------------------------------------------

CREATE TABLE event_contacts (
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id         TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  biography          TEXT,
  headshot_asset_id  TEXT REFERENCES file_assets(id),
  company            TEXT,
  job_title          TEXT,
  notes              TEXT,
  added_at           TEXT NOT NULL,
  source             TEXT NOT NULL DEFAULT 'admin'
                       CHECK (source IN ('import','cfp','admin','migration')),
  PRIMARY KEY (event_id, contact_id)
);

INSERT INTO event_contacts
  (event_id, contact_id, biography, headshot_asset_id, company, job_title,
   notes, added_at, source)
SELECT p.event_id, m.new_id, p.biography, p.headshot_asset_id, p.company,
       p.job_title, p.notes, p.created_at, 'migration'
  FROM _contacts_premerge p
  JOIN _contact_merge_map m ON m.old_id = p.id;

-- (contact_id) for the cross-event lookup; (event_id) for the roster. The PK
-- already covers (event_id, contact_id) prefix lookups.
CREATE INDEX idx_event_contacts_contact ON event_contacts (contact_id);
CREATE INDEX idx_event_contacts_event ON event_contacts (event_id);

-- ---------------------------------------------------------------------------
-- 6. Close the audit. rows_before - rows_after is the dedupe count per table,
--    which tests/verify-0015-org-contacts.sql cross-checks against the number of
--    same-event collisions the merge map actually implies.
-- ---------------------------------------------------------------------------

UPDATE _contact_merge_audit SET rows_after = (
  SELECT CASE table_name
    WHEN 'event_users'               THEN (SELECT COUNT(*) FROM event_users)
    WHEN 'contact_tags'              THEN (SELECT COUNT(*) FROM contact_tags)
    WHEN 'submission_participants'   THEN (SELECT COUNT(*) FROM submission_participants)
    WHEN 'review_assignments'        THEN (SELECT COUNT(*) FROM review_assignments)
    WHEN 'task_assignments'          THEN (SELECT COUNT(*) FROM task_assignments)
    WHEN 'calendar_invites'          THEN (SELECT COUNT(*) FROM calendar_invites)
    WHEN 'contact_field_values'      THEN (SELECT COUNT(*) FROM contact_field_values)
    WHEN 'evaluation_plan_reviewers' THEN (SELECT COUNT(*) FROM evaluation_plan_reviewers)
  END
);
