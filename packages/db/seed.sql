-- Demo event from docs/12 §2. Idempotent so `npm run seed:local` can be re-run.
DELETE FROM events WHERE slug = 'ai-engineer-sandbox-event';

INSERT INTO events (id, org_id, slug, name, theme, timezone, location, starts_on, ends_on)
VALUES (
  'evt_demo',
  'org_demo',
  'ai-engineer-sandbox-event',
  'AI.Engineer Sandbox Event – NYC',
  'Test Event for NYC',
  'America/Los_Angeles',
  'New York, NY',
  '2026-10-12',
  '2026-10-14'
);
