-- Seed data for the demo instance (docs/12 §2), M0 slice.
-- Idempotent: deletes the demo org/event first; every FK in the schema cascades
-- (or nulls) below events, so the two DELETEs clear all owned rows on re-run.
-- Fixed literal uuids so reseeding is stable.

DELETE FROM events WHERE slug = 'ai-engineer-sandbox-event';
DELETE FROM organisations WHERE slug = 'ai-engineer';

-- ---------------------------------------------------------------------------
-- Organisation & event
-- ---------------------------------------------------------------------------

INSERT INTO organisations (id, name, slug, created_at) VALUES
  ('org00000-0000-4000-8000-000000000001', 'AI.Engineer', 'ai-engineer', '2026-08-08T12:00:00Z');

INSERT INTO events (
  id, org_id, name, slug, type, website_url, location, timezone,
  starts_at, ends_at, theme, default_submission_limit, agenda_published,
  created_at, updated_at
) VALUES (
  'evt00000-0000-4000-8000-000000000001',
  'org00000-0000-4000-8000-000000000001',
  'AI.Engineer Sandbox Event – NYC',
  'ai-engineer-sandbox-event',
  'conference',
  'https://ai.engineer',
  'New York',
  'America/Los_Angeles',
  '2026-10-12T13:00:00Z', -- Oct 12 2026, 09:00 EDT
  '2026-10-14T22:00:00Z', -- Oct 14 2026, 18:00 EDT
  'Test Event for NYC',
  3, 0,
  '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'
);

-- ---------------------------------------------------------------------------
-- Tracks, rooms, tags (docs/12 §2)
-- ---------------------------------------------------------------------------

INSERT INTO tracks (id, event_id, name, color, position, updated_at) VALUES
  ('trk00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Agents',           '#6366f1', 1, '2026-08-01T00:00:00.000Z'),
  ('trk00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Evals',            '#f59e0b', 2, '2026-08-01T00:00:00.000Z'),
  ('trk00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'RAG & Retrieval',  '#10b981', 3, '2026-08-01T00:00:00.000Z'),
  ('trk00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Infra & Serving',  '#0ea5e9', 4, '2026-08-01T00:00:00.000Z'),
  ('trk00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'AI in Production', '#ef4444', 5, '2026-08-01T00:00:00.000Z');

INSERT INTO rooms (id, event_id, name, capacity, position, notes, updated_at) VALUES
  ('room0000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Main Stage', 600, 1, NULL, '2026-08-01T00:00:00.000Z'),
  ('room0000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Hall A',     250, 2, NULL, '2026-08-01T00:00:00.000Z'),
  ('room0000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'Hall B',     250, 3, NULL, '2026-08-01T00:00:00.000Z'),
  ('room0000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Studio',      80, 4, NULL, '2026-08-01T00:00:00.000Z'),
  ('room0000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'Pavilion',   120, 5, NULL, '2026-08-01T00:00:00.000Z'),
  ('room0000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'Lounge',      40, 6, NULL, '2026-08-01T00:00:00.000Z');

INSERT INTO tags (id, event_id, name, color, updated_at) VALUES
  ('tag00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Open Source', '#22c55e', '2026-08-01T00:00:00.000Z'),
  ('tag00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Research',    '#8b5cf6', '2026-08-01T00:00:00.000Z'),
  ('tag00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'Production',  '#0ea5e9', '2026-08-01T00:00:00.000Z'),
  ('tag00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Sponsor',     '#f97316', '2026-08-01T00:00:00.000Z');

-- ---------------------------------------------------------------------------
-- Field definitions — default abstract set (docs/04 §2.3) + participant set (§2.4)
-- ---------------------------------------------------------------------------

INSERT INTO field_definitions (id, event_id, key, label, type, scope, options, max_chars, system) VALUES
  -- abstract (submission scope)
  ('fld00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'title',             'Title',             'text',        'submission', NULL, 255, 1),
  ('fld00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'description',       'Description',       'wysiwyg',     'submission', NULL, 5000, 0),
  ('fld00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'format',            'Format',            'dropdown',    'submission',
    '[{"value":"Keynote","label":"Keynote"},{"value":"Featured Keynote","label":"Featured Keynote"},{"value":"Talk","label":"Talk"},{"value":"Workshop","label":"Workshop"},{"value":"Panel","label":"Panel"},{"value":"Lightning Talk","label":"Lightning Talk"}]', NULL, 0),
  ('fld00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'tags',              'Tags',              'multiselect', 'submission',
    '[{"value":"Open Source","label":"Open Source"},{"value":"Research","label":"Research"},{"value":"Production","label":"Production"},{"value":"Sponsor","label":"Sponsor"}]', NULL, 0),
  -- The canonical `track` field carries no stored options: loadQuestions
  -- derives them from this event's `tracks` rows on every load, so renaming or
  -- deleting a track cannot leave a form offering a name that resolves to
  -- nothing. See formsAdmin.ts's TRACK_FIELD_KEY.
  ('fld00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'track',             'Track',             'dropdown',    'submission',
    NULL, NULL, 0),
  ('fld00000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'level',             'Level',             'dropdown',    'submission',
    '[{"value":"Beginner","label":"Beginner"},{"value":"Intermediate","label":"Intermediate"},{"value":"Advanced","label":"Advanced"}]', NULL, 0),
  ('fld00000-0000-4000-8000-000000000007', 'evt00000-0000-4000-8000-000000000001', 'language',          'Language',          'dropdown',    'submission',
    '[{"value":"English","label":"English"},{"value":"Spanish","label":"Spanish"},{"value":"French","label":"French"}]', NULL, 0),
  ('fld00000-0000-4000-8000-000000000008', 'evt00000-0000-4000-8000-000000000001', 'capacity',          'Capacity',          'number',      'submission', NULL, NULL, 0),
  ('fld00000-0000-4000-8000-000000000009', 'evt00000-0000-4000-8000-000000000001', 'ceu_credits',       'CEU Credits',       'number',      'submission', NULL, NULL, 0),
  ('fld00000-0000-4000-8000-000000000010', 'evt00000-0000-4000-8000-000000000001', 'client_session_id', 'Client Session ID', 'text',        'submission', NULL, 255, 0),
  -- participant (contact scope)
  ('fld00000-0000-4000-8000-000000000011', 'evt00000-0000-4000-8000-000000000001', 'first_name',        'First Name',        'text',        'contact',    NULL, 255, 1),
  ('fld00000-0000-4000-8000-000000000012', 'evt00000-0000-4000-8000-000000000001', 'last_name',         'Last Name',         'text',        'contact',    NULL, 255, 1),
  ('fld00000-0000-4000-8000-000000000013', 'evt00000-0000-4000-8000-000000000001', 'email',             'Email',             'email',       'contact',    NULL, 255, 1),
  ('fld00000-0000-4000-8000-000000000014', 'evt00000-0000-4000-8000-000000000001', 'mobile_phone',      'Mobile Phone',      'phone',       'contact',    NULL, NULL, 0),
  ('fld00000-0000-4000-8000-000000000015', 'evt00000-0000-4000-8000-000000000001', 'biography',         'Biography',         'wysiwyg',     'contact',    NULL, 5000, 0),
  ('fld00000-0000-4000-8000-000000000016', 'evt00000-0000-4000-8000-000000000001', 'headshot',          'Headshot',          'file',        'contact',    NULL, NULL, 0),
  -- workshop-only fields (docs/04 §3 worked example)
  ('fld00000-0000-4000-8000-000000000017', 'evt00000-0000-4000-8000-000000000001', 'room_setup',        'Room Setup Requirements', 'textarea', 'submission', NULL, 1000, 0),
  ('fld00000-0000-4000-8000-000000000018', 'evt00000-0000-4000-8000-000000000001', 'prerequisites',     'Prerequisites',           'textarea', 'submission', NULL, 1000, 0);

-- ---------------------------------------------------------------------------
-- Submission form: Call for Speakers 2026 (the form judges use)
-- Close: 2026-09-15 23:59 America/Los_Angeles (PDT, UTC-7) = 2026-09-16T06:59:00Z
-- ---------------------------------------------------------------------------

INSERT INTO submission_forms (
  id, event_id, internal_name, external_title, page_heading,
  welcome_message, welcome_message_visible, collection_type, collect_participants,
  status, close_at, submission_limit, allow_multiple_drafts,
  success_message, auto_redirect_to_portal, confirmation_email_enabled,
  created_at, updated_at
) VALUES (
  'form0000-0000-4000-8000-000000000001',
  'evt00000-0000-4000-8000-000000000001',
  'Call for Speakers 2026',
  'AI.Engineer NYC — Call for Speakers 2026',
  'Speak at NYC', -- 12 chars (15-char cap)
  '<h2>Welcome!</h2><p>We are looking for talks across Agents, Evals, RAG &amp; Retrieval, Infra &amp; Serving and AI in Production. Submissions close <strong>September 15, 2026</strong>.</p>',
  1, 'abstracts', 1,
  'open', '2026-09-16T06:59:00Z', 3, 0,
  '<p>Thanks for your proposal! Our track leads will review it and you will hear back by email.</p>',
  1, 1,
  '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'
);

INSERT INTO form_questions (id, form_id, section, field_id, label, help_text, position, required, locked, max_chars) VALUES
  -- abstract section (docs/04 §2.3 defaults)
  ('q0000000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000001', 'Title', NULL, 1, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000002', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000002', 'Description', 'What will attendees learn?', 2, 1, 0, 5000),
  ('q0000000-0000-4000-8000-000000000003', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000003', 'Format', NULL, 3, 1, 0, NULL),
  ('q0000000-0000-4000-8000-000000000004', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000004', 'Tags', NULL, 4, 1, 0, NULL),
  ('q0000000-0000-4000-8000-000000000005', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000005', 'Track', NULL, 5, 1, 0, NULL),
  ('q0000000-0000-4000-8000-000000000006', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000006', 'Level', NULL, 6, 0, 0, NULL),
  ('q0000000-0000-4000-8000-000000000007', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000007', 'Language', NULL, 7, 0, 0, NULL),
  ('q0000000-0000-4000-8000-000000000008', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000008', 'Capacity', 'Expected attendees', 8, 0, 0, NULL),
  ('q0000000-0000-4000-8000-000000000009', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000009', 'CEU Credits', NULL, 9, 0, 0, NULL),
  ('q0000000-0000-4000-8000-000000000010', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000010', 'Client Session ID', NULL, 10, 0, 0, 255),
  -- participant section (docs/04 §2.4 defaults)
  ('q0000000-0000-4000-8000-000000000011', 'form0000-0000-4000-8000-000000000001', 'participant', 'fld00000-0000-4000-8000-000000000011', 'First Name', NULL, 1, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000012', 'form0000-0000-4000-8000-000000000001', 'participant', 'fld00000-0000-4000-8000-000000000012', 'Last Name', NULL, 2, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000013', 'form0000-0000-4000-8000-000000000001', 'participant', 'fld00000-0000-4000-8000-000000000013', 'Email', NULL, 3, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000014', 'form0000-0000-4000-8000-000000000001', 'participant', 'fld00000-0000-4000-8000-000000000014', 'Mobile Phone', NULL, 4, 0, 0, NULL),
  ('q0000000-0000-4000-8000-000000000015', 'form0000-0000-4000-8000-000000000001', 'participant', 'fld00000-0000-4000-8000-000000000015', 'Biography', 'A short bio for the programme', 5, 0, 0, 5000);

-- The demo's conditional questions: choosing Format = Workshop reveals room
-- setup + prerequisites (docs/12 §2 form 1; visibility per docs/02 §3).
INSERT INTO form_questions (id, form_id, section, field_id, label, help_text, position, required, locked, max_chars, visibility) VALUES
  ('q0000000-0000-4000-8000-000000000016', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000017', 'Room Setup Requirements', 'Layout, AV and anything the venue must provide', 11, 1, 0, 1000,
   '{"action":"show","match":"all","conditions":[{"question_id":"q0000000-0000-4000-8000-000000000003","op":"equals","value":"Workshop"}]}'),
  ('q0000000-0000-4000-8000-000000000017', 'form0000-0000-4000-8000-000000000001', 'abstract', 'fld00000-0000-4000-8000-000000000018', 'Prerequisites', 'What should attendees know or install beforehand?', 12, 0, 0, 1000,
   '{"action":"show","match":"all","conditions":[{"question_id":"q0000000-0000-4000-8000-000000000003","op":"equals","value":"Workshop"}]}');

-- ---------------------------------------------------------------------------
-- Evaluation plans (docs/12 §2) — targets for the routing rules below; M3
-- attaches reviewers and criteria-driven scoring.
-- ---------------------------------------------------------------------------

INSERT INTO evaluation_plans (id, event_id, name, description, status, scoring_scale_min, scoring_scale_max, anonymise_submitters, created_at) VALUES
  ('plan0000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Round 1 — Track leads', 'First-pass review by track leads', 'active', 1, 5, 0, '2026-08-08T12:00:00Z'),
  ('plan0000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Workshops',             'Hands-on sessions need logistics review', 'active', 1, 5, 0, '2026-08-08T12:00:00Z'),
  ('plan0000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'General Review',        'Fallback plan for unrouted submissions', 'active', 1, 5, 0, '2026-08-08T12:00:00Z');

INSERT INTO scoring_criteria (id, plan_id, name, description, weight, allow_comment, position) VALUES
  ('crit0000-0000-4000-8000-000000000001', 'plan0000-0000-4000-8000-000000000001', 'Relevance',           'Fit with the track and audience', 2, 1, 1),
  ('crit0000-0000-4000-8000-000000000002', 'plan0000-0000-4000-8000-000000000001', 'Speaker credibility', 'Evidence the speaker can deliver', 1, 1, 2),
  ('crit0000-0000-4000-8000-000000000003', 'plan0000-0000-4000-8000-000000000001', 'Novelty',             'New results or perspective', 1, 1, 3);

-- Routing (docs/04 §4): tracks route to the track-leads plan, workshops
-- override to the Workshops plan and pick up the Production tag; anything
-- unmatched falls back to General Review.
UPDATE submission_forms SET
  participant_roles = '[{"role":"speaker","min":1,"max":null},{"role":"co-speaker","min":0,"max":3},{"role":"co-author","min":0,"max":null},{"role":"co-presenter","min":0,"max":null},{"role":"panelist","min":0,"max":5}]',
  routing_rules = '{"rules":[
    {"id":"r-tracks","when":{"question_id":"q0000000-0000-4000-8000-000000000005","op":"is_any_of","value":["Agents","Evals","RAG & Retrieval","Infra & Serving","AI in Production"]},"then":{"assign_evaluation_plan_id":"plan0000-0000-4000-8000-000000000001"}},
    {"id":"r-workshops","when":{"question_id":"q0000000-0000-4000-8000-000000000003","op":"equals","value":"Workshop"},"then":{"assign_evaluation_plan_id":"plan0000-0000-4000-8000-000000000002","add_tag_ids":["tag00000-0000-4000-8000-000000000003"]}}
  ],"fallback":{"assign_evaluation_plan_id":"plan0000-0000-4000-8000-000000000003"}}'
WHERE id = 'form0000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- Forms #2 and #3 (docs/12 §2): an open 1-submission form and a closed form
-- so the list and the closed state are demonstrable.
-- ---------------------------------------------------------------------------

INSERT INTO submission_forms (
  id, event_id, internal_name, external_title, page_heading,
  welcome_message, welcome_message_visible, collection_type, collect_participants,
  status, close_at, submission_limit, allow_multiple_drafts,
  success_message, auto_redirect_to_portal, confirmation_email_enabled,
  participant_roles, created_at, updated_at
) VALUES
  ('form0000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001',
   'Session Submission Form #2', 'Submit a Session', 'Sessions',
   '<p>Submit a full session proposal for the programme.</p>', 1, 'sessions', 1,
   'open', NULL, 1, 0,
   '<p>Thanks — your session is in.</p>', 1, 1,
   '[{"role":"speaker","min":1,"max":null},{"role":"co-speaker","min":0,"max":null},{"role":"co-author","min":0,"max":null},{"role":"co-presenter","min":0,"max":null},{"role":"panelist","min":0,"max":null}]',
   '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('form0000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001',
   'Lightning Talks', 'Lightning Talks — 5 minutes, big ideas', 'Lightning',
   '<p>Five minutes on stage. No slides required.</p>', 1, 'abstracts', 0,
   'closed', '2026-08-01T06:59:00Z', 1, 0,
   NULL, 1, 1,
   '[{"role":"speaker","min":1,"max":1}]',
   '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

INSERT INTO form_questions (id, form_id, section, field_id, label, help_text, position, required, locked, max_chars) VALUES
  ('q0000000-0000-4000-8000-000000000021', 'form0000-0000-4000-8000-000000000002', 'abstract', 'fld00000-0000-4000-8000-000000000001', 'Title', NULL, 1, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000022', 'form0000-0000-4000-8000-000000000002', 'abstract', 'fld00000-0000-4000-8000-000000000002', 'Description', NULL, 2, 1, 0, 5000),
  ('q0000000-0000-4000-8000-000000000023', 'form0000-0000-4000-8000-000000000002', 'abstract', 'fld00000-0000-4000-8000-000000000003', 'Format', NULL, 3, 1, 0, NULL),
  ('q0000000-0000-4000-8000-000000000024', 'form0000-0000-4000-8000-000000000002', 'participant', 'fld00000-0000-4000-8000-000000000011', 'First Name', NULL, 1, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000025', 'form0000-0000-4000-8000-000000000002', 'participant', 'fld00000-0000-4000-8000-000000000012', 'Last Name', NULL, 2, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000026', 'form0000-0000-4000-8000-000000000002', 'participant', 'fld00000-0000-4000-8000-000000000013', 'Email', NULL, 3, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000031', 'form0000-0000-4000-8000-000000000003', 'abstract', 'fld00000-0000-4000-8000-000000000001', 'Title', NULL, 1, 1, 1, 255),
  ('q0000000-0000-4000-8000-000000000032', 'form0000-0000-4000-8000-000000000003', 'abstract', 'fld00000-0000-4000-8000-000000000002', 'Pitch', 'One paragraph. Make it count.', 2, 1, 0, 1000);

-- ---------------------------------------------------------------------------
-- Contacts (admin + 7 speakers) and the owner event_user
-- ---------------------------------------------------------------------------

-- 0015: contacts are org-scoped identity only; the profile fields that used to
-- live here (company, job_title, biography, headshot_asset_id, notes) now live
-- on event_contacts, one row per (event, contact) — see below.
INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at) VALUES
  ('con00000-0000-4000-8000-000000000001', 'org00000-0000-4000-8000-000000000001', 'james@atelyr.com',              'James',    'Ellis-Jones', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000002', 'org00000-0000-4000-8000-000000000001', 'ada@example.com',               'Ada',      'Lovelace',    '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000003', 'org00000-0000-4000-8000-000000000001', 'grace.hopper@example.com',      'Grace',    'Hopper',      '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000004', 'org00000-0000-4000-8000-000000000001', 'alan.turing@example.com',       'Alan',     'Turing',      '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000005', 'org00000-0000-4000-8000-000000000001', 'margaret.hamilton@example.com', 'Margaret', 'Hamilton',    '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000006', 'org00000-0000-4000-8000-000000000001', 'joan.clarke@example.com',       'Joan',     'Clarke',      '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000007', 'org00000-0000-4000-8000-000000000001', 'claude.shannon@example.com',    'Claude',   'Shannon',     '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000008', 'org00000-0000-4000-8000-000000000001', 'barbara.liskov@example.com',    'Barbara',  'Liskov',      '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

-- Membership + per-event profile (company/job_title carried over from the old
-- contacts row; biography/headshot_asset_id are added below where they used
-- to be set via UPDATE contacts).
INSERT INTO event_contacts (event_id, contact_id, company, job_title, added_at, source) VALUES
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000001', 'Atelyr',        'Founder',              '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000002', 'Analytical Co', 'Principal Engineer',   '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000003', 'Flowmatic AI',  'VP Engineering',       '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000004', 'Enigma Labs',   'Research Scientist',   '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000005', 'Apollo Systems','Director of Software', '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000006', 'Cipher AI',     'Staff ML Engineer',    '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000007', 'Bitstream',     'CTO',                  '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000008', 'Substrate',     'Distinguished Eng',    '2026-08-08T12:00:00Z', 'admin');

INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000001', 'owner', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

-- ---------------------------------------------------------------------------
-- Speaker biographies (EMB-05/EMB-13, root cause of "bio never renders"):
-- the `contacts` INSERT above never set `biography`, so every seeded speaker
-- had a NULL bio and the public speaker detail page / gallery modal had
-- nothing to show — SpeakerDetailBody (packages/ui/widgets/SpeakerDetailWidget.tsx)
-- and the speakers.json feed (apps/api/src/routes/landing.tsx) were already
-- wired correctly end to end; there was just no data flowing through them.
-- Additive UPDATEs rather than reshaping the INSERT above, per this lane's
-- scope.
-- ---------------------------------------------------------------------------

-- Lane N1 (EMB-04): every seeded speaker previously fell back to the
-- initials tile because headshot_asset_id was never set — there was no real
-- R2/KV object for seed.sql (pure D1 SQL) to reference. Rather than fake a
-- file_assets row that would always 404 (no bytes behind it), most speakers
-- now point at a small set of static SVG avatars shipped as worker assets
-- (apps/public/public/avatars/*.svg, served at /static/avatars/*.svg — see
-- landing.tsx's speakers.json headshot_url mapping for the `/`-prefix
-- passthrough this relies on). Two speakers (Claude, Barbara) are left
-- without one so the initials fallback still has coverage in the demo.

-- 0015: biography now lives on event_contacts (per-event profile), not contacts.
UPDATE event_contacts SET biography = '<p>Ada is a principal engineer building tool-use guardrails for multi-agent systems, with a decade in developer platforms before that. She speaks regularly on reliability engineering for LLM-backed products.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000002';
UPDATE event_contacts SET biography = '<p>Grace leads engineering at Flowmatic AI, where she built the eval pipelines that now gate every model release. She previously ran platform infrastructure for two Series C startups.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000003';
UPDATE event_contacts SET biography = '<p>Alan is a research scientist at Enigma Labs working on hybrid retrieval and search ranking. His writing on evaluation methodology is widely cited in the applied-ML community.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000004';
UPDATE event_contacts SET biography = '<p>Margaret directs software engineering at Apollo Systems, where she champions rigorous tracing and replay tooling for production agent systems. She started her career writing mission-critical flight software.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000005';
UPDATE event_contacts SET biography = '<p>Joan is a staff ML engineer at Cipher AI, focused on guardrail benchmarking and CI-gated model evaluation. She mentors early-career engineers moving into applied ML.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000006';
UPDATE event_contacts SET biography = '<p>Claude is CTO of Bitstream, where he oversees the text-to-SQL platform serving enterprise analytics teams. He writes and speaks on grounding language models in structured data.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000007';
UPDATE event_contacts SET biography = '<p>Barbara is a distinguished engineer at Substrate working on prompt compression and serving efficiency for large language models. She previously led infrastructure teams at two cloud providers.</p>'
  WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000008';

-- headshot_asset_id is a real FK (D1 enforces it), so each static path needs
-- a backing file_assets row even though nothing ever reads its `key`/KV
-- bytes for these — landing.tsx's `/`-prefix check returns the id (the path
-- itself) straight from speakers.json before the gated /headshot route (and
-- thus loadFile/KV) is ever reached.
INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at) VALUES
  ('/static/avatars/speaker-1.svg', 'evt00000-0000-4000-8000-000000000001', 'static:avatars/speaker-1.svg', 'speaker-1.svg', 'image/svg+xml', 420, NULL, '2026-08-08T12:00:00Z'),
  ('/static/avatars/speaker-2.svg', 'evt00000-0000-4000-8000-000000000001', 'static:avatars/speaker-2.svg', 'speaker-2.svg', 'image/svg+xml', 420, NULL, '2026-08-08T12:00:00Z'),
  ('/static/avatars/speaker-3.svg', 'evt00000-0000-4000-8000-000000000001', 'static:avatars/speaker-3.svg', 'speaker-3.svg', 'image/svg+xml', 420, NULL, '2026-08-08T12:00:00Z'),
  ('/static/avatars/speaker-4.svg', 'evt00000-0000-4000-8000-000000000001', 'static:avatars/speaker-4.svg', 'speaker-4.svg', 'image/svg+xml', 420, NULL, '2026-08-08T12:00:00Z');

UPDATE event_contacts SET headshot_asset_id = '/static/avatars/speaker-1.svg' WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000002'; -- Ada
UPDATE event_contacts SET headshot_asset_id = '/static/avatars/speaker-2.svg' WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000003'; -- Grace
UPDATE event_contacts SET headshot_asset_id = '/static/avatars/speaker-3.svg' WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000004'; -- Alan
UPDATE event_contacts SET headshot_asset_id = '/static/avatars/speaker-4.svg' WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000005'; -- Margaret
UPDATE event_contacts SET headshot_asset_id = '/static/avatars/speaker-1.svg' WHERE event_id = 'evt00000-0000-4000-8000-000000000001' AND contact_id = 'con00000-0000-4000-8000-000000000006'; -- Joan
-- Claude (007) and Barbara (008) intentionally left without a headshot.

-- ---------------------------------------------------------------------------
-- Contact custom fields (SPK-15): 0009_contact_custom_fields.sql added the
-- Settings > Speaker fields mechanism, but this demo shipped with zero field
-- definitions, so the feature was invisible without an organiser manually
-- adding one first. Two sensible logistics fields, seeded so they render out
-- of the box on the Speakers create/edit form and detail panel. Reseeded
-- nightly along with everything else above (see this file's header comment).
-- ---------------------------------------------------------------------------

INSERT INTO contact_field_definitions (id, event_id, key, label, type, options, position) VALUES
  ('cfd00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'dietary_requirements', 'Dietary requirements', 'text', NULL, 0),
  ('cfd00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'tshirt_size', 'T-shirt size', 'select', '["XS","S","M","L","XL","XXL"]', 1);

-- ---------------------------------------------------------------------------
-- Submissions: 10 across statuses — 2 accepted, 1 accept_queue, 4 pending,
-- 1 declined, 1 withdrawn, 1 draft. Ada submits 3 (SESS-1, SESS-4, SESS-10).
-- ---------------------------------------------------------------------------

INSERT INTO submissions (
  id, event_id, form_id, code, kind, title, description, status,
  track_id, format, level, language, submitter_contact_id, notified_at, source,
  created_at, updated_at
) VALUES
  ('sub00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-1', 'abstract', 'Building Reliable Multi-Agent Pipelines with Tool-Use Guardrails',
   -- Lane N1 (EMB-01): extended past the 160/180-char truncation threshold
   -- so the itinerary/session-list "Show more" toggle has something to do.
   '<p>Patterns for keeping tool-calling agents on the rails: typed tool schemas, permission scopes, replayable traces and failure budgets. We will walk through production incidents where each guardrail earned its keep, and the failure modes that slipped through anyway.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000001', 'Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000002', '2026-08-05T17:00:00Z', 'form',
   '2026-08-01T09:00:00Z', '2026-08-05T17:00:00Z'),

  ('sub00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-2', 'abstract', 'Eval-Driven Development: Shipping LLM Features with Confidence',
   '<p>How we replaced vibes with a regression suite: golden sets, LLM-as-judge calibration, and gating deploys on eval deltas.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000002', 'Talk', 'Beginner', 'English',
   'con00000-0000-4000-8000-000000000003', '2026-08-05T17:05:00Z', 'form',
   '2026-08-01T10:00:00Z', '2026-08-05T17:05:00Z'),

  ('sub00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-3', 'abstract', 'Hybrid Search in Production: Fusing BM25, Vectors and Rerankers',
   '<p>A hands-on workshop building a hybrid retrieval stack, with ablation results from three production deployments.</p>',
   'accept_queue', 'trk00000-0000-4000-8000-000000000003', 'Workshop', 'Advanced', 'English',
   'con00000-0000-4000-8000-000000000004', NULL, 'form',
   '2026-08-02T09:30:00Z', '2026-08-06T11:00:00Z'),

  ('sub00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-4', 'abstract', 'From Prototype to Platform: Scaling RAG to 40 Million Documents',
   '<p>Chunking strategy, index sharding, freshness pipelines and the cost curve nobody warned us about.</p>',
   'pending', 'trk00000-0000-4000-8000-000000000003', 'Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000002', NULL, 'form',
   '2026-08-02T14:00:00Z', '2026-08-02T14:00:00Z'),

  ('sub00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-5', 'abstract', 'Serving 70B Models on a Budget: Quantization and Speculative Decoding',
   '<p>Latency and cost numbers from serving large open-weight models with INT4 quantization, paged KV cache and speculative decoding.</p>',
   'pending', 'trk00000-0000-4000-8000-000000000004', 'Talk', 'Advanced', 'English',
   'con00000-0000-4000-8000-000000000005', NULL, 'form',
   '2026-08-03T08:45:00Z', '2026-08-03T08:45:00Z'),

  ('sub00000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-6', 'abstract', 'The Agent Ops Playbook: Tracing, Replay and Regression Suites',
   '<p>A workshop on operating agents in production: OpenTelemetry traces, deterministic replay and building a regression corpus from incidents.</p>',
   'pending', 'trk00000-0000-4000-8000-000000000005', 'Workshop', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000006', NULL, 'form',
   '2026-08-03T16:20:00Z', '2026-08-03T16:20:00Z'),

  ('sub00000-0000-4000-8000-000000000007', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-7', 'abstract', 'Grounding LLMs in Structured Data: A Year of Text-to-SQL in Production',
   '<p>Schema linking, query validation, and the human-in-the-loop review queue that took accuracy from 62% to 94%.</p>',
   'pending', 'trk00000-0000-4000-8000-000000000001', 'Panel', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000007', NULL, 'form',
   '2026-08-04T11:10:00Z', '2026-08-04T11:10:00Z'),

  ('sub00000-0000-4000-8000-000000000008', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-8', 'abstract', 'Prompt Compression Is All You Need? A Cautionary Tale',
   '<p>We compressed prompts by 80% and our support tickets tripled. What the benchmarks missed.</p>',
   'declined', 'trk00000-0000-4000-8000-000000000002', 'Lightning Talk', 'Beginner', 'English',
   'con00000-0000-4000-8000-000000000008', '2026-08-06T15:00:00Z', 'form',
   '2026-08-04T13:40:00Z', '2026-08-06T15:00:00Z'),

  ('sub00000-0000-4000-8000-000000000009', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-9', 'abstract', 'Fine-Tuning vs. RAG: A Decision Framework for Enterprise Teams',
   '<p>A framework for choosing between fine-tuning, retrieval and hybrid approaches, with cost and maintenance trade-offs.</p>',
   'withdrawn', 'trk00000-0000-4000-8000-000000000005', 'Talk', 'Beginner', 'English',
   'con00000-0000-4000-8000-000000000003', NULL, 'form',
   '2026-08-05T09:15:00Z', '2026-08-07T10:00:00Z'),

  ('sub00000-0000-4000-8000-000000000010', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-10', 'abstract', 'Streaming Function Calls: UX Patterns for Realtime Agents',
   '<p>Draft: patterns for progressive rendering of tool results, optimistic UI and cancellation in agent frontends.</p>',
   'draft', 'trk00000-0000-4000-8000-000000000001', 'Lightning Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000002', NULL, 'form',
   '2026-08-07T18:30:00Z', '2026-08-07T18:30:00Z');

-- Submitters linked as primary speaker
INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at) VALUES
  ('sp000000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000002', 'speaker', 1, 1, '2026-08-01T09:00:00Z'),
  ('sp000000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000003', 'speaker', 1, 1, '2026-08-01T10:00:00Z'),
  ('sp000000-0000-4000-8000-000000000003', 'sub00000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000004', 'speaker', 1, 1, '2026-08-02T09:30:00Z'),
  ('sp000000-0000-4000-8000-000000000004', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000002', 'speaker', 1, 1, '2026-08-02T14:00:00Z'),
  ('sp000000-0000-4000-8000-000000000005', 'sub00000-0000-4000-8000-000000000005', 'con00000-0000-4000-8000-000000000005', 'speaker', 1, 1, '2026-08-03T08:45:00Z'),
  ('sp000000-0000-4000-8000-000000000006', 'sub00000-0000-4000-8000-000000000006', 'con00000-0000-4000-8000-000000000006', 'speaker', 1, 1, '2026-08-03T16:20:00Z'),
  ('sp000000-0000-4000-8000-000000000007', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000007', 'speaker', 1, 1, '2026-08-04T11:10:00Z'),
  ('sp000000-0000-4000-8000-000000000008', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000008', 'speaker', 1, 1, '2026-08-04T13:40:00Z'),
  ('sp000000-0000-4000-8000-000000000009', 'sub00000-0000-4000-8000-000000000009', 'con00000-0000-4000-8000-000000000003', 'speaker', 1, 1, '2026-08-05T09:15:00Z'),
  ('sp000000-0000-4000-8000-000000000010', 'sub00000-0000-4000-8000-000000000010', 'con00000-0000-4000-8000-000000000002', 'speaker', 1, 1, NULL);

-- ---------------------------------------------------------------------------
-- M2: portal work items (docs/12 §2 tasks) — 4 speakers with outstanding
-- tasks, 2 of them overdue (Speaker Agreement was due Aug 5).
-- ---------------------------------------------------------------------------

INSERT INTO email_themes (id, event_id, name, primary_color, background_color) VALUES
  ('thm00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'AI.Engineer default', '#2563eb', '#f5f6f8');

INSERT INTO file_requests (id, event_id, title, type, instructions, allowed_types, max_size_mb, due_at, created_at) VALUES
  ('fr000000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Presentation Slides', 'submissions',
   '<p>Upload your final deck as PDF or PowerPoint.</p>', '["application/pdf","application/vnd.openxmlformats-officedocument.presentationml.presentation"]',
   20, '2026-09-28T07:00:00Z', '2026-08-08T12:00:00Z');

INSERT INTO portal_forms (id, event_id, name, title, type, questions, send_confirmation_email, created_at) VALUES
  ('pf000000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Hotel & Travel', 'Hotel and Travel Reservations', 'contacts',
   '[{"id":"q_hotel","label":"Do you need a hotel room?","type":"dropdown","required":true,"options":[{"value":"yes","label":"Yes, please book for me"},{"value":"no","label":"No, I will arrange my own"}]},
     {"id":"q_checkin","label":"Check-in date","type":"date"},
     {"id":"q_checkout","label":"Check-out date","type":"date"},
     {"id":"q_notes","label":"Travel notes (arrival time, accessibility, dietary)","type":"textarea"}]',
   1, '2026-08-08T12:00:00Z');

INSERT INTO tasks (id, event_id, title, description, target, assignment_mode, "trigger", action_type,
                   portal_form_id, file_request_id, due_at, reminder_offsets_days, required, created_at, updated_at) VALUES
  ('task0000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Presentation Upload',
   '<p>Upload your final presentation for review.</p>', 'submission', 'automatic', 'on_accept', 'file_upload',
   NULL, 'fr000000-0000-4000-8000-000000000001', '2026-09-28T07:00:00Z', '[7,2,0]', 1, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Speaker Profile & Headshot',
   '<p>Complete your biography and upload a headshot in your portal profile — both appear in the printed programme.</p>',
   'contact', 'manual', 'none', 'acknowledge', NULL, NULL, '2026-09-12T07:00:00Z', '[7,2]', 0, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'Hotel and Travel Reservations',
   '<p>Tell us your travel plans so we can book accommodation.</p>', 'contact', 'manual', 'none', 'portal_form',
   'pf000000-0000-4000-8000-000000000001', NULL, '2026-09-21T07:00:00Z', '[7,2,0]', 0, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Speaker Agreement',
   '<p>Please read the speaker agreement at https://ai.engineer/speaker-agreement and confirm your acceptance.</p>',
   'contact', 'manual', 'none', 'acknowledge', NULL, NULL, '2026-08-05T07:00:00Z', '[2,0]', 1, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status, completed_at, response_id) VALUES
  -- Ada: three open (agreement overdue) — the anchor speaker for the demo
  ('ta000000-0000-4000-8000-000000000001', 'task0000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000001', 'not_started', NULL, NULL),
  ('ta000000-0000-4000-8000-000000000002', 'task0000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000002', NULL, 'not_started', NULL, NULL),
  ('ta000000-0000-4000-8000-000000000003', 'task0000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000002', NULL, 'not_started', NULL, NULL),
  -- Grace: two open (agreement overdue)
  ('ta000000-0000-4000-8000-000000000004', 'task0000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000003', 'sub00000-0000-4000-8000-000000000002', 'not_started', NULL, NULL),
  ('ta000000-0000-4000-8000-000000000005', 'task0000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000003', NULL, 'not_started', NULL, NULL),
  -- Alan: hotel form open
  ('ta000000-0000-4000-8000-000000000006', 'task0000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000004', NULL, 'not_started', NULL, NULL),
  -- Margaret: profile task open
  ('ta000000-0000-4000-8000-000000000007', 'task0000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000005', NULL, 'not_started', NULL, NULL),
  -- Joan: one already complete, for contrast
  ('ta000000-0000-4000-8000-000000000008', 'task0000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000006', NULL, 'complete', '2026-08-07T09:00:00Z', NULL);

-- Seeded submissions land on the plans the routing rules would have chosen.
UPDATE submissions SET evaluation_plan_id = 'plan0000-0000-4000-8000-000000000002'
WHERE id IN ('sub00000-0000-4000-8000-000000000003', 'sub00000-0000-4000-8000-000000000006');
UPDATE submissions SET evaluation_plan_id = 'plan0000-0000-4000-8000-000000000001'
WHERE id IN ('sub00000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000002',
             'sub00000-0000-4000-8000-000000000004', 'sub00000-0000-4000-8000-000000000005',
             'sub00000-0000-4000-8000-000000000007', 'sub00000-0000-4000-8000-000000000008');

-- ---------------------------------------------------------------------------
-- M3: reviewers, assignments and a ~65%-complete first review round
-- (docs/12 §2 evaluation) so Review Progress and the rating column have data.
-- Weighted totals follow docs/06 §4: Σ(score×weight)/Σ(weight).
-- ---------------------------------------------------------------------------

INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at) VALUES
  ('con00000-0000-4000-8000-000000000009', 'org00000-0000-4000-8000-000000000001', 'rosalind.franklin@example.com', 'Rosalind', 'Franklin', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000010', 'org00000-0000-4000-8000-000000000001', 'vint.cerf@example.com',         'Vint',     'Cerf',     '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000011', 'org00000-0000-4000-8000-000000000001', 'frances.allen@example.com',     'Frances',  'Allen',    '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

INSERT INTO event_contacts (event_id, contact_id, company, job_title, added_at, source) VALUES
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000009', 'Crystal Insights', 'Track Lead — Agents', '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000010', 'Internetworks',    'Track Lead — Infra',  '2026-08-08T12:00:00Z', 'admin'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000011', 'Compiler Works',   'Track Lead — Evals',  '2026-08-08T12:00:00Z', 'admin');

INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000009', 'reviewer', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000010', 'reviewer', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000011', 'reviewer', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

-- Workshops plan gets its own criteria (Round 1's were seeded in M1).
INSERT INTO scoring_criteria (id, plan_id, name, description, weight, allow_comment, position) VALUES
  ('crit0000-0000-4000-8000-000000000004', 'plan0000-0000-4000-8000-000000000002', 'Hands-on value',        'Will attendees build something real?', 2, 1, 1),
  ('crit0000-0000-4000-8000-000000000005', 'plan0000-0000-4000-8000-000000000002', 'Logistics feasibility', 'Room, kit and prerequisites realistic?', 1, 1, 2);

-- Round 1: all three reviewers across the six routed submissions (18 rows).
INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at, completed_at) VALUES
  ('ra000000-0000-4000-8000-000000000001', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T10:00:00Z'),
  ('ra000000-0000-4000-8000-000000000002', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T11:00:00Z'),
  ('ra000000-0000-4000-8000-000000000003', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000011', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000004', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T10:20:00Z'),
  ('ra000000-0000-4000-8000-000000000005', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T12:00:00Z'),
  ('ra000000-0000-4000-8000-000000000006', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000011', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000007', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T14:00:00Z'),
  ('ra000000-0000-4000-8000-000000000008', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T15:00:00Z'),
  ('ra000000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000011', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000005', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T16:00:00Z'),
  ('ra000000-0000-4000-8000-000000000011', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000005', 'con00000-0000-4000-8000-000000000010', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000012', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000005', 'con00000-0000-4000-8000-000000000011', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000013', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000009', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000014', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T17:00:00Z'),
  ('ra000000-0000-4000-8000-000000000015', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000011', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T18:00:00Z'),
  ('ra000000-0000-4000-8000-000000000016', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T09:30:00Z'),
  ('ra000000-0000-4000-8000-000000000017', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T09:45:00Z'),
  ('ra000000-0000-4000-8000-000000000018', 'plan0000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000011', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T10:15:00Z'),
  -- Workshops plan: two reviewers on the two workshop submissions.
  ('ra000000-0000-4000-8000-000000000019', 'plan0000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000009', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T13:00:00Z'),
  ('ra000000-0000-4000-8000-000000000020', 'plan0000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000010', 'complete', '2026-08-06T09:00:00Z', '2026-08-07T13:30:00Z'),
  ('ra000000-0000-4000-8000-000000000021', 'plan0000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000006', 'con00000-0000-4000-8000-000000000009', 'pending',  '2026-08-06T09:00:00Z', NULL),
  ('ra000000-0000-4000-8000-000000000022', 'plan0000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000006', 'con00000-0000-4000-8000-000000000010', 'pending',  '2026-08-06T09:00:00Z', NULL);

-- Reviews: scores {criterion_id: n}; weighted = (relevance×2 + cred + novelty)/4.
INSERT INTO reviews (id, assignment_id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, comment, conflict_of_interest, created_at, updated_at) VALUES
  ('rvw00000-0000-4000-8000-000000000001', 'ra000000-0000-4000-8000-000000000001', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":5,"crit0000-0000-4000-8000-000000000002":4,"crit0000-0000-4000-8000-000000000003":4}', 4.5, 'Exactly the reliability content our audience asks for.', 0, '2026-08-07T10:00:00Z', '2026-08-07T10:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000002', 'ra000000-0000-4000-8000-000000000002', 'sub00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":5,"crit0000-0000-4000-8000-000000000002":5,"crit0000-0000-4000-8000-000000000003":4}', 4.75, 'Strong speaker, proven material.', 0, '2026-08-07T11:00:00Z', '2026-08-07T11:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000003', 'ra000000-0000-4000-8000-000000000004', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":4,"crit0000-0000-4000-8000-000000000002":5,"crit0000-0000-4000-8000-000000000003":4}', 4.25, 'Beginner-friendly and practical.', 0, '2026-08-07T10:20:00Z', '2026-08-07T10:20:00Z'),
  ('rvw00000-0000-4000-8000-000000000004', 'ra000000-0000-4000-8000-000000000005', 'sub00000-0000-4000-8000-000000000002', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":4,"crit0000-0000-4000-8000-000000000002":4,"crit0000-0000-4000-8000-000000000003":4}', 4.0, NULL, 0, '2026-08-07T12:00:00Z', '2026-08-07T12:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000005', 'ra000000-0000-4000-8000-000000000007', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":4,"crit0000-0000-4000-8000-000000000002":3,"crit0000-0000-4000-8000-000000000003":4}', 3.75, 'Good scale story; sharper takeaways would help.', 0, '2026-08-07T14:00:00Z', '2026-08-07T14:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000006', 'ra000000-0000-4000-8000-000000000008', 'sub00000-0000-4000-8000-000000000004', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":3,"crit0000-0000-4000-8000-000000000002":4,"crit0000-0000-4000-8000-000000000003":3}', 3.25, NULL, 0, '2026-08-07T15:00:00Z', '2026-08-07T15:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000007', 'ra000000-0000-4000-8000-000000000010', 'sub00000-0000-4000-8000-000000000005', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":3,"crit0000-0000-4000-8000-000000000002":4,"crit0000-0000-4000-8000-000000000003":3}', 3.25, 'Solid but overlaps last year''s serving talk.', 0, '2026-08-07T16:00:00Z', '2026-08-07T16:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000008', 'ra000000-0000-4000-8000-000000000014', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":3,"crit0000-0000-4000-8000-000000000002":3,"crit0000-0000-4000-8000-000000000003":2}', 2.75, 'Panel format needs stronger names.', 0, '2026-08-07T17:00:00Z', '2026-08-07T17:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000009', 'ra000000-0000-4000-8000-000000000015', 'sub00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000011', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":2,"crit0000-0000-4000-8000-000000000002":3,"crit0000-0000-4000-8000-000000000003":3}', 2.5, NULL, 0, '2026-08-07T18:00:00Z', '2026-08-07T18:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000010', 'ra000000-0000-4000-8000-000000000016', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":2,"crit0000-0000-4000-8000-000000000002":2,"crit0000-0000-4000-8000-000000000003":2}', 2.0, 'Cautionary tales need more than anecdotes.', 0, '2026-08-07T09:30:00Z', '2026-08-07T09:30:00Z'),
  ('rvw00000-0000-4000-8000-000000000011', 'ra000000-0000-4000-8000-000000000017', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":2,"crit0000-0000-4000-8000-000000000002":3,"crit0000-0000-4000-8000-000000000003":1}', 2.0, NULL, 0, '2026-08-07T09:45:00Z', '2026-08-07T09:45:00Z'),
  ('rvw00000-0000-4000-8000-000000000012', 'ra000000-0000-4000-8000-000000000018', 'sub00000-0000-4000-8000-000000000008', 'con00000-0000-4000-8000-000000000011', 'plan0000-0000-4000-8000-000000000001',
   '{"crit0000-0000-4000-8000-000000000001":1,"crit0000-0000-4000-8000-000000000002":2,"crit0000-0000-4000-8000-000000000003":2}', 1.5, NULL, 0, '2026-08-07T10:15:00Z', '2026-08-07T10:15:00Z'),
  -- Workshops plan (Hands-on ×2, Logistics ×1): weighted = (h×2 + l)/3.
  ('rvw00000-0000-4000-8000-000000000013', 'ra000000-0000-4000-8000-000000000019', 'sub00000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000009', 'plan0000-0000-4000-8000-000000000002',
   '{"crit0000-0000-4000-8000-000000000004":5,"crit0000-0000-4000-8000-000000000005":4}', 4.67, 'Ablation-driven workshop — rare and valuable.', 0, '2026-08-07T13:00:00Z', '2026-08-07T13:00:00Z'),
  ('rvw00000-0000-4000-8000-000000000014', 'ra000000-0000-4000-8000-000000000020', 'sub00000-0000-4000-8000-000000000003', 'con00000-0000-4000-8000-000000000010', 'plan0000-0000-4000-8000-000000000002',
   '{"crit0000-0000-4000-8000-000000000004":4,"crit0000-0000-4000-8000-000000000005":4}', 4.0, NULL, 0, '2026-08-07T13:30:00Z', '2026-08-07T13:30:00Z');

-- rating_cache mirrors the means above so the grid sorts without aggregation.
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":4.63}' WHERE id = 'sub00000-0000-4000-8000-000000000001';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":4.13}' WHERE id = 'sub00000-0000-4000-8000-000000000002';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":3.5}'  WHERE id = 'sub00000-0000-4000-8000-000000000004';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":3.25}' WHERE id = 'sub00000-0000-4000-8000-000000000005';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":2.63}' WHERE id = 'sub00000-0000-4000-8000-000000000007';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000001":1.83}' WHERE id = 'sub00000-0000-4000-8000-000000000008';
UPDATE submissions SET rating_cache = '{"plan0000-0000-4000-8000-000000000002":4.34}' WHERE id = 'sub00000-0000-4000-8000-000000000003';

-- ---------------------------------------------------------------------------
-- M4: agenda (docs/12 §2) — four more accepted sessions; four scheduled on
-- Oct 12 across Main Stage and Hall A, with one deliberate speaker
-- double-booking (Grace: SESS-2 on Main Stage 10:00–10:30 PDT overlaps
-- SESS-11 in Hall A 10:15–10:45) so the Conflicts view is non-empty on
-- arrival. SESS-13 (lane N1, EMB-07) sits on Oct 13 instead — every session
-- used to land on day 1, so the day tabs for Oct 13/14 always read "nothing
-- scheduled". SESS-14 stays unscheduled so the tray and the dashboard nudge
-- have material. All times UTC; the event runs in America/Los_Angeles (PDT,
-- UTC-7 in October).
-- ---------------------------------------------------------------------------

INSERT INTO submissions (
  id, event_id, form_id, code, kind, title, description, status,
  track_id, format, level, language, submitter_contact_id, notified_at,
  room_id, starts_at, ends_at, source, created_at, updated_at
) VALUES
  ('sub00000-0000-4000-8000-000000000011', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-11', 'abstract', 'Live-Debugging Agent Traces: A Postmortem Toolkit',
   '<p>Walking through real traces of agent failures and the tooling that made them legible in minutes instead of hours.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000001', 'Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000003', '2026-08-06T15:30:00Z',
   'room0000-0000-4000-8000-000000000002', '2026-10-12T17:15:00Z', '2026-10-12T17:45:00Z', 'form',
   '2026-08-02T10:30:00Z', '2026-08-07T09:00:00Z'),

  -- Lane N1 (EMB-01): description extended past the widgets' truncation
  -- threshold (160/180 chars) so "Show more" actually has something to
  -- expand — the original one-sentence copy never crossed it.
  ('sub00000-0000-4000-8000-000000000012', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-12', 'abstract', 'Guardrail Benchmarks in CI: Catching Regressions Before Users Do',
   '<p>How we turned red-team findings into a CI benchmark suite that gates every model and prompt change. The talk covers scoring rubrics, flaky-test triage and the dashboard our on-call actually watches during a rollout.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000002', 'Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000006', '2026-08-06T15:31:00Z',
   'room0000-0000-4000-8000-000000000002', '2026-10-12T18:00:00Z', '2026-10-12T18:45:00Z', 'form',
   '2026-08-02T11:00:00Z', '2026-08-07T09:05:00Z'),

  -- Lane N1 (EMB-07/EMB-01): moved from Oct 12 to Oct 13 (same room, same
  -- 90-minute length) so the day tabs for Oct 13/14 aren't uniformly empty —
  -- every seeded session used to land on day 1. Description also extended
  -- past the truncation threshold, same reasoning as SESS-12 above.
  ('sub00000-0000-4000-8000-000000000013', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-13', 'abstract', 'Building a Retrieval Evaluation Harness from Scratch',
   '<p>A hands-on workshop: golden sets, graded relevance judgments and a live leaderboard for your own corpus. We build the harness end-to-end, from labeling guidelines to a query-level dashboard you can keep extending long after the session ends.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000003', 'Workshop', 'Advanced', 'English',
   'con00000-0000-4000-8000-000000000007', '2026-08-06T15:32:00Z',
   'room0000-0000-4000-8000-000000000001', '2026-10-13T16:00:00Z', '2026-10-13T17:30:00Z', 'form',
   '2026-08-03T09:00:00Z', '2026-08-07T09:10:00Z'),

  ('sub00000-0000-4000-8000-000000000014', 'evt00000-0000-4000-8000-000000000001', 'form0000-0000-4000-8000-000000000001',
   'SESS-14', 'abstract', 'Postmortems of Production LLM Incidents',
   '<p>Five anonymised incidents, what the on-call saw, and the mitigations that actually held up.</p>',
   'accepted', 'trk00000-0000-4000-8000-000000000005', 'Talk', 'Intermediate', 'English',
   'con00000-0000-4000-8000-000000000008', '2026-08-06T15:33:00Z',
   NULL, NULL, NULL, 'form',
   '2026-08-03T10:00:00Z', '2026-08-07T09:15:00Z');

-- Schedule the two originally accepted talks on Main Stage.
UPDATE submissions SET room_id = 'room0000-0000-4000-8000-000000000001',
  starts_at = '2026-10-12T16:00:00Z', ends_at = '2026-10-12T16:45:00Z',
  updated_at = '2026-08-07T09:20:00Z'
  WHERE id = 'sub00000-0000-4000-8000-000000000001';
UPDATE submissions SET room_id = 'room0000-0000-4000-8000-000000000001',
  starts_at = '2026-10-12T17:00:00Z', ends_at = '2026-10-12T17:30:00Z',
  updated_at = '2026-08-07T09:21:00Z'
  WHERE id = 'sub00000-0000-4000-8000-000000000002';

INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, confirmed_at) VALUES
  ('sp000000-0000-4000-8000-000000000011', 'sub00000-0000-4000-8000-000000000011', 'con00000-0000-4000-8000-000000000003', 'speaker', 1, 1, '2026-08-02T10:30:00Z'),
  ('sp000000-0000-4000-8000-000000000012', 'sub00000-0000-4000-8000-000000000012', 'con00000-0000-4000-8000-000000000006', 'speaker', 1, 1, '2026-08-02T11:00:00Z'),
  ('sp000000-0000-4000-8000-000000000013', 'sub00000-0000-4000-8000-000000000013', 'con00000-0000-4000-8000-000000000007', 'speaker', 1, 1, '2026-08-03T09:00:00Z'),
  ('sp000000-0000-4000-8000-000000000014', 'sub00000-0000-4000-8000-000000000014', 'con00000-0000-4000-8000-000000000008', 'speaker', 1, 1, '2026-08-03T10:00:00Z');

-- ---------------------------------------------------------------------------
-- M5: Speaker Tracking needs a confirmation mix — Claude and Barbara haven't
-- confirmed their accepted slots yet, so the donut shows 3 confirmed / 2
-- awaiting instead of a solid ring.
-- ---------------------------------------------------------------------------

UPDATE submission_participants SET confirmed_at = NULL
WHERE contact_id IN ('con00000-0000-4000-8000-000000000007', 'con00000-0000-4000-8000-000000000008');

-- ---------------------------------------------------------------------------
-- M2: message log. The anchor demo (docs/12 §3 step 7) narrows every tab to one
-- speaker, so Ada needs a real comms history — varied templates and statuses,
-- including one failure — plus a few rows for other speakers so the unfiltered
-- Messages tab is not a single-contact list.
-- ---------------------------------------------------------------------------

INSERT INTO message_log (id, event_id, template_key, to_email, contact_id, subject, status,
  provider_message_id, error, idempotency_key, created_at, sent_at) VALUES
  ('msg00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'submission_confirmation',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'We received your submission — Agentic Retrieval at Scale', 'sent',
   'demo-provider-0001', NULL, 'seed:msg:0001', '2026-07-28T09:12:00Z', '2026-07-28T09:12:04Z'),
  ('msg00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'magic_link',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'Your sign-in link for AI.Engineer NYC', 'sent',
   'demo-provider-0002', NULL, 'seed:msg:0002', '2026-07-28T09:20:00Z', '2026-07-28T09:20:03Z'),
  ('msg00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'decision_accepted',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'Your session has been accepted', 'sent',
   'demo-provider-0003', NULL, 'seed:msg:0003', '2026-08-04T15:02:00Z', '2026-08-04T15:02:06Z'),
  ('msg00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'task_assigned',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'Action needed: Presentation Upload', 'sent',
   'demo-provider-0004', NULL, 'seed:msg:0004', '2026-08-04T15:03:00Z', '2026-08-04T15:03:05Z'),
  ('msg00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'task_reminder',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'Reminder: Speaker Profile & Headshot is due soon', 'failed',
   NULL, 'provider temporarily unavailable (502)', 'seed:msg:0005', '2026-08-07T08:00:00Z', NULL),
  ('msg00000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'task_reminder',
   'ada@example.com', 'con00000-0000-4000-8000-000000000002',
   'Reminder: Speaker Profile & Headshot is due soon', 'queued',
   NULL, NULL, 'seed:msg:0006', '2026-08-08T08:00:00Z', NULL),
  ('msg00000-0000-4000-8000-000000000007', 'evt00000-0000-4000-8000-000000000001', 'submission_confirmation',
   'grace.hopper@example.com', 'con00000-0000-4000-8000-000000000003',
   'We received your submission — Compilers for Agents', 'sent',
   'demo-provider-0007', NULL, 'seed:msg:0007', '2026-07-29T11:41:00Z', '2026-07-29T11:41:04Z'),
  ('msg00000-0000-4000-8000-000000000008', 'evt00000-0000-4000-8000-000000000001', 'decision_declined',
   'joan.clarke@example.com', 'con00000-0000-4000-8000-000000000006',
   'An update on your submission', 'sent',
   'demo-provider-0008', NULL, 'seed:msg:0008', '2026-08-05T16:10:00Z', '2026-08-05T16:10:07Z');

-- ---------------------------------------------------------------------------
-- Speaker onboarding templates from the organiser clarifications
-- (docs/Clarifications/Swyx-1.md answer 5): flight reimbursement is a
-- co-equal must-have; the remainder are the optional templates. Bio/photos
-- is already covered by 'Speaker Profile & Headshot' above.
-- ---------------------------------------------------------------------------

INSERT INTO portal_forms (id, event_id, name, title, type, questions, send_confirmation_email, created_at) VALUES
  ('pf000000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Flight Reimbursement', 'Flight Reimbursement Request', 'contacts',
   '[{"id":"q_amount","label":"Total amount to reimburse","type":"text","required":true},
     {"id":"q_currency","label":"Currency","type":"dropdown","required":true,"options":[{"value":"USD","label":"USD"},{"value":"EUR","label":"EUR"},{"value":"GBP","label":"GBP"},{"value":"other","label":"Other (explain in notes)"}]},
     {"id":"q_account","label":"Payout details (IBAN / account, or PayPal email)","type":"textarea","required":true},
     {"id":"q_notes","label":"Notes (booking reference, receipts sent to…)","type":"textarea"}]',
   1, '2026-08-08T12:00:00Z');

INSERT INTO tasks (id, event_id, title, description, target, assignment_mode, "trigger", action_type,
                   portal_form_id, file_request_id, due_at, reminder_offsets_days, required, created_at, updated_at) VALUES
  ('task0000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'Flight Reimbursement',
   '<p>Submit your flight details and payout information so we can reimburse your travel.</p>',
   'contact', 'automatic', 'on_accept', 'portal_form',
   'pf000000-0000-4000-8000-000000000002', NULL, '2026-10-05T07:00:00Z', '[7,2,0]', 1, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'Finalize Talk Description',
   '<p>Review and finalize your talk title and description as it will appear in the published programme.</p>',
   'submission', 'manual', 'none', 'acknowledge', NULL, NULL, '2026-09-14T07:00:00Z', '[7,2]', 0, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000007', 'evt00000-0000-4000-8000-000000000001', 'Announce Your Participation',
   '<p>Share that you are speaking! Announcement graphics and suggested copy are at https://ai.engineer/speaker-kit.</p>',
   'contact', 'manual', 'none', 'external_link', NULL, NULL, '2026-09-21T07:00:00Z', '[7]', 0, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('task0000-0000-4000-8000-000000000008', 'evt00000-0000-4000-8000-000000000001', 'Invite Colleagues with Discount',
   '<p>Your speaker discount code gives colleagues 20% off registration — share it with your network.</p>',
   'contact', 'manual', 'none', 'acknowledge', NULL, NULL, '2026-09-28T07:00:00Z', '[7]', 0, '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');
