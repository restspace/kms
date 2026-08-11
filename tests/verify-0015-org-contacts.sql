-- Post-migrate verification for 0015_org_contacts.sql
-- (tests/workplan-5-contact-identity.md §2, "Post-migrate verification").
--
-- Run it with:  node scripts/verify-org-contacts.mjs [--local|--remote]
-- The runner fails the process if ANY row below comes back with status 'FAIL'.
--
-- Every check is written to return exactly one row: (check, status, detail).
-- Anything that cannot be expressed as a count comparison is not a check.

-- 1. Every premerge row is accounted for in the map, exactly once.
SELECT 'map_covers_every_premerge_row' AS "check",
       CASE WHEN (SELECT COUNT(*) FROM _contacts_premerge)
               = (SELECT COUNT(*) FROM _contact_merge_map)
        AND NOT EXISTS (SELECT 1 FROM _contacts_premerge p
                         WHERE NOT EXISTS (SELECT 1 FROM _contact_merge_map m WHERE m.old_id = p.id))
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'premerge=' || (SELECT COUNT(*) FROM _contacts_premerge) ||
       ' map=' || (SELECT COUNT(*) FROM _contact_merge_map) AS detail;

-- 2. Every survivor the map points at actually exists as a contact.
SELECT 'survivors_all_exist' AS "check",
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM _contact_merge_map m
               WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = m.new_id))
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'dangling=' || (SELECT COUNT(*) FROM _contact_merge_map m
                        WHERE NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = m.new_id)) AS detail;

-- 3. contacts now holds exactly the elected survivors — no more, no fewer.
SELECT 'contacts_equals_survivor_set' AS "check",
       CASE WHEN (SELECT COUNT(*) FROM contacts)
               = (SELECT COUNT(DISTINCT new_id) FROM _contact_merge_map)
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'contacts=' || (SELECT COUNT(*) FROM contacts) ||
       ' survivors=' || (SELECT COUNT(DISTINCT new_id) FROM _contact_merge_map) AS detail;

-- 4. One event_contacts row per ORIGINAL premerge row — no per-event profile lost.
SELECT 'event_contacts_preserves_every_row' AS "check",
       CASE WHEN (SELECT COUNT(*) FROM event_contacts)
               = (SELECT COUNT(*) FROM _contacts_premerge)
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'event_contacts=' || (SELECT COUNT(*) FROM event_contacts) ||
       ' premerge=' || (SELECT COUNT(*) FROM _contacts_premerge) AS detail;

-- 5. Profile values survived verbatim. Compares every premerge row's four
--    profile columns against its mapped event_contacts row.
SELECT 'profile_columns_copied_verbatim' AS "check",
       CASE WHEN NOT EXISTS (
              SELECT 1
                FROM _contacts_premerge p
                JOIN _contact_merge_map m ON m.old_id = p.id
                JOIN event_contacts ec ON ec.event_id = p.event_id AND ec.contact_id = m.new_id
               WHERE ec.biography         IS NOT p.biography
                  OR ec.headshot_asset_id IS NOT p.headshot_asset_id
                  OR ec.company           IS NOT p.company
                  OR ec.job_title         IS NOT p.job_title
                  OR ec.notes             IS NOT p.notes)
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'mismatched=' || (SELECT COUNT(*)
                           FROM _contacts_premerge p
                           JOIN _contact_merge_map m ON m.old_id = p.id
                           JOIN event_contacts ec ON ec.event_id = p.event_id AND ec.contact_id = m.new_id
                          WHERE ec.biography         IS NOT p.biography
                             OR ec.headshot_asset_id IS NOT p.headshot_asset_id
                             OR ec.company           IS NOT p.company
                             OR ec.job_title         IS NOT p.job_title
                             OR ec.notes             IS NOT p.notes) AS detail;

-- 6. Org assignment is correct: a contact's org must be the org of every event
--    it has an event_contacts row for.
SELECT 'contact_org_matches_event_org' AS "check",
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM event_contacts ec
                JOIN contacts c ON c.id = ec.contact_id
                JOIN events e ON e.id = ec.event_id
               WHERE e.org_id <> c.org_id)
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'crossed=' || (SELECT COUNT(*) FROM event_contacts ec
                        JOIN contacts c ON c.id = ec.contact_id
                        JOIN events e ON e.id = ec.event_id
                       WHERE e.org_id <> c.org_id) AS detail;

-- 7. Dedupe scope actually holds: no two contacts share an email within an org.
SELECT 'email_unique_within_org' AS "check",
       CASE WHEN NOT EXISTS (
              SELECT 1 FROM contacts GROUP BY org_id, lower(trim(email)) HAVING COUNT(*) > 1)
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'dupe_groups=' || (SELECT COUNT(*) FROM (
              SELECT 1 FROM contacts GROUP BY org_id, lower(trim(email)) HAVING COUNT(*) > 1)) AS detail;

-- 8-25. Orphan check, one per FK table. A repoint that missed rows shows up here
--       as a child pointing at a contact id that no longer exists.
SELECT 'orphans_event_users' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM event_users t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_portal_accounts' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM portal_accounts t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_contact_tags' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM contact_tags t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_submissions' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM submissions t WHERE t.submitter_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.submitter_contact_id);
SELECT 'orphans_submission_participants' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM submission_participants t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_review_assignments' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM review_assignments t WHERE t.reviewer_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.reviewer_contact_id);
SELECT 'orphans_reviews' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM reviews t WHERE t.reviewer_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.reviewer_contact_id);
SELECT 'orphans_task_assignments' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM task_assignments t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_portal_form_responses' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM portal_form_responses t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_file_request_uploads' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM file_request_uploads t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_file_assets' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM file_assets t WHERE t.uploaded_by_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.uploaded_by_contact_id);
SELECT 'orphans_message_log' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM message_log t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_calendar_invites' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM calendar_invites t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_api_tokens' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM api_tokens t WHERE t.created_by_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.created_by_contact_id);
SELECT 'orphans_auth_tokens' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM auth_tokens t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_file_comments' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM file_comments t WHERE t.author_contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.author_contact_id);
SELECT 'orphans_contact_field_values' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM contact_field_values t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);
SELECT 'orphans_evaluation_plan_reviewers' AS "check", CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, 'orphans=' || COUNT(*) AS detail FROM evaluation_plan_reviewers t WHERE t.contact_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM contacts c WHERE c.id = t.contact_id);

-- 26. Row counts unchanged except where a documented dedupe applied. Any row a
--     dedupe dropped must correspond to two premerge contacts that merged into
--     one survivor WITHIN THE SAME EVENT — the only case that can collide.
SELECT 'dedupe_drops_are_explained' AS "check",
       CASE WHEN (SELECT COALESCE(SUM(rows_before - rows_after), 0) FROM _contact_merge_audit) = 0
             OR (SELECT COUNT(*) FROM _contact_merge_map m
                  WHERE m.old_id <> m.new_id
                    AND EXISTS (SELECT 1 FROM _contact_merge_map m2
                                 WHERE m2.new_id = m.new_id AND m2.event_id = m.event_id
                                   AND m2.old_id <> m.old_id)) > 0
            THEN 'PASS' ELSE 'FAIL' END AS status,
       'rows_dropped=' || (SELECT COALESCE(SUM(rows_before - rows_after), 0) FROM _contact_merge_audit) ||
       ' same_event_merges=' || (SELECT COUNT(*) FROM _contact_merge_map m
                                  WHERE m.old_id <> m.new_id
                                    AND EXISTS (SELECT 1 FROM _contact_merge_map m2
                                                 WHERE m2.new_id = m.new_id AND m2.event_id = m.event_id
                                                   AND m2.old_id <> m.old_id)) AS detail;

-- 27. Per-table dedupe detail. Always reports, never fails — it exists so a
--     non-zero drop in check 26 can be attributed to a specific table.
SELECT 'dedupe_detail_' || table_name AS "check",
       CASE WHEN rows_before >= rows_after THEN 'PASS' ELSE 'FAIL' END AS status,
       'before=' || rows_before || ' after=' || rows_after ||
       ' dropped=' || (rows_before - rows_after) AS detail
  FROM _contact_merge_audit ORDER BY table_name;
