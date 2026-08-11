# 02 — Domain Model

All records are scoped to an **Event**, which is scoped to an **Organisation**. Every query in
the data layer must carry the event/org scope — tenant isolation is enforced below the UI.

**Contact is the one exception** (migration `0015`): a contact is scoped to the **Organisation**
directly, so one person has a single identity across every event the org runs. What varies per
event — profile fields, and membership itself — lives on `EventContact`, the join between a
Contact and an Event. See §2.

---

## 1. Entity map

```
Organisation
├── Contact  (person: speaker / submitter / reviewer — one identity per org)
│   └── PortalAccount (magic-link identity)
└── Event
    ├── EventUser (role: owner | admin | reviewer)
    ├── EventContact (a Contact's membership + per-event profile)
    ├── Track, Room, Tag, Persona, FieldDefinition
    ├── SubmissionForm
    │   ├── FormSection (welcome | abstract | participant | settings | notifications)
    │   ├── FormQuestion ──> FieldDefinition
    │   │   └── ConditionalRule
    │   └── RoutingRule
    ├── Submission  (abstract or session proposal)
    │   ├── SubmissionAnswer  (question -> value)
    │   ├── SubmissionParticipant (Contact + role, ordered)
    │   ├── FileAsset[]
    │   └── Review[]  ──> EvaluationPlan, Reviewer
    ├── Session  (a scheduled Submission, or created directly)
    ├── EvaluationPlan
    │   ├── ScoringCriterion
    │   └── ReviewAssignment
    ├── Task ──> TaskAssignment (to Contact or Submission)
    ├── PortalForm (+ PortalFormResponse)
    ├── FileRequest (+ FileRequestUpload)
    ├── EmailTemplate, EmailTheme, MessageLog
    ├── Dashboard (+ Widget)
    └── Embed
```

---

## 2. Core entities

### Organisation
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| name | string | |
| slug | string | unique |
| created_at | timestamptz | |

### Event
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| org_id | uuid → Organisation | |
| name | string(255) | required |
| slug | string | **unique**, drives public URLs |
| type | enum | `conference \| workshop \| summit \| meetup \| other` |
| website_url | string | |
| location | string | free text, e.g. "New York" |
| timezone | string | IANA, e.g. `America/Los_Angeles` |
| starts_at / ends_at | timestamptz | required |
| theme | text(1000) | description used for search/recommendations |
| logo_asset_id / background_asset_id | uuid → FileAsset | 300×300 / 1500×500 |
| default_submission_limit | int | default `3` |
| agenda_published | bool | default false |
| created_at / updated_at | timestamptz | |

### EventUser
`event_id, contact_id, role (owner|admin|reviewer), invited_at, accepted_at`

### Contact
The person record, scoped to the **Organisation** (migration `0015`, was event-scoped before
it). One contact may be speaker on several submissions across several events in the same org;
their identity is a single row regardless of how many events they appear in.

| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| org_id | uuid → Organisation | |
| email | citext | unique per org |
| first_name / last_name | string(255) | |
| salutation, honorific | string | |
| pronouns, gender | string | free text or picklist |
| mobile_phone | string | |
| links | json | `{linkedin, twitter, facebook, website}` |
| tags | uuid[] → Tag | |
| created_at / updated_at | timestamptz | |

Field split rule: identity lives on Contact; anything a person can legitimately answer
differently at two events lives on `EventContact` below.

### EventContact
A Contact's membership in one Event, and their profile **at that event**. Biography, headshot
and company/job title move here rather than onto Contact because they can genuinely differ
event to event; `notes` is here too, since it holds one event team's private remarks about the
person and promoting it to org level would disclose it to every other event in the org.

| Field | Type | Notes |
|---|---|---|
| event_id, contact_id | uuid | **PRIMARY KEY**, both FK with `ON DELETE CASCADE` |
| biography | richtext(5000) | |
| headshot_asset_id | uuid → FileAsset | |
| company, job_title | string | optional |
| notes | text | private to this event's team |
| added_at | timestamptz | |
| source | enum | `import \| cfp \| admin \| migration` |

A NULL profile field means "not set for this event" — it never falls back to another event's
value. Instead, attaching a contact to a new event seeds its profile fields from that contact's
most recent `EventContact` row in the same org, so a returning speaker does not retype
everything.

### PortalAccount
`id, contact_id, last_login_at, login_token_hash, login_token_expires_at, sessions[]`
Passwordless only; no password column exists.

---

## 3. Forms

### SubmissionForm
| Field | Type | Notes |
|---|---|---|
| id | uuid | appears in the public URL |
| event_id | uuid | |
| internal_name | string(255) | e.g. "Session Submission Form #4" |
| external_title | string(255) | e.g. "Welcome to our event!" |
| page_heading | string(15) | hard 15-char cap, per reference UI |
| welcome_message | richtext | |
| welcome_message_visible | bool | |
| collection_type | enum | `abstracts \| sessions` |
| collect_participants | bool | |
| status | enum | `open \| closed` (derived from close_at, overridable) |
| close_at | timestamptz | null = no deadline |
| submission_limit | int | null → falls back to `event.default_submission_limit` |
| allow_multiple_drafts | bool | |
| success_message | richtext | |
| auto_redirect_to_portal | bool | 10-second redirect |
| cross_field_limits | json | `[{name, field_ids[], max_chars, scope: submission\|participant}]` |
| notify_admins_on_create | uuid[] → Contact | |
| notify_admins_on_update | uuid[] → Contact | |
| confirmation_email_enabled | bool | default true — **must have** |
| confirmation_email_template_id | uuid → EmailTemplate | |
| created_at / updated_at | timestamptz | |

**Derived:** `submission_count`, `draft_count`.

### FormQuestion
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| form_id | uuid | |
| section | enum | `abstract \| participant` |
| field_id | uuid → FieldDefinition | |
| label | string | overrides the field label for this form |
| help_text | string | |
| position | int | drag-and-drop order |
| required | bool | |
| locked | bool | system field, cannot be deleted (Title, First/Last Name, Email) |
| options | json | for dropdown/radio/multiselect: `[{value,label,color?}]` |
| max_chars | int | e.g. 255 text, 5000 wysiwyg |
| visibility | json | see ConditionalRule below |

### FieldDefinition (Library → Fields)
`id, event_id, key, label, type, scope (contact|submission|session), options, max_chars, system`

Types: `text, textarea, wysiwyg, number, email, phone, url, date, datetime, dropdown,
multiselect, checkbox, radio, file, heading`.

### ConditionalRule (stored inline on `FormQuestion.visibility`)
```jsonc
{
  "action": "show",              // show | hide
  "match": "all",                // all (AND) | any (OR)
  "conditions": [
    { "question_id": "q_track", "op": "is_any_of", "value": ["Track 1", "Track 2"] },
    { "question_id": "q_format", "op": "equals",   "value": "Workshop" }
  ]
}
```
Operators: `equals, not_equals, contains, not_contains, is_any_of, is_empty, is_not_empty, gt, lt`.
Evaluation is client-side for UX and re-validated server-side on submit; hidden questions are
never required and their answers are discarded.

### RoutingRule (category-based routing)
```jsonc
{
  "id": "r1",
  "when": { "question_id": "q_track", "op": "equals", "value": "Agents" },
  "then": {
    "set_track_id": "trk_agents",
    "assign_evaluation_plan_id": "plan_agents",
    "add_tag_ids": ["tag_ai"],
    "notify_contact_ids": ["c_reviewer_lead"],
    "set_status": "pending"
  }
}
```
Rules evaluate in order on submit; later rules may overwrite earlier ones. All applications are
recorded on the submission for auditability.

---

## 4. Submissions & sessions

### Submission
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| event_id, form_id | uuid | `form_id` null when created manually by an admin |
| code | string | human ID, e.g. `SESS-4` |
| kind | enum | `abstract \| session` |
| title | string(255) | required |
| description | richtext(5000) | |
| status | enum | see below |
| track_id | uuid → Track | |
| format | string | e.g. Keynote, Featured Keynote, Workshop, Panel, Lightning |
| level | string | e.g. Beginner / Intermediate / Advanced |
| language | string | |
| tags | uuid[] → Tag | |
| capacity | int | expected attendees |
| ceu_credits | number | |
| client_session_id | string | external ID for cross-system reconciliation |
| starts_at / ends_at | timestamptz | set when scheduled |
| room_id | uuid → Room | set when scheduled |
| submitter_contact_id | uuid → Contact | |
| notified_at | timestamptz | decision email sent |
| rating_cache | json | `{ "<plan_id>": 4.2 }` for fast sorting |
| source | enum | `form \| manual \| import` |
| created_at / updated_at | timestamptz | |

**Status enum & colour (mirrors the reference UI):**

| Status | Colour | Meaning |
|---|---|---|
| `draft` | grey | Started in the portal, not submitted |
| `pending` | yellow | Submitted, awaiting decision |
| `accept_queue` | light green | Provisionally accepted, decision email not yet sent |
| `accepted` | green | Accepted and notified |
| `decline_queue` | amber | Provisionally declined |
| `declined` | red | Declined and notified |
| `withdrawn` | slate | Withdrawn by the submitter |

The two queue states exist so organisers can batch decisions and then send all notifications at once.

### SubmissionAnswer
`submission_id, question_id, value_json` — normalised answer storage so custom fields need no schema change.

### SubmissionParticipant
`submission_id, contact_id, role (speaker|co-speaker|moderator|panelist), position, is_primary_contact, confirmed_at`

### Session
A scheduled submission. Modelled as the **same row** as `Submission` (with `starts_at`,
`ends_at`, `room_id` populated) rather than a separate table — the reference product treats
Abstracts and Sessions as two views over one pipeline, and this avoids sync bugs.
`is_scheduled` is the derived predicate `starts_at IS NOT NULL AND room_id IS NOT NULL`.

### Track
`id, event_id, name, color, position`

### Room
`id, event_id, name, capacity, position, notes`

### Tag
`id, event_id, name, color`

---

## 5. Evaluation

### EvaluationPlan
`id, event_id, name, description, status (draft|active|closed), scoring_scale_min, scoring_scale_max, anonymise_submitters (bool), created_at`

### ScoringCriterion
`id, plan_id, name, description, weight (default 1), scale_min, scale_max, allow_comment, position`

### ReviewAssignment
`id, plan_id, submission_id, reviewer_contact_id, status (pending|in_progress|complete|skipped), assigned_at, completed_at`

### Review
`id, assignment_id, submission_id, reviewer_contact_id, plan_id, scores json ({criterion_id: number}), weighted_total, comment, conflict_of_interest bool, created_at`

Aggregate rating for a submission within a plan = mean of reviewers' `weighted_total`.

---

## 6. Portal work items

### Task
| Field | Type | Notes |
|---|---|---|
| id | uuid | |
| event_id | uuid | |
| title | string | e.g. "Presentation Upload", "Hotel and Travel Reservations" |
| description | richtext | |
| target | enum | `contact \| group \| submission` |
| assignment_mode | enum | `manual \| automatic` (automatic = auto-assign on a trigger) |
| trigger | enum | `on_accept \| on_schedule \| none` |
| action_type | enum | `file_upload \| portal_form \| acknowledge \| external_link` |
| portal_form_id / file_request_id | uuid | when applicable |
| due_at | timestamptz | |
| reminder_offsets_days | int[] | e.g. `[7, 2, 0]` |
| required | bool | |

### TaskAssignment
`id, task_id, contact_id, submission_id (nullable), status (not_started|in_progress|complete), completed_at, response_id`

The dashboard's *outstanding speaker tasks* count = `TaskAssignment` rows where
`status != 'complete'` and the contact is a speaker on an accepted submission.

### PortalForm
`id, event_id, name, title, type (contacts|groups|submissions), sections[], questions[] (same shape as FormQuestion), send_confirmation_email bool, confirmation_message richtext, close_at, requires_login bool`

### PortalFormResponse
`id, portal_form_id, contact_id, submission_id, answers json, submitted_at`

### FileRequest
`id, event_id, title, type (contacts|groups|submissions), instructions richtext, allowed_types[], max_size_mb, due_at`
Uploaded files live on the request and are **not** attached to the contact/session record — they are downloadable and exportable in bulk.

### FileRequestUpload
`id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at`

### FileAsset
`id, event_id, key (object-store key), filename, content_type, size_bytes, uploaded_by_contact_id, created_at`

---

## 7. Communications

### EmailTemplate
`id, event_id, key (system key or custom), name, subject, body_richtext, enabled, theme_id, updated_at`

System keys: `submission_confirmation`, `submission_updated`, `admin_new_submission`,
`decision_accepted`, `decision_declined`, `task_assigned`, `task_reminder`,
`draft_reminder`, `schedule_confirmed`, `schedule_changed`, `magic_link`.

### EmailTheme
`id, event_id, name, logo_asset_id, primary_color, background_color, font, header_html, footer_html`

### MessageLog
`id, event_id, template_key, to_email, contact_id, subject, status (queued|sent|failed|bounced), provider_message_id, error, idempotency_key, created_at, sent_at`

### CalendarInvite
`id, session_id, contact_id, uid (stable RFC-5545 UID), sequence int, method (REQUEST|CANCEL), last_sent_at`
`uid` = `<session_id>@<event-slug>.<domain>` so updates replace rather than duplicate.

---

## 8. Dashboards & embeds

### Dashboard
`id, event_id, name, kind (today|custom), template_key (event_overview|submissions_pipeline|speaker_tracking|review_progress|schedule_health), position`

### Widget
`id, dashboard_id, type (stat|bar|donut|line|list|nudge), title, query_key, config json, position, size`

### Embed
`id, event_id, name, format (agenda|session_list|schedule_itinerary|speaker_list|speaker_gallery), enabled, style_options json, filters json, field_options json, public_token`

---

## 9. Derived values & invariants

| Rule | Enforcement |
|---|---|
| A submission cannot be scheduled unless `status = accepted`. | Service layer |
| `room_id` + time range must not overlap another scheduled submission in the same room. | Conflict engine, checked on write; stored conflicts recomputed |
| A contact cannot be a participant on two overlapping scheduled sessions. | Conflict engine (warning-to-error configurable) |
| `starts_at`/`ends_at` must fall inside the event window. | Validation warning |
| Submissions per submitter per form ≤ `submission_limit`. | Checked on create, including drafts |
| Forms past `close_at` reject creates and updates. | Middleware on the public endpoints |
| Hidden (conditionally invisible) questions are never required. | Server-side re-evaluation on submit |
| Email sends are idempotent on `idempotency_key`. | Unique index on `MessageLog.idempotency_key` |

---

## 10. Reference seed values

Formats: `Keynote, Featured Keynote, Talk, Workshop, Panel, Lightning Talk`
Levels: `Beginner, Intermediate, Advanced`
Tracks: `Track 1, Track 2` (screenshots) → seed as real AIE tracks, e.g. `Agents, Evals, RAG, Infra`
Tags: `Tag A` (screenshots) → seed realistic tags
Rooms: `Main Stage, Hall A, Hall B, Studio, Pavilion, Lounge` (from the Schedule Health widget mock)
Participant role: `Speaker`
