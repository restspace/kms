-- Workplan 13, W1c + W3 (numbered 0021 — 0020 was taken by the Sessionboard
-- import while this plan was being written).
--
-- W1c: title_at_time / org_at_time on submission_participants (D3). The join
-- row is the thing that happened at a moment; event_contacts stays current
-- truth and editable (freezing the profile would break the portal's "fix my
-- job title" flow). Written once at row creation from the contributing
-- event_contacts row — the CFP submit path, the admin participant add and the
-- importer's speaker→session link all stamp it — and never updated.
--
-- W3 (D4): approval_state is a flag ALONGSIDE the accepted status, not a
-- status value — a speaker is accepted *and* awaiting employer sign-off; the
-- two axes are independent, and a status value would force every
-- `status = 'accepted'` query into an IN list. NULL = not applicable / not
-- asked | 'pending' | 'granted' | 'refused'. Deliberately no CHECK constraint
-- on a column we expect to grow values; routes validate against the exported
-- APPROVAL_STATES set (routes/evaluation.ts), the SUBMISSION_STATUSES pattern.
-- approval_note carries the thing that actually gets chased ("PR sign-off,
-- legal says end of month"). 'refused' never auto-withdraws (D7).

ALTER TABLE submission_participants ADD COLUMN title_at_time TEXT;
ALTER TABLE submission_participants ADD COLUMN org_at_time TEXT;

-- Backfill from TODAY'S event_contacts values. That is an approximation — the
-- profile row is mutable, so for pre-existing participants this records the
-- job title / company as they read at migration time, not as they read at
-- submission time. An approximation labelled as one beats a NULL a future
-- join silently reads as "unknown"; rows created after this migration carry
-- the genuine at-submission values.
UPDATE submission_participants
SET title_at_time = (SELECT ec.job_title
                       FROM event_contacts ec
                       JOIN submissions s ON s.id = submission_participants.submission_id
                      WHERE ec.contact_id = submission_participants.contact_id
                        AND ec.event_id = s.event_id),
    org_at_time   = (SELECT ec.company
                       FROM event_contacts ec
                       JOIN submissions s ON s.id = submission_participants.submission_id
                      WHERE ec.contact_id = submission_participants.contact_id
                        AND ec.event_id = s.event_id)
WHERE title_at_time IS NULL AND org_at_time IS NULL;

ALTER TABLE submissions ADD COLUMN approval_state TEXT;
ALTER TABLE submissions ADD COLUMN approval_note TEXT;
