-- Rendered message content (messaging defect 5, 2026-08-12 eval sweep).
--
-- message_log recorded only the rendered *subject*; the per-recipient body —
-- the thing that proves what was actually said and whether merge fields
-- resolved — existed only inside the outbox payload, which is transient
-- plumbing (rows are settled/dead-lettered and never surfaced to organisers).
-- The Messages tab's detail view therefore showed To/Queued/Sent metadata and
-- nothing else.
--
-- Store the rendered body on the log row itself at queue time, both variants
-- the provider receives. Nullable by necessity: rows written before this
-- migration have no recorded body, and the UI says so rather than pretending.
ALTER TABLE message_log ADD COLUMN body_html TEXT;
ALTER TABLE message_log ADD COLUMN body_text TEXT;
