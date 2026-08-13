-- Serve the organisation directory's "most recent membership" lookup without
-- sorting every contact's event_contact rows into a temporary B-tree.
CREATE INDEX IF NOT EXISTS idx_event_contacts_contact_recent
  ON event_contacts (contact_id, added_at DESC, event_id DESC);

-- Confirmation and speaker-status were previously derived through up to four
-- correlated participant probes for every roster row. Keep the two tiny
-- counters on the event membership instead, with triggers covering every
-- participant write path (including imports and cascades).
ALTER TABLE event_contacts ADD COLUMN participant_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE event_contacts ADD COLUMN confirmed_participant_count INTEGER NOT NULL DEFAULT 0;

UPDATE event_contacts
SET participant_count = (
      SELECT COUNT(*)
      FROM submission_participants sp
      JOIN submissions s ON s.id = sp.submission_id
      WHERE sp.contact_id = event_contacts.contact_id
        AND s.event_id = event_contacts.event_id
    ),
    confirmed_participant_count = (
      SELECT COUNT(*)
      FROM submission_participants sp
      JOIN submissions s ON s.id = sp.submission_id
      WHERE sp.contact_id = event_contacts.contact_id
        AND s.event_id = event_contacts.event_id
        AND sp.confirmed_at IS NOT NULL
    );

CREATE TRIGGER event_contacts_participant_counts_insert
AFTER INSERT ON event_contacts
BEGIN
  UPDATE event_contacts
  SET participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = NEW.contact_id AND s.event_id = NEW.event_id
      ),
      confirmed_participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = NEW.contact_id AND s.event_id = NEW.event_id
          AND sp.confirmed_at IS NOT NULL
      )
  WHERE contact_id = NEW.contact_id AND event_id = NEW.event_id;
END;

CREATE TRIGGER submission_participants_counts_insert
AFTER INSERT ON submission_participants
BEGIN
  UPDATE event_contacts
  SET participant_count = participant_count + 1,
      confirmed_participant_count = confirmed_participant_count +
        CASE WHEN NEW.confirmed_at IS NOT NULL THEN 1 ELSE 0 END
  WHERE contact_id = NEW.contact_id
    AND event_id = (SELECT event_id FROM submissions WHERE id = NEW.submission_id);
END;

CREATE TRIGGER submission_participants_counts_delete
AFTER DELETE ON submission_participants
BEGIN
  UPDATE event_contacts
  SET participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = OLD.contact_id AND s.event_id = event_contacts.event_id
      ),
      confirmed_participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = OLD.contact_id AND s.event_id = event_contacts.event_id
          AND sp.confirmed_at IS NOT NULL
      )
  WHERE contact_id = OLD.contact_id;
END;

CREATE TRIGGER submission_participants_counts_update
AFTER UPDATE OF contact_id, submission_id, confirmed_at ON submission_participants
BEGIN
  UPDATE event_contacts
  SET participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id
      ),
      confirmed_participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id
          AND sp.confirmed_at IS NOT NULL
      )
  WHERE contact_id IN (OLD.contact_id, NEW.contact_id);
END;

CREATE TRIGGER submissions_participant_counts_event_update
AFTER UPDATE OF event_id ON submissions
WHEN OLD.event_id <> NEW.event_id
BEGIN
  UPDATE event_contacts
  SET participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id
      ),
      confirmed_participant_count = (
        SELECT COUNT(*) FROM submission_participants sp
        JOIN submissions s ON s.id = sp.submission_id
        WHERE sp.contact_id = event_contacts.contact_id AND s.event_id = event_contacts.event_id
          AND sp.confirmed_at IS NOT NULL
      )
  WHERE contact_id IN (
    SELECT contact_id FROM submission_participants WHERE submission_id = NEW.id
  );
END;

-- Make rating_cache a database invariant rather than relying on one API write
-- path. The API's explicit refresh remains harmless and preserves its atomic
-- batch semantics; imports, maintenance scripts, and future writers are now
-- covered as well.
CREATE TRIGGER reviews_rating_cache_insert
AFTER INSERT ON reviews
BEGIN
  UPDATE submissions SET rating_cache = CASE
    WHEN (SELECT AVG(weighted_total) FROM reviews
          WHERE submission_id = NEW.submission_id AND plan_id = NEW.plan_id) IS NULL
      THEN json_remove(COALESCE(rating_cache, '{}'), '$."' || NEW.plan_id || '"')
    ELSE json_set(
      COALESCE(rating_cache, '{}'),
      '$."' || NEW.plan_id || '"',
      (SELECT ROUND(AVG(weighted_total), 2) FROM reviews
       WHERE submission_id = NEW.submission_id AND plan_id = NEW.plan_id)
    )
  END WHERE id = NEW.submission_id;
END;

CREATE TRIGGER reviews_rating_cache_delete
AFTER DELETE ON reviews
BEGIN
  UPDATE submissions SET rating_cache = CASE
    WHEN (SELECT AVG(weighted_total) FROM reviews
          WHERE submission_id = OLD.submission_id AND plan_id = OLD.plan_id) IS NULL
      THEN json_remove(COALESCE(rating_cache, '{}'), '$."' || OLD.plan_id || '"')
    ELSE json_set(
      COALESCE(rating_cache, '{}'),
      '$."' || OLD.plan_id || '"',
      (SELECT ROUND(AVG(weighted_total), 2) FROM reviews
       WHERE submission_id = OLD.submission_id AND plan_id = OLD.plan_id)
    )
  END WHERE id = OLD.submission_id;
END;

CREATE TRIGGER reviews_rating_cache_update
AFTER UPDATE OF submission_id, plan_id, weighted_total ON reviews
BEGIN
  UPDATE submissions SET rating_cache = CASE
    WHEN (SELECT AVG(weighted_total) FROM reviews
          WHERE submission_id = OLD.submission_id AND plan_id = OLD.plan_id) IS NULL
      THEN json_remove(COALESCE(rating_cache, '{}'), '$."' || OLD.plan_id || '"')
    ELSE json_set(
      COALESCE(rating_cache, '{}'),
      '$."' || OLD.plan_id || '"',
      (SELECT ROUND(AVG(weighted_total), 2) FROM reviews
       WHERE submission_id = OLD.submission_id AND plan_id = OLD.plan_id)
    )
  END WHERE id = OLD.submission_id;

  UPDATE submissions SET rating_cache = CASE
    WHEN (SELECT AVG(weighted_total) FROM reviews
          WHERE submission_id = NEW.submission_id AND plan_id = NEW.plan_id) IS NULL
      THEN json_remove(COALESCE(rating_cache, '{}'), '$."' || NEW.plan_id || '"')
    ELSE json_set(
      COALESCE(rating_cache, '{}'),
      '$."' || NEW.plan_id || '"',
      (SELECT ROUND(AVG(weighted_total), 2) FROM reviews
       WHERE submission_id = NEW.submission_id AND plan_id = NEW.plan_id)
    )
  END WHERE id = NEW.submission_id;
END;
