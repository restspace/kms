-- The canonical `track` field's options were a copy of the event's track names
-- stored on the form. Renaming or deleting a track left every form offering a
-- name that resolved to nothing: submissions landed with no track_id, and the
-- organiser's edit form — which can only offer real tracks — had no option to
-- show for what the submitter picked, so an unrelated save wiped the column.
--
-- Clearing the stored options opts these questions into the derived list
-- (formsAdmin.ts's loadQuestions), which reads the event's tracks on every
-- load and keys each option by track id. A form that genuinely wants its own
-- track option list can still set one; only the duplicated default is dropped.
UPDATE form_questions SET options = NULL
 WHERE field_id IN (SELECT id FROM field_definitions WHERE key = 'track');

UPDATE field_definitions SET options = NULL WHERE key = 'track';
