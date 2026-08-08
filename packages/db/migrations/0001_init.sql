-- 0001_init — full DDL for the domain model in docs/02-domain-model.md.
-- Conventions: TEXT uuid PKs, TEXT ISO-8601 UTC timestamps, INTEGER 0/1 booleans,
-- TEXT for json columns, snake_case, ON DELETE CASCADE where owned-by-event.
--
-- The scaffold migration 0001_events.sql created a minimal `events` table
-- (starts_on/ends_on) for the hello-world page; it is superseded here, so drop it
-- and recreate to the real spec (starts_at/ends_at).

DROP TABLE IF EXISTS events;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE organisations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

CREATE TABLE events (
  id                        TEXT PRIMARY KEY,
  org_id                    TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name                      TEXT NOT NULL,
  slug                      TEXT NOT NULL UNIQUE,
  type                      TEXT NOT NULL DEFAULT 'conference'
                              CHECK (type IN ('conference','workshop','summit','meetup','other')),
  website_url               TEXT,
  location                  TEXT,
  timezone                  TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  starts_at                 TEXT NOT NULL,
  ends_at                   TEXT NOT NULL,
  theme                     TEXT,
  logo_asset_id             TEXT REFERENCES file_assets(id),
  background_asset_id       TEXT REFERENCES file_assets(id),
  default_submission_limit  INTEGER NOT NULL DEFAULT 3,
  agenda_published          INTEGER NOT NULL DEFAULT 0,
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

CREATE TABLE contacts (
  id                 TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  email              TEXT NOT NULL,
  first_name         TEXT,
  last_name          TEXT,
  salutation         TEXT,
  honorific          TEXT,
  pronouns           TEXT,
  gender             TEXT,
  mobile_phone       TEXT,
  biography          TEXT,
  headshot_asset_id  TEXT REFERENCES file_assets(id),
  links              TEXT, -- json {linkedin, twitter, facebook, website}
  company            TEXT,
  job_title          TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (event_id, email)
);

CREATE TABLE event_users (
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role         TEXT NOT NULL CHECK (role IN ('owner','admin','reviewer')),
  invited_at   TEXT,
  accepted_at  TEXT,
  PRIMARY KEY (event_id, contact_id)
);

CREATE TABLE portal_accounts (
  id                      TEXT PRIMARY KEY,
  contact_id              TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  last_login_at           TEXT,
  login_token_hash        TEXT,
  login_token_expires_at  TEXT,
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_portal_accounts_contact ON portal_accounts (contact_id);

-- ---------------------------------------------------------------------------
-- Library: fields, tracks, rooms, tags
-- ---------------------------------------------------------------------------

CREATE TABLE field_definitions (
  id         TEXT PRIMARY KEY,
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  label      TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('text','textarea','wysiwyg','number','email','phone',
               'url','date','datetime','dropdown','multiselect','checkbox','radio','file','heading')),
  scope      TEXT NOT NULL CHECK (scope IN ('contact','submission','session')),
  options    TEXT, -- json [{value,label,color?}]
  max_chars  INTEGER,
  system     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, key)
);

CREATE TABLE tracks (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  color     TEXT,
  position  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_tracks_event ON tracks (event_id);

CREATE TABLE rooms (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  capacity  INTEGER,
  position  INTEGER NOT NULL DEFAULT 0,
  notes     TEXT
);

CREATE INDEX idx_rooms_event ON rooms (event_id);

CREATE TABLE tags (
  id        TEXT PRIMARY KEY,
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  color     TEXT
);

CREATE INDEX idx_tags_event ON tags (event_id);

CREATE TABLE contact_tags (
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- Forms
-- ---------------------------------------------------------------------------

CREATE TABLE submission_forms (
  id                              TEXT PRIMARY KEY,
  event_id                        TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  internal_name                   TEXT NOT NULL,
  external_title                  TEXT,
  page_heading                    TEXT, -- 15-char cap enforced in the service layer
  welcome_message                 TEXT,
  welcome_message_visible         INTEGER NOT NULL DEFAULT 1,
  collection_type                 TEXT NOT NULL DEFAULT 'abstracts'
                                    CHECK (collection_type IN ('abstracts','sessions')),
  collect_participants            INTEGER NOT NULL DEFAULT 1,
  status                          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  close_at                        TEXT,
  submission_limit                INTEGER, -- null -> event.default_submission_limit
  allow_multiple_drafts           INTEGER NOT NULL DEFAULT 0,
  success_message                 TEXT,
  auto_redirect_to_portal         INTEGER NOT NULL DEFAULT 1,
  cross_field_limits              TEXT, -- json
  routing_rules                   TEXT, -- json (docs/02 §3 RoutingRule[])
  notify_admins_on_create         TEXT, -- json uuid[]
  notify_admins_on_update         TEXT, -- json uuid[]
  confirmation_email_enabled      INTEGER NOT NULL DEFAULT 1,
  confirmation_email_template_id  TEXT REFERENCES email_templates(id),
  created_at                      TEXT NOT NULL,
  updated_at                      TEXT NOT NULL
);

CREATE INDEX idx_submission_forms_event ON submission_forms (event_id);

CREATE TABLE form_questions (
  id         TEXT PRIMARY KEY,
  form_id    TEXT NOT NULL REFERENCES submission_forms(id) ON DELETE CASCADE,
  section    TEXT NOT NULL CHECK (section IN ('abstract','participant')),
  field_id   TEXT NOT NULL REFERENCES field_definitions(id),
  label      TEXT,
  help_text  TEXT,
  position   INTEGER NOT NULL DEFAULT 0,
  required   INTEGER NOT NULL DEFAULT 0,
  locked     INTEGER NOT NULL DEFAULT 0,
  options    TEXT, -- json [{value,label,color?}]
  max_chars  INTEGER,
  visibility TEXT  -- json ConditionalRule
);

CREATE INDEX idx_form_questions_form ON form_questions (form_id, section, position);

-- ---------------------------------------------------------------------------
-- Submissions (sessions are the same row, scheduled)
-- ---------------------------------------------------------------------------

CREATE TABLE submissions (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  form_id               TEXT REFERENCES submission_forms(id) ON DELETE SET NULL,
  code                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'abstract' CHECK (kind IN ('abstract','session')),
  title                 TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                          ('draft','pending','accept_queue','accepted','decline_queue','declined','withdrawn')),
  track_id              TEXT REFERENCES tracks(id) ON DELETE SET NULL,
  format                TEXT,
  level                 TEXT,
  language              TEXT,
  capacity              INTEGER,
  ceu_credits           REAL,
  client_session_id     TEXT,
  starts_at             TEXT,
  ends_at               TEXT,
  room_id               TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  submitter_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  notified_at           TEXT,
  rating_cache          TEXT, -- json { "<plan_id>": 4.2 }
  source                TEXT NOT NULL DEFAULT 'form' CHECK (source IN ('form','manual','import')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  UNIQUE (event_id, code)
);

CREATE INDEX idx_submissions_event_status ON submissions (event_id, status);
CREATE INDEX idx_submissions_submitter ON submissions (event_id, submitter_contact_id);
CREATE INDEX idx_submissions_schedule ON submissions (event_id, room_id, starts_at);

CREATE TABLE submission_answers (
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  question_id    TEXT NOT NULL REFERENCES form_questions(id) ON DELETE CASCADE,
  value_json     TEXT,
  PRIMARY KEY (submission_id, question_id)
);

CREATE INDEX idx_submission_answers_submission ON submission_answers (submission_id);

CREATE TABLE submission_participants (
  id                  TEXT PRIMARY KEY,
  submission_id       TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  contact_id          TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'speaker'
                        CHECK (role IN ('speaker','co-speaker','moderator','panelist')),
  position            INTEGER NOT NULL DEFAULT 0,
  is_primary_contact  INTEGER NOT NULL DEFAULT 0,
  confirmed_at        TEXT,
  UNIQUE (submission_id, contact_id, role)
);

CREATE INDEX idx_submission_participants_submission ON submission_participants (submission_id);
CREATE INDEX idx_submission_participants_contact ON submission_participants (contact_id);

CREATE TABLE submission_tags (
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  tag_id         TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (submission_id, tag_id)
);

-- ---------------------------------------------------------------------------
-- Evaluation
-- ---------------------------------------------------------------------------

CREATE TABLE evaluation_plans (
  id                    TEXT PRIMARY KEY,
  event_id              TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT,
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','closed')),
  scoring_scale_min     INTEGER NOT NULL DEFAULT 1,
  scoring_scale_max     INTEGER NOT NULL DEFAULT 5,
  anonymise_submitters  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_evaluation_plans_event ON evaluation_plans (event_id);

CREATE TABLE scoring_criteria (
  id             TEXT PRIMARY KEY,
  plan_id        TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  weight         REAL NOT NULL DEFAULT 1,
  scale_min      INTEGER,
  scale_max      INTEGER,
  allow_comment  INTEGER NOT NULL DEFAULT 1,
  position       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_scoring_criteria_plan ON scoring_criteria (plan_id, position);

CREATE TABLE review_assignments (
  id                   TEXT PRIMARY KEY,
  plan_id              TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  submission_id        TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending','in_progress','complete','skipped')),
  assigned_at          TEXT,
  completed_at         TEXT,
  UNIQUE (plan_id, submission_id, reviewer_contact_id)
);

CREATE INDEX idx_review_assignments_reviewer ON review_assignments (reviewer_contact_id, status);
CREATE INDEX idx_review_assignments_submission ON review_assignments (submission_id);

CREATE TABLE reviews (
  id                    TEXT PRIMARY KEY,
  assignment_id         TEXT REFERENCES review_assignments(id) ON DELETE SET NULL,
  submission_id         TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  reviewer_contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  plan_id               TEXT NOT NULL REFERENCES evaluation_plans(id) ON DELETE CASCADE,
  scores                TEXT, -- json {criterion_id: number}
  weighted_total        REAL,
  comment               TEXT,
  conflict_of_interest  INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);

CREATE INDEX idx_reviews_submission_plan ON reviews (submission_id, plan_id);

-- ---------------------------------------------------------------------------
-- Portal work items
-- ---------------------------------------------------------------------------

CREATE TABLE tasks (
  id                     TEXT PRIMARY KEY,
  event_id               TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title                  TEXT NOT NULL,
  description            TEXT,
  target                 TEXT NOT NULL DEFAULT 'contact'
                           CHECK (target IN ('contact','group','submission')),
  assignment_mode        TEXT NOT NULL DEFAULT 'manual'
                           CHECK (assignment_mode IN ('manual','automatic')),
  "trigger"              TEXT NOT NULL DEFAULT 'none'
                           CHECK ("trigger" IN ('on_accept','on_schedule','none')),
  action_type            TEXT NOT NULL DEFAULT 'acknowledge'
                           CHECK (action_type IN ('file_upload','portal_form','acknowledge','external_link')),
  portal_form_id         TEXT REFERENCES portal_forms(id) ON DELETE SET NULL,
  file_request_id        TEXT REFERENCES file_requests(id) ON DELETE SET NULL,
  due_at                 TEXT,
  reminder_offsets_days  TEXT, -- json int[]
  required               INTEGER NOT NULL DEFAULT 0,
  created_at             TEXT NOT NULL
);

CREATE INDEX idx_tasks_event ON tasks (event_id);

CREATE TABLE task_assignments (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  contact_id     TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  submission_id  TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'not_started'
                   CHECK (status IN ('not_started','in_progress','complete')),
  completed_at   TEXT,
  response_id    TEXT
);

CREATE INDEX idx_task_assignments_contact_status ON task_assignments (contact_id, status);
CREATE INDEX idx_task_assignments_task ON task_assignments (task_id);

CREATE TABLE portal_forms (
  id                       TEXT PRIMARY KEY,
  event_id                 TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name                     TEXT NOT NULL,
  title                    TEXT,
  type                     TEXT NOT NULL DEFAULT 'contacts'
                             CHECK (type IN ('contacts','groups','submissions')),
  sections                 TEXT, -- json
  questions                TEXT, -- json (FormQuestion shape)
  send_confirmation_email  INTEGER NOT NULL DEFAULT 0,
  confirmation_message     TEXT,
  close_at                 TEXT,
  requires_login           INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL
);

CREATE INDEX idx_portal_forms_event ON portal_forms (event_id);

CREATE TABLE portal_form_responses (
  id              TEXT PRIMARY KEY,
  portal_form_id  TEXT NOT NULL REFERENCES portal_forms(id) ON DELETE CASCADE,
  contact_id      TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  submission_id   TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  answers         TEXT, -- json
  submitted_at    TEXT NOT NULL
);

CREATE INDEX idx_portal_form_responses_form ON portal_form_responses (portal_form_id);

CREATE TABLE file_requests (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title          TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'contacts'
                   CHECK (type IN ('contacts','groups','submissions')),
  instructions   TEXT,
  allowed_types  TEXT, -- json string[]
  max_size_mb    INTEGER,
  due_at         TEXT,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_file_requests_event ON file_requests (event_id);

CREATE TABLE file_request_uploads (
  id               TEXT PRIMARY KEY,
  file_request_id  TEXT NOT NULL REFERENCES file_requests(id) ON DELETE CASCADE,
  contact_id       TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  submission_id    TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  file_asset_id    TEXT NOT NULL REFERENCES file_assets(id) ON DELETE CASCADE,
  uploaded_at      TEXT NOT NULL
);

CREATE INDEX idx_file_request_uploads_request ON file_request_uploads (file_request_id);

CREATE TABLE file_assets (
  id                      TEXT PRIMARY KEY,
  event_id                TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key                     TEXT NOT NULL, -- object-store key (R2)
  filename                TEXT NOT NULL,
  content_type            TEXT,
  size_bytes              INTEGER,
  uploaded_by_contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL
);

CREATE INDEX idx_file_assets_event ON file_assets (event_id);

-- ---------------------------------------------------------------------------
-- Communications
-- ---------------------------------------------------------------------------

CREATE TABLE email_themes (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  logo_asset_id     TEXT REFERENCES file_assets(id),
  primary_color     TEXT,
  background_color  TEXT,
  font              TEXT,
  header_html       TEXT,
  footer_html       TEXT
);

CREATE TABLE email_templates (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  key            TEXT NOT NULL, -- system key or custom
  name           TEXT NOT NULL,
  subject        TEXT,
  body_richtext  TEXT,
  enabled        INTEGER NOT NULL DEFAULT 1,
  theme_id       TEXT REFERENCES email_themes(id) ON DELETE SET NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (event_id, key)
);

CREATE TABLE message_log (
  id                   TEXT PRIMARY KEY,
  event_id             TEXT REFERENCES events(id) ON DELETE CASCADE,
  template_key         TEXT,
  to_email             TEXT NOT NULL,
  contact_id           TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  subject              TEXT,
  status               TEXT NOT NULL DEFAULT 'queued'
                         CHECK (status IN ('queued','sent','failed','bounced')),
  provider_message_id  TEXT,
  error                TEXT,
  idempotency_key      TEXT NOT NULL UNIQUE, -- NFR-11
  created_at           TEXT NOT NULL,
  sent_at              TEXT
);

CREATE INDEX idx_message_log_event ON message_log (event_id, created_at);

CREATE TABLE calendar_invites (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  contact_id    TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  uid           TEXT NOT NULL, -- stable RFC-5545 UID
  sequence      INTEGER NOT NULL DEFAULT 0,
  method        TEXT NOT NULL DEFAULT 'REQUEST' CHECK (method IN ('REQUEST','CANCEL')),
  last_sent_at  TEXT,
  UNIQUE (session_id, contact_id)
);

-- ---------------------------------------------------------------------------
-- Dashboards & embeds
-- ---------------------------------------------------------------------------

CREATE TABLE dashboards (
  id            TEXT PRIMARY KEY,
  event_id      TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('today','custom')),
  template_key  TEXT CHECK (template_key IS NULL OR template_key IN
                  ('event_overview','submissions_pipeline','speaker_tracking','review_progress','schedule_health')),
  position      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_dashboards_event ON dashboards (event_id);

CREATE TABLE widgets (
  id            TEXT PRIMARY KEY,
  dashboard_id  TEXT NOT NULL REFERENCES dashboards(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('stat','bar','donut','line','list','nudge')),
  title         TEXT,
  query_key     TEXT,
  config        TEXT, -- json
  position      INTEGER NOT NULL DEFAULT 0,
  size          TEXT
);

CREATE INDEX idx_widgets_dashboard ON widgets (dashboard_id, position);

CREATE TABLE embeds (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  format         TEXT NOT NULL CHECK (format IN
                   ('agenda','session_list','schedule_itinerary','speaker_list','speaker_gallery')),
  enabled        INTEGER NOT NULL DEFAULT 1,
  style_options  TEXT, -- json
  filters        TEXT, -- json
  field_options  TEXT, -- json
  public_token   TEXT UNIQUE
);

-- ---------------------------------------------------------------------------
-- Outbox (docs/03 §2a — no Queues on the free tier)
-- ---------------------------------------------------------------------------

CREATE TABLE outbox (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,
  idempotency_key  TEXT NOT NULL UNIQUE, -- NFR-11
  payload          TEXT NOT NULL, -- json
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','in_flight','done','dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  TEXT NOT NULL,
  last_error       TEXT,
  created_at       TEXT NOT NULL
);

CREATE INDEX idx_outbox_status_due ON outbox (status, next_attempt_at);
