# 01 — Requirements

Requirement IDs are stable: `FR-<area>-<n>` functional, `NFR-<n>` non-functional.
Priority uses MoSCoW. **M** = must ship for the Aug 12 submission, **S** = should,
**C** = could, **W** = won't (this round).

---

## 1. Event configuration (`FR-EVT`)

| ID | Requirement | Pri |
|---|---|---|
| FR-EVT-1 | An organisation can create one or more **Events**. All other records are scoped to an event. | M |
| FR-EVT-2 | Event has: name, URL slug, type (Conference / Workshop / Summit / Meetup / Other), website URL, location, timezone, starts-at, ends-at, theme/description (≤1000 chars). Name, slug, starts-at, ends-at required. | M |
| FR-EVT-3 | Event slug is unique and drives all public URLs (`/submit/<event-slug>/<form-id>`, `/portal/<event-slug>`). | M |
| FR-EVT-4 | Event logo (300×300) and background image (1500×500) upload. | S |
| FR-EVT-5 | Event switcher in the admin shell showing name + date range; "View all my organizations". | S |
| FR-EVT-6 | Toggle which group types are managed (Exhibitors / Sponsors). | W |
| FR-EVT-7 | Settings hub grouping: Event setup, Library (Fields, Tags, Personas), Communications (Email templates, Email themes), Configuration (Integrations). | S |
| FR-EVT-8 | **Library → Tags**: reusable labels applied across records (e.g. `Tag A`). CRUD + colour. | S |
| FR-EVT-9 | **Library → Fields**: custom-field definitions reusable across contacts, sessions and submissions. | S |
| FR-EVT-10 | **Library → Personas**: audience segments / attendee types. | C |
| FR-EVT-11 | **Tracks** and **Rooms/Locations** are event-level configuration used by submissions and the agenda. | M |
| FR-EVT-12 | Record Settings: choose which columns/fields appear in list layouts per record type. | C |

---

## 2. Submission forms / CFP (`FR-FORM`) — see [04](04-cfp-and-forms.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-FORM-1 | Admin can create, edit, duplicate ("Copy from…"), and delete submission forms. | M |
| FR-FORM-2 | A form is built through an ordered wizard: **Submission Setup → Welcome Screen → Abstract Information → Participant Information → ~~Payments & Fees~~ → Form Settings → Notifications**. Steps show completion ticks. | M |
| FR-FORM-3 | Submission Setup: choose collection type **Abstracts** or **Sessions**; toggle whether a **Participants** step is included. | M |
| FR-FORM-4 | Welcome Screen: internal form name (≤255), external form title (≤255), page heading (≤15 chars), rich-text welcome message with a show/hide toggle. | M |
| FR-FORM-5 | Abstract Information: section title, page heading (≤15), rich-text description/instructions, and an ordered list of **form questions**. | M |
| FR-FORM-6 | Default abstract questions, matching the reference: `Title` (text, ≤255, locked, required), `Description` (wysiwyg, ≤5000, required), `Format` (dropdown, required), `Tags` (dropdown, required), `Track` (dropdown, required), `Level` (dropdown, optional), plus `Language`, `Capacity`, `CEU Credits`, `Client Session ID`. | M |
| FR-FORM-7 | Questions can be reordered by drag handle, toggled required/optional, edited or removed via a per-row menu. **Locked** system fields cannot be deleted. | M |
| FR-FORM-8 | Admin can add fields from the event field library or **create a new field** inline. Field types: text, textarea, wysiwyg, number, email, phone, url, date, datetime, dropdown (single), multi-select, checkbox, radio, file upload, section heading. | M |
| FR-FORM-9 | **Conditional logic**: any question can declare show/hide rules based on the answer to an earlier question (operators: equals, not equals, contains, is any of, is empty, is not empty). Rules combine with AND/OR. | M |
| FR-FORM-10 | **Category-based routing**: a mapping from an answer value (typically Track or Format) to a destination — target track, reviewer group / evaluation plan, tag applied, and/or admin notification recipient. | M |
| FR-FORM-11 | Participant Information: section title, page heading, rich-text instructions, participant **roles** (e.g. Speaker) each with optional min/max counts and an overall cap across roles. | M |
| FR-FORM-12 | Default participant questions: `First Name` (locked, required), `Last Name` (locked, required), `Email` (locked, required), `Mobile Phone` (optional), `Biography` (wysiwyg ≤5000, optional). Headshot upload addable. | M |
| FR-FORM-13 | Form Settings → **Close Date**: after this datetime the form stops accepting new and updated submissions; setting it enables draft-reminder emails. Public page shows "Form submissions will be accepted until \<date\>". | M |
| FR-FORM-14 | Form Settings → **Submission capacity**: per-form submission limit per user (falls back to an event-level max, default 3); toggle to allow multiple draft submissions. Public page shows "Submission Limit: N submissions per user". | M |
| FR-FORM-15 | Form Settings → **After submission**: rich-text success-page message and an "Auto-redirect to speaker portal after 10 seconds" toggle (when off, a "Continue to portal" button). | M |
| FR-FORM-16 | Form Settings → **Cross-field character limits**: cap the combined length of several text fields, with a live combined counter shown to the submitter. Speaker-field rules apply per participant. | C |
| FR-FORM-17 | Notifications: submitter **Submission Confirmation** email (on by default, customisable). | M |
| FR-FORM-18 | Notifications: admin recipients for "new submission received" and "existing submission updated". | S |
| FR-FORM-19 | Forms list shows status chip (Open / Closed), collection-type chips, submission and draft counts, close date, created date; filter tabs All / Open / Closed; search; sort (e.g. Most Pending). | S |
| FR-FORM-20 | Per-form actions: **View Form** (public preview), **Copy Link**, Save. | M |
| FR-FORM-21 | ~~Payments & fees, gateways, promo codes~~ | W |

---

## 3. Public submission experience (`FR-SUB`)

| ID | Requirement | Pri |
|---|---|---|
| FR-SUB-1 | Public URL `/submit/<event-slug>/<form-id>` renders a stepper: **Welcome → Account → Submission → Participant → Review**. | M |
| FR-SUB-2 | Welcome step shows deadline banner, submission limit, and the rich-text welcome message (headings, lists, links all render). | M |
| FR-SUB-3 | Account step: submitter identifies by email; passwordless magic link creates or resumes their portal account. | M |
| FR-SUB-4 | Submission step renders the abstract questions with validation, character counters and conditional logic evaluated live. | M |
| FR-SUB-5 | Participant step: add one or more participants per configured role, respecting min/max; the submitter is pre-filled as the first participant. | M |
| FR-SUB-6 | Review step shows a read-only summary with per-section "Edit" links before final submit. | M |
| FR-SUB-7 | **Save as draft** and resume later; drafts count against the submission limit. | S |
| FR-SUB-8 | On submit: persist, send the confirmation email, show the customised success page, then auto-redirect to the portal after 10s when enabled. | M |
| FR-SUB-9 | Closed forms show a friendly closed state rather than the wizard. | M |
| FR-SUB-10 | Submissions over the per-user limit are blocked with a clear message. | S |
| FR-SUB-11 | Fully responsive; usable on a phone. | M |
| FR-SUB-12 | File uploads (slides, supporting docs, headshot) with type/size validation. | S |

---

## 4. Speaker portal (`FR-PORTAL`) — see [05](05-speaker-portal.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-PORTAL-1 | Passwordless (magic-link) login at `/portal/<event-slug>`. | M |
| FR-PORTAL-2 | Portal nav: **Home, Submissions, Profile, Tasks**. | M |
| FR-PORTAL-3 | Home shows *My Submissions* cards (code + title, format, status chip: Accepted / Pending / Declined / Draft / Withdrawn), *My Profile* summary, and a *Tasks* panel split into **Submission Tasks** and **My Tasks** with All / My Tasks / Submissions tabs, a Filter control and Open-all / Collapse-all. | M |
| FR-PORTAL-4 | Submissions list + detail; edit while the form is open and the submission is not locked. | M |
| FR-PORTAL-5 | Profile: biography (wysiwyg ≤5000), salutation, first/last name, honorific, pronouns, gender, headshot upload, and **My Links** (LinkedIn, X/Twitter, Facebook, Website). Self-service editable. | M |
| FR-PORTAL-6 | Tasks: each task shows title, description, due date, status (Not started / In progress / Complete), and an action — upload a file, fill a portal form, or acknowledge. | M |
| FR-PORTAL-7 | Portal forms: admin-defined forms of type **Contacts / Groups / Submissions** rendered inside a task; optional confirmation email on completion. | M |
| FR-PORTAL-8 | File requests: admin-defined upload asks (title, type, rich-text instructions); files are stored against the request, downloadable/exportable by admins. | S |
| FR-PORTAL-9 | Admin can impersonate/preview the portal ("View Portal") and return via "Back to Admin Mode". | S |
| FR-PORTAL-10 | Portal branding: event logo, colours, welcome copy. | C |
| FR-PORTAL-11 | ~~Resources / wiki pages with HTML embeds~~ | W |

---

## 5. Review, evaluation & scoring (`FR-REV`) — see [06](06-review-and-scoring.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-REV-1 | **Abstracts** grid listing every submission with status tabs and counts: All / Accepted / Accept Queue / Pending / Decline Queue / Declined / Withdrawn / Drafts. | M |
| FR-REV-2 | Status lifecycle: `draft → pending → accept_queue | decline_queue → accepted | declined`, plus `withdrawn`. Inline status editing from the grid with a colour-coded picker. | M |
| FR-REV-3 | Grid columns are user-configurable (show/hide, reorder, reset to default) across Session Details and Reporting Fields; column-set persists per user as a **Saved View**. | S |
| FR-REV-4 | Search, multi-condition **Filter**, multi-key **Sort**, pagination (25/50/100 per page). | M |
| FR-REV-5 | Row-level quick edit and a full detail drawer with **Details** and **Participants** tabs. | M |
| FR-REV-6 | Admin can create a submission manually ("Add Abstract"): title, status, description, starts-at, ends-at, capacity, CEU credits, client ID, format, track, tags, participants. | S |
| FR-REV-7 | Bulk select → bulk status change, bulk tag, bulk assign to an evaluation plan, bulk notify. | S |
| FR-REV-8 | **Import sessions** from CSV/XLSX; **Export .CSV** / **Export .XLSX**; **Download files bundle** (zip of submission files). | S |
| FR-REV-9 | **Evaluation plans**: named plan with a scoring rubric (one or more criteria, each with a scale, weight and optional comment), a set of assigned reviewers, and a set of assigned submissions. | M |
| FR-REV-10 | Reviewer workspace: queue of assigned submissions, score entry, comments, progress indicator, skip/conflict-of-interest flag. | M |
| FR-REV-11 | Aggregate rating per submission (mean of weighted criteria) surfaced as a `Ratings: <plan>` column and sortable. | M |
| FR-REV-12 | Multiple rounds: a submission can belong to more than one plan; each plan's score is tracked separately. | S |
| FR-REV-13 | `Notified` flag per submission recording whether the accept/decline decision email has been sent. | S |
| FR-REV-14 | ~~AI-assisted review~~ | W |

---

## 6. Agenda & scheduling (`FR-AGENDA`) — see [07](07-agenda-and-scheduling.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-AGENDA-1 | Agenda views: **List, Day, Week, Month, Rooms, Conflicts**. | M |
| FR-AGENDA-2 | Accepted submissions become schedulable **Sessions**; unscheduled accepted sessions appear in a side tray. | M |
| FR-AGENDA-3 | **Drag and drop** a session from the tray onto a room × time slot; drag to move; drag edges to resize duration. | M |
| FR-AGENDA-4 | **Automatic conflict detection**, live: (a) room double-booking, (b) speaker booked in two overlapping sessions, (c) session outside event dates, (d) capacity exceeds room capacity, (e) two sessions of the same track overlapping (warning only). | M |
| FR-AGENDA-5 | Conflicts view lists every current conflict with severity (error/warning), the records involved and a jump-to-fix link. Conflicting blocks are visually flagged in the calendar. | M |
| FR-AGENDA-6 | Session edit: title, description, starts/ends, room, track, capacity, format, tags, participants. | M |
| FR-AGENDA-7 | Filter/search agenda by track, room, format, tag, speaker, status. | S |
| FR-AGENDA-8 | Undo of the last scheduling action; optimistic UI with server reconciliation. | S |
| FR-AGENDA-9 | Publish/unpublish the agenda; only published sessions appear on public surfaces. | S |
| FR-AGENDA-10 | Agenda drafts (staged changes applied together). | C |

---

## 7. Communications (`FR-COMM`) — see [08](08-communications.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-COMM-1 | Event-level **email templates** with subject, rich-text body and merge variables; system templates for submission confirmation, acceptance, decline, task assigned, task reminder, draft reminder, schedule confirmation, magic-link login. | M |
| FR-COMM-2 | **Email themes**: logo, colours, header/footer applied to all outgoing mail. | S |
| FR-COMM-3 | Merge variables at minimum: `{{speaker.first_name}}`, `{{speaker.last_name}}`, `{{event.name}}`, `{{event.dates}}`, `{{submission.title}}`, `{{submission.status}}`, `{{session.starts_at}}`, `{{session.room}}`, `{{task.title}}`, `{{task.due_date}}`, `{{portal_url}}`, `{{magic_link}}`. | M |
| FR-COMM-4 | Triggered sends: on submit, on status change to accepted/declined, on task assignment, on schedule confirmed/changed. | M |
| FR-COMM-5 | **Scheduled reminders**: draft reminder before form close; task reminder N days before due (configurable, multiple offsets); pre-event reminder. Implemented on a cron worker. | M |
| FR-COMM-6 | **Calendar invites delivered to the speaker's own calendar**: every accepted, scheduled session generates an RFC-5545 `.ics` (METHOD:REQUEST) attached to the email, plus "Add to Google Calendar" and "Add to Outlook" links. Updates re-send with an incremented `SEQUENCE`; cancellation sends `METHOD:CANCEL`. | M |
| FR-COMM-7 | Per-event sender identity (from name/address, reply-to). | S |
| FR-COMM-8 | Message log: every send recorded with recipient, template, status (queued/sent/failed/bounced), timestamp; visible per speaker and per submission. | S |
| FR-COMM-9 | Admin can send an ad-hoc templated message to a filtered set of speakers. | C |
| FR-COMM-10 | All emails render in plain text as well as HTML. | S |

---

## 8. Dashboard & reporting (`FR-DASH`) — see [09](09-dashboard-and-reporting.md)

| ID | Requirement | Pri |
|---|---|---|
| FR-DASH-1 | Dashboard home: greeting, today's date, countdown "N DAYS TO EVENT". | S |
| FR-DASH-2 | KPI tiles: Submissions, Accepted Speakers, (Exhibitors, Sponsors — hidden when disabled). | S |
| FR-DASH-3 | Submission-status tiles: Accepted, Pending, Declined, Drafts, Withdrawn. | M |
| FR-DASH-4 | **"Also check" action strip** with actionable nudges, e.g. "1 accepted session still needs a time slot on the agenda", "3 session submissions are awaiting a decision", each deep-linking to the right screen. | S |
| FR-DASH-5 | Tabs: Submission Forms, Participants, Evaluations, Agenda. | S |
| FR-DASH-6 | **Speaker tracking dashboard** — the brief's requirement #6: accepted speakers, **outstanding speaker tasks**, speaker confirmation mix, and *Top speakers by outstanding tasks*. Must show who still owes what. | M |
| FR-DASH-7 | Nudges for missing speaker assets, e.g. "2 accepted speakers are missing a bio or headshot (2 bios, 2 headshots)". | M |
| FR-DASH-8 | Submissions-pipeline dashboard: total submissions, pending review, submissions by form, submissions by track. | S |
| FR-DASH-9 | Review-progress dashboard: reviewer workload, evaluated submissions, reviews in progress, most-active plan. | C |
| FR-DASH-10 | Submission pacing chart (cumulative submissions vs days-to-event) with optional prior-event comparison. | C |
| FR-DASH-11 | Multiple named dashboards; add/remove widgets; pre-built gallery (Event Overview, Submissions Pipeline, Speaker Tracking, Review Progress, Schedule Health). | C |
| FR-DASH-12 | Data refreshes live (poll ≤30 s or push) so the dashboard is "real-time" per the brief. | M |
| FR-DASH-13 | CSV/XLSX export of any grid. | S |
| FR-DASH-14 | Embeddable styled-HTML feed of agenda / session list / speaker list for the public site. | C |

---

## 9. Platform, access & API (`FR-PLAT`)

| ID | Requirement | Pri |
|---|---|---|
| FR-PLAT-1 | Roles: Owner, Admin, Reviewer, Speaker. Route- and record-level authorisation. | M |
| FR-PLAT-2 | Event team management: invite an admin/reviewer by email. | S |
| FR-PLAT-3 | Global search / command palette (⌘K) over submissions, speakers, sessions, forms. | C |
| FR-PLAT-4 | Audit history of record changes (who changed what, when). | C |
| FR-PLAT-5 | Public REST API covering events, forms, submissions, speakers, sessions, tasks — token-authenticated. | S |
| FR-PLAT-6 | Outbound webhooks on submission.created, submission.status_changed, session.scheduled, task.completed. | C |
| FR-PLAT-7 | Seeded demo data so a judge landing on the deployed site sees a populated product. | M |

---

## 10. Non-functional requirements

| ID | Requirement |
|---|---|
| NFR-1 | **Performance:** public CFP and portal pages TTFB < 200 ms from edge; LCP < 1.5 s on a mid-tier phone over 4G; admin grid interactions < 100 ms perceived. The brief explicitly penalises slow SaaS. |
| NFR-2 | **Scale target:** 5k submissions, 10k contacts, 500 sessions per event without pagination or grid degradation. |
| NFR-3 | **Availability:** stateless edge compute; no single-region dependency for read paths. |
| NFR-4 | **Security:** magic-link tokens single-use and ≤15 min TTL; signed session cookies (HttpOnly, Secure, SameSite=Lax); per-event tenant isolation enforced in the data layer, not just the UI; file uploads scanned for type and size; no secrets in the client bundle. |
| NFR-5 | **Privacy:** speaker PII (email, phone) exposed only to admins and the owning speaker; exports are permission-gated and logged. |
| NFR-6 | **Accessibility:** WCAG 2.1 AA — keyboard-operable drag-and-drop with an accessible alternative (move-to dialog), visible focus, labelled form controls, colour contrast ≥ 4.5:1, status conveyed by more than colour. |
| NFR-7 | **Responsiveness:** public CFP, portal and the agenda read views work on mobile; the agenda editor may be desktop-first. |
| NFR-8 | **Observability:** structured request logs, error tracking, an email-delivery log, and a `/health` endpoint. |
| NFR-9 | **Licence:** OSI-approved open-source licence (MIT or Apache-2.0) with a README that a stranger can deploy from in under 15 minutes. |
| NFR-10 | **Portability:** persistence behind a repository interface; SQL (D1) is the system of record and the Airtable adapter implements a one-way mirror (see [03](03-architecture.md)). Swapping the primary store (e.g. to Postgres) must not require touching route handlers. |
| NFR-11 | **Idempotency:** email sends and calendar invites are keyed so retries cannot double-send. |
| NFR-12 | **Timezones:** all timestamps stored UTC; rendered in the event timezone with the abbreviation shown (e.g. "October 12th, 2026 at 9:00 AM PDT"). |

---

## 11. Acceptance criteria for the submission

The build is "done" when a judge can, on the deployed site, complete every step of
[12-build-plan.md §Demo script](12-build-plan.md) without assistance, and:

1. Submit a proposal through a public CFP form that has at least one conditional question and
   one routing rule, and receive a confirmation email.
2. Log into the speaker portal from that email, edit their bio and upload a headshot.
3. As an admin, accept the submission and see the speaker's outstanding tasks appear on the dashboard.
4. Assign a task; the speaker receives it, completes it, and the dashboard count drops.
5. Drag the accepted session onto the agenda, trigger a deliberate room conflict, see it flagged, and resolve it.
6. Confirm the schedule and see a calendar invite arrive that opens correctly in Google Calendar, Outlook and Apple Calendar.
