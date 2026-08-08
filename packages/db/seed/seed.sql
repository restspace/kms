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

INSERT INTO tracks (id, event_id, name, color, position) VALUES
  ('trk00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Agents',           '#6366f1', 1),
  ('trk00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Evals',            '#f59e0b', 2),
  ('trk00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'RAG & Retrieval',  '#10b981', 3),
  ('trk00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Infra & Serving',  '#0ea5e9', 4),
  ('trk00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'AI in Production', '#ef4444', 5);

INSERT INTO rooms (id, event_id, name, capacity, position, notes) VALUES
  ('room0000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Main Stage', 600, 1, NULL),
  ('room0000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Hall A',     250, 2, NULL),
  ('room0000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'Hall B',     250, 3, NULL),
  ('room0000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Studio',      80, 4, NULL),
  ('room0000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'Pavilion',   120, 5, NULL),
  ('room0000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'Lounge',      40, 6, NULL);

INSERT INTO tags (id, event_id, name, color) VALUES
  ('tag00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'Open Source', '#22c55e'),
  ('tag00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'Research',    '#8b5cf6'),
  ('tag00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'Production',  '#0ea5e9'),
  ('tag00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'Sponsor',     '#f97316');

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
  ('fld00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'track',             'Track',             'dropdown',    'submission',
    '[{"value":"Agents","label":"Agents"},{"value":"Evals","label":"Evals"},{"value":"RAG & Retrieval","label":"RAG & Retrieval"},{"value":"Infra & Serving","label":"Infra & Serving"},{"value":"AI in Production","label":"AI in Production"}]', NULL, 0),
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
  ('fld00000-0000-4000-8000-000000000016', 'evt00000-0000-4000-8000-000000000001', 'headshot',          'Headshot',          'file',        'contact',    NULL, NULL, 0);

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

-- ---------------------------------------------------------------------------
-- Contacts (admin + 7 speakers) and the owner event_user
-- ---------------------------------------------------------------------------

INSERT INTO contacts (id, event_id, email, first_name, last_name, company, job_title, created_at, updated_at) VALUES
  ('con00000-0000-4000-8000-000000000001', 'evt00000-0000-4000-8000-000000000001', 'james@atelyr.com',              'James',    'Ellis-Jones', 'Atelyr',        'Founder',              '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000002', 'evt00000-0000-4000-8000-000000000001', 'ada@example.com',               'Ada',      'Lovelace',    'Analytical Co', 'Principal Engineer',   '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000003', 'evt00000-0000-4000-8000-000000000001', 'grace.hopper@example.com',      'Grace',    'Hopper',      'Flowmatic AI',  'VP Engineering',       '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000004', 'evt00000-0000-4000-8000-000000000001', 'alan.turing@example.com',       'Alan',     'Turing',      'Enigma Labs',   'Research Scientist',   '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000005', 'evt00000-0000-4000-8000-000000000001', 'margaret.hamilton@example.com', 'Margaret', 'Hamilton',    'Apollo Systems','Director of Software', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000006', 'evt00000-0000-4000-8000-000000000001', 'joan.clarke@example.com',       'Joan',     'Clarke',      'Cipher AI',     'Staff ML Engineer',    '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000007', 'evt00000-0000-4000-8000-000000000001', 'claude.shannon@example.com',    'Claude',   'Shannon',     'Bitstream',     'CTO',                  '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z'),
  ('con00000-0000-4000-8000-000000000008', 'evt00000-0000-4000-8000-000000000001', 'barbara.liskov@example.com',    'Barbara',  'Liskov',      'Substrate',     'Distinguished Eng',    '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

INSERT INTO event_users (event_id, contact_id, role, invited_at, accepted_at) VALUES
  ('evt00000-0000-4000-8000-000000000001', 'con00000-0000-4000-8000-000000000001', 'owner', '2026-08-08T12:00:00Z', '2026-08-08T12:00:00Z');

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
   '<p>Patterns for keeping tool-calling agents on the rails: typed tool schemas, permission scopes, replayable traces and failure budgets.</p>',
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
