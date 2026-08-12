-- SPK-04: settable speaker workflow status. No CHECK (0026 precedent);
-- vocabulary = built-ins (prospect/invited/awaiting_reply/confirmed/declined)
-- + this event's speaker_status_options rows, validated in the API.
ALTER TABLE event_contacts ADD COLUMN speaker_status TEXT;

CREATE TABLE speaker_status_options (
  id       TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  label    TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, key)
);

-- Backfill from the derived confirmation state: confirmed participant ->
-- 'confirmed'; participant with no confirmed row -> 'awaiting_reply'.
-- Everyone else stays NULL: an unset status is not a claim, and 'prospect'
-- is reserved for deliberate use.
UPDATE event_contacts SET speaker_status = 'confirmed'
 WHERE speaker_status IS NULL AND EXISTS (
   SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
   WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id
     AND sp.confirmed_at IS NOT NULL);
UPDATE event_contacts SET speaker_status = 'awaiting_reply'
 WHERE speaker_status IS NULL AND EXISTS (
   SELECT 1 FROM submission_participants sp JOIN submissions s ON s.id = sp.submission_id
   WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id);
