-- Green room speaker check-in (workplan 12). Arrival is a single
-- per-(event, contact) state like biography/headshot, so it lives on
-- event_contacts rather than a checkins table: one arrival per event, undo is
-- a NULL, and there is no audit-history requirement. A separate
-- event_contact_checkins table only pays off for multiple check-in points or
-- a history trail, neither of which is in scope.
--
-- Airtable mirror: deliberately not wired. event_contacts is not in
-- SYNC_TABLES (packages/airtable/src/sync.ts) and carries no updated_at, so it
-- cannot ride the watermark sweep without adding one; arrival state is a
-- day-of operational flag, not spreadsheet-shaped data.
ALTER TABLE event_contacts ADD COLUMN arrived_at TEXT;           -- UTC ISO, NULL = not arrived
ALTER TABLE event_contacts ADD COLUMN arrival_marked_by TEXT REFERENCES contacts(id);
