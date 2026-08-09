# Manual Review 1

## Event creation

**Symptom:** The event dropdown at top-left of the admin app doesn't drop down a pane when clicked.

**Root cause:** Not a bug — `apps/admin/src/App.tsx:456-476` is a native HTML `<select>` (the FR-EVT-5 "event switcher"), and it's `disabled` whenever `me.events.length < 2` (line 460) or while a switch is in progress (`switching`, lines 355, 463, 466). A disabled native `<select>` won't open. The account being tested currently has access to only one event, so the switcher is correctly disabled — there's simply no second event to switch to.

**Gap found:** There is no "Create Event" UI anywhere in the admin frontend.
- `apps/admin/src/api.ts` only exports `switchEvent` (lines 95-99, `POST /app/api/switch-event`) — no `createEvent` call exists.
- No route, form, or wizard for creating an event exists in `apps/admin/src`.
- Existing events currently come only from seed/demo data (FR-PLAT-7).

**What the spec says (docs/):**
- `docs/00-overview.md:108` — Organiser/Admin role "Creates the event, builds CFP forms, reviews submissions, schedules the agenda, chases speakers." via the Admin app.
- `docs/01-requirements.md:13` (FR-EVT-1) — "An organisation can create one or more Events. All other records are scoped to an event." (M = Must-have)
- `docs/01-requirements.md:14` (FR-EVT-2) — Event fields: name, URL slug, type (Conference / Workshop / Summit / Meetup / Other), website URL, location, timezone, starts-at, ends-at, theme/description (≤1000 chars). Name, slug, starts-at, ends-at required.
- `docs/01-requirements.md:15` (FR-EVT-3) — Event slug is unique and drives all public URLs.
- `docs/01-requirements.md:17` (FR-EVT-5) — "Event switcher in the admin shell showing name + date range; 'View all my organizations'."
- `docs/10-api.md:36` — `POST /events` (org-scoped, token-authenticated per FR-PLAT-5) is the spec'd API endpoint.
- `docs/11-ui-and-navigation.md:90` — `/app` route is the "Org / event chooser," implying a create flow should live there, but no explicit "Create Event" screen/wizard is spec'd out (unlike the detailed CFP form-builder wizard in `04-cfp-and-forms.md`).
- `docs/01-requirements.md` §11 acceptance criteria — none of the 6 acceptance-test steps exercise event creation; all assume an existing event.

**Status:** Confirmed gap between spec (FR-EVT-1/EVT-2/API) and implementation. No fix applied yet — deferred per user request.

## Events should be scoped within the Workspace, not the other way around

**Current spec:** The "tab workspace" (Speakers | Submissions | Tasks | Messages | Files) is scoped to a single event, routed as `/app/e/:event/workspace` (`docs/11-ui-and-navigation.md:60,93`). There is no view that spans multiple events — the event switcher (FR-EVT-5) *replaces* the whole workspace context with a different single event; it doesn't add a cross-event view.

**Requested change:** Events should exist *inside* the Workspace, not be the thing the Workspace is nested under. Concretely: the admin should be able to view the Workspace tabs (Speakers, Submissions, Tasks, Messages, Files) either:
- across all events at once (unscoped/aggregate view), or
- filtered down to one specific event (current behaviour),

rather than always being locked into exactly one event via the URL/route structure.

**Implication:** This changes the routing and data model assumptions in `docs/11-ui-and-navigation.md` (event becomes a filter dimension on the Workspace, not a path segment the Workspace lives under) and likely affects FR-EVT-5's "event switcher" (would become an event *filter*, not a context switch) and every workspace-tab API endpoint that currently assumes a single `:event` in scope. Not yet reflected anywhere in `docs/`.

**Status:** Recorded as a proposed spec change. No fix applied yet — deferred per user request.

## LH nav should show Workspace tabs indented underneath it

**Requested change:** The left-hand nav menu should list the available Workspace tabs (Speakers, Submissions, Tasks, Messages, Files) indented underneath the "Workspace" entry. Clicking any of them navigates to the Workspace and selects that tab.

**Purpose:** UI visibility of where things live, more than a functional change — the tabs already exist inside the Workspace; this just surfaces them in the nav so their location is discoverable without first opening Workspace.

**Status:** Recorded as a proposed spec/UI change. No fix applied yet — deferred per user request.

## Event dropdown should reflect and drive the global filter

**Requested change:**
- a. The event dropdown should always display the current global filter's value — the selected event's name, or "All" if there is no global filter set (or it's not filtered by event).
- b. Selecting an event in the dropdown sets the global filter to Event, with that event selected.

**Relation to earlier notes:** This builds on the "Events should be scoped within the Workspace" change above — once Event becomes a filter dimension rather than a routing context, the dropdown becomes the control surface for that filter (read: shows current state; write: changes it), rather than a context switcher (FR-EVT-5's current behaviour).

**Status:** Recorded as a proposed spec/UI change. No fix applied yet — deferred per user request.

## Bug: can't delete speaker with blank fields (except email 'u-01-reuse@example.com')

**Symptom:** Deleting a speaker whose fields are blank fails, except for the specific speaker with email `u-01-reuse@example.com`, which can be deleted normally.

**Status:** Not yet investigated. Needs root-cause: check the delete endpoint/handler for a validation or lookup step that assumes non-blank fields (e.g. a null/empty check that throws, or a query keyed on a field that's blank and doesn't match). Compare the working record (`u-01-reuse@example.com`) against a failing one to isolate which field's blankness breaks the delete path.

## Add basic format validation to input fields (email, web links)

**Requested change:** Add lightweight client-side validation to input fields — not full spec-compliant validation, just a simple format check:
- Email: text, then `@`, then text, then `.`, then text (e.g. `x@x.x` pattern, not full RFC 5322).
- Web link: basic URL-shape check, same "good enough, not exhaustive" bar.

**Status:** Recorded as a proposed change. No fix applied yet — deferred per user request.

## Show current global filter item in the Workspace tab header row

**Requested change:** In the Workspace, add an item-level indicator on the same row as the tab headers, aligned right, showing what the current global filter item is (e.g. the anchored speaker, or the selected event once Event becomes a filter per the earlier note).

**Relation to earlier notes:** Complements the "Events should be scoped within the Workspace" and "Event dropdown reflects/drives the global filter" notes above — this is the in-Workspace surface showing that same filter state, not just the dropdown.

**Status:** Recorded as a proposed UI change. No fix applied yet — deferred per user request.

## Gap check against docs/Clarifications/Swyx-1.md

Checked each organiser answer against both the spec docs and the actual implementation. 6 of 9 fully met; 3 have gaps.

**1. Conditional logic ("fine for now") — MET.** `docs/04-cfp-and-forms.md:123-144` and `FormBuilder.tsx:658-666` (`LogicModal`) implement exactly a flat AND/OR condition list, 8 operators, no nested boolean trees — matches "basic," nothing over-built.

**2. Multi-track routing ("talks submitted to one or more tracks, reviewers review one or more tracks") — GAP.** Both sides are modeled as single-valued, not many-to-many:
- Submissions have one `track_id` (`docs/02-domain-model.md:194`, `packages/db/migrations/0001_init.sql:206`).
- Reviewer assignment is scoped to an evaluation plan, not tracks — `review_assignments` has no `track_id` (`packages/db/migrations/0001_init.sql:291-304`); `EventUser.role` is event-wide `owner|admin|reviewer` (`docs/02-domain-model.md:69`).
- **Missing:** a `submission_tracks` join table and a track-scoped reviewer relation.

**3. Review workflow (unreviewed → approve/maybe/deny, bonus: email speaker with feedback on decision) — PARTIAL GAP.** Status model (`docs/06-review-and-scoring.md:91-98`) is `pending → accept_queue/decline_queue → accepted/declined` — functionally covers approve/deny but has no explicit "maybe" state (`review_assignments.status` is `pending|in_progress|complete|skipped`). The bonus feature — emailing the speaker with attached reviewer feedback from inside the decision action — is not built: `apps/api/src/routes/evaluation.ts:132-208` sends decision emails but without attached comments/scores, and the template has no feedback field (`packages/email/src/render.ts:114-126`). Not spec'd anywhere either, consistent with it being explicitly called a "bonus."

**4. Auto speaker/session/tasks on accept ("yes") — GAP.** Task auto-assignment on accept is real (`apps/api/src/routes/evaluation.ts:62-130` `autoAssignAcceptTasks`, triggered `:196-198`) and the acceptance email sends. But no session/agenda item is auto-created on acceptance — scheduling stays a manual drag-and-drop step (`apps/api/src/routes/agenda.ts`) — and `docs/07-agenda-and-scheduling.md` never specs auto-scheduling on accept. This is a spec gap, not just an implementation gap.

**5. Speaker onboarding must-have tasks (hotel stay form, flight reimbursement form; optional: finalize talk description, finalize bio/photos, announce participation, invite colleagues w/ discount) — GAP.** Seed data (`packages/db/seed/seed.sql:339-352`) only has: Presentation Upload, Speaker Profile & Headshot, Hotel and Travel Reservations, Speaker Agreement. **Missing entirely:** flight reimbursement task (a co-equal must-have), and all four optional templates.

**6. Emails/calendar invites actually work (MVP) — MET.** Real sending via Resend/SendGrid (`packages/email/src/index.ts:36-112`), console fallback only in dev. Idempotent delivery pipeline (`apps/api/src/mailer.ts:74-168`). Full RFC 5545 `.ics` generation with UID/SEQUENCE/METHOD/VALARM/VTIMEZONE (`packages/email/src/ics.ts:32-200`).

**7. Skip Accelevents — MET.** No integration code anywhere; correctly absent.

**8. Schedule: day/room + drag-drop + conflict detection ("enough") — MET.** All three implemented: day/room views (`apps/admin/src/agenda/RoomsBoard.tsx`, `TimeGrid.tsx`), native HTML5 drag-and-drop, conflict engine (`packages/core/src/agenda.ts:70,101` — room double-booking, track overlap, speaker double-booking), wired server-side (`apps/api/src/routes/agenda.ts:143-146`).

**9. Small agentic feature, admin UI priority — MET.** No product-facing AI/agent feature exists; only references are the REST API framed as "agent-friendly" (self-describing for API consumers), not a chatbot/autonomous feature. Zero LLM/AI SDK dependencies. Appropriately minimal relative to admin UI investment.

**Priority gaps to flag:** (2) submission↔track and reviewer↔track need to become many-to-many, not single-valued; (5) flight reimbursement task template and the four optional onboarding templates are unseeded and unspec'd; (4) no auto-created session/agenda item on acceptance, and no doc section specs this either.

**Status:** Gap analysis recorded. No fixes applied yet — deferred per user request.

## Gap check against docs/Clarifications/Swyx-2.md

**1. Single form, one-or-more track options ("single form w one or more track options is great") — PARTIAL GAP.** A `multiselect` question type exists (`apps/admin/src/forms/FormBuilder.tsx:491`) so a Track question can offer multiple options, and routing triggers support `is_any_of` against several values (`docs/04-cfp-and-forms.md:154`). But every routing action still resolves to a single `set_track_id` (`docs/04-cfp-and-forms.md:162`, `FormBuilder.tsx:924`), and `submissions.track_id` is a single FK (`packages/db/migrations/0001_init.sql:206`, `docs/02-domain-model.md:194`). A submitter can multi-select tracks in the UI, but the submission can only be routed/tagged to one — same root cause as the multi-track gap already flagged in the Swyx-1 review above.

**2. Editing after acceptance ("yes they can edit... we don't really use" a post-accept lock) — FULL GAP, and the spec itself is wrong.** `docs/05-speaker-portal.md:68` explicitly specs the opposite: "Edit is available when… the submission is not `accepted`-and-locked." Implementation doesn't even reach that (wrong) spec — `apps/api/src/routes/portal.ts` has no edit route for submission content at all, only `GET /:slug/submissions/:id` (view, line 365) and `POST /:slug/submissions/:id/withdraw` (line 448); the detail view just tells speakers to "Contact the organisers" for changes (`portal.ts:442`). Needs: (a) the doc's post-acceptance lock language removed/corrected, (b) an actual edit route/UI for accepted submissions.

**3. Co-speaker portal accounts ("up to you, nice to have") — N/A, organiser deferred.** For context: each contact authenticates independently via a passwordless magic link tied to `contact.id` (`apps/api/src/routes/auth.ts:75-153`), and `submission_participants` links multiple contacts to one submission (`docs/02-domain-model.md:228`) — so every co-speaker with an email effectively already gets their own login. No gap since the organiser left this open either way.

**4. Calendar invites: no video link, room details when known, updatable ("no video link, yes room details if we have them... assign room later") — MET.** No video/meeting-link field exists anywhere in `packages/email/src/ics.ts` or `apps/api/src/scheduleMail.ts`. `scheduleMail.ts:111` builds `location` from room/event name, filtered for blanks — no broken/blank LOCATION when room is unset yet. Room assignment triggers a resend: `apps/api/src/routes/agenda.ts:193-216` updates `room_id` and calls `sendScheduleEmails(..., 'changed')`; `scheduleMail.ts:120-128` increments a per-(session,contact) `SEQUENCE` on resend so calendar clients update in place rather than duplicating.

**Priority gaps to flag:** (1) submission↔track needs to become many-to-many end-to-end (routing action + `submissions` schema), not just multi-select at the question level — same fix as the Swyx-1 track gap, so these should likely be resolved together; (2) `docs/05-speaker-portal.md:68`'s post-acceptance lock contradicts the organiser's answer and needs correcting, and there's no edit route/UI for accepted submissions at all.

**Status:** Gap analysis recorded. No fixes applied yet — deferred per user request.

## Add context menu to the TabList with Detail/Delete rows and keystroke tips

**Current state:** The tab strip (`.data-tab-labels`, `role="tablist"`, `apps/admin/src/components/DataTabManager.tsx:2464-2537`) has no context menu of its own today. The app does have a `ContextMenu` component (`apps/admin/src/components/ContextMenu.tsx`), currently only used for the list-row context menu managed in the same file (`DataTabManager.tsx:1230-1327`, wired at `:2654-2658`) — that's the pattern to reuse for the tab strip.

**Requested change:**
- Add a custom context menu to the TabList (tab headers) with two new rows: **Detail** and **Delete**. (Named "Detail" not "Edit" — it's not always possible to edit from the Detail tab.)
- Add a right-aligned tip in that menu listing the keystroke shortcuts:
  - **Detail** — double-click
  - **Make global filter** — Shift-click

**Correction on existing behaviour — verified against code, Shift-click IS already wired, just one level down from where first checked:**
- Plain click on the tab's filter dot (`TOGGLE_GLOBAL_FILTER`, `DataTabManager.tsx:739-787`): if the tab is already the filter source, removes it. If not, and a row is already selected in that tab, sets it immediately; if no row is selected yet, goes "pending" until a row is clicked.
- Ctrl-click (Windows/Linux) or Cmd-click (Mac) on the filter dot — `e.ctrlKey || e.metaKey` is an OR check across platforms, not a combined "Ctrl+Cmd" chord as previously written here — adds the tab to the filter additively.
- Shift-click on a **row** (not the tab header) — `handleShiftClick` (`DataTabManager.tsx:1219-1226`) dispatches `SET_GLOBAL_FILTER_SOURCE` (`:789-810`) via `DataList`'s `onShiftClick` (wired at `:2202`). This unconditionally sets that tab+row as the global filter source in one step, no pending state needed, regardless of whether the tab was already the source. Confirmed against actual app behaviour, not just code reading.

So the keystroke tip is accurate to real behaviour; the correction is only that Shift-click already exists (on rows) and doesn't need to be newly implemented — the context-menu tip just needs to document it.

**Open question raised by user:** since the additive modifier is platform-dependent (Ctrl vs Cmd), should the keystroke tip shown in the context menu detect the OS and display the correct key per platform, rather than a single hardcoded label? Not yet decided — flagging for a decision before implementation.

**Status:** Recorded as a proposed UI change. No fix applied yet — deferred per user request.

## Add a general-purpose internal Notes field (submissions + contacts)

**Finding:** No general-purpose notes field exists on any user-facing entity. The only precedent is `rooms.notes` (`packages/db/migrations/0001_init.sql:122`), which is seeded but unreachable — there is no rooms admin UI. Every other free-text column is purpose-built and either speaker-authored/published (`contacts.biography`, `submissions.description`) or structured and role-scoped (`reviews.comment` is bound to one reviewer *and* one evaluation plan, and feeds the rating aggregation — the wrong place for "AV rider outstanding").

**Already spec'd:** `docs/07-agenda-and-scheduling.md:102` says session editing shows "…Status, Client Session ID, **and internal notes**." That field was specified and never built, so this closes a documented gap rather than adding scope.

**Decision:** implement as a **plain TEXT column** on each table, not a polymorphic `notes(entity_type, entity_id, …)` table. A column rides the existing RESOURCES registry for free (the registry's `SELECT c.*` / `SELECT s.*` propagates it to the admin grid, the `/api/v1` list endpoints and the CSV/XLSX exports with no extra wiring; OpenAPI response bodies are untyped `{ type: 'object' }` so no doc change is needed). Revisit a notes *table* only if attribution ("who wrote this, when") or multiple threaded notes per record are actually wanted.

**Naming:** column named `notes`, labelled **"Internal notes"** in all admin UI. Never rendered in portal, public or embed templates — see the redaction helper below.

### 1. `submissions.notes`

Highest value: the submission row is what the whole workspace turns around (accept/decline queues, evaluation, scheduling, conflict resolution), and sessions are the same row (`submissions.kind`), so one column serves both the Submissions tab and the agenda.

- New migration `packages/db/migrations/0004_notes.sql`: `ALTER TABLE submissions ADD COLUMN notes TEXT;`
- Add `notes: string | null` to `SubmissionRow` in `apps/admin/src/api.ts`.
- **New write path needed** — submissions have no edit form today (the Submissions tab supplies no `schema`/`onUpsert`, and `SubmissionDetailPanel` at `apps/admin/src/workspace/extras.tsx:92` is entirely read-only). Add a narrow `PUT /app/api/submissions/:id/notes` alongside the existing status routes in `apps/api/src/routes/evaluation.ts`, accepting only `notes`.
- Add an inline "Internal notes" textarea to `SubmissionDetailPanel`.
- Optionally add the field to `MoveDialog` / `AddSessionDialog` (`apps/admin/src/agenda/dialogs.tsx`) to honour `docs/07` §5 literally.

### 2. `contacts.notes`

Cheapest change and close behind on value — the Speakers tab already has the full schema-driven form and generic CRUD endpoints, so this is five small edits:

- Same migration: `ALTER TABLE contacts ADD COLUMN notes TEXT;`
- Add `notes` to `CONTACT_FIELDS` (`apps/api/src/routes/adminApi.ts`, ~line 446) — `pickContactFields()` and the `POST`/`PUT /contacts` handlers are already generic over that whitelist.
- Add `notes: { type: 'string', format: 'textarea', title: 'Internal notes' }` to `speakerSchema` (`apps/admin/src/App.tsx:74`). `RecordForm` already renders `format: 'textarea'` as a `<textarea rows={4}>`.
- Add `notes: string | null` to `ContactRow` in `apps/admin/src/api.ts`.
- Render it in the speakers `detailComponent`.

Use cases: "prefers to travel Tuesday", "declined last year", "press contact — route through comms".

### 3. Portal redaction helper (required, not optional)

The same `SELECT *` convenience that makes the column free in the admin makes it a live exposure risk in the portal. Three sites select whole rows for speaker-facing pages:

- `apps/api/src/routes/portal.ts:212` — `SELECT * FROM contacts WHERE id = ?` (speaker's own profile)
- `apps/api/src/routes/portal.ts:372` — `SELECT s.*, t.name AS track_name FROM submissions s …` (speaker's own submission)
- `apps/api/src/routes/portal.ts:757` — `SELECT * FROM portal_forms WHERE id = ?`

Nothing leaks *today* because those templates render explicitly named fields — but the column would sit one careless `${...}` or one future `JSON.stringify(row)` away from the speaker.

**Add a redaction function that every portal row read passes through**, e.g. `redactInternal<T>(row: T | null): T | null` in `packages/core/src/redact.ts` (exported from `packages/core/src/index.ts`), plus a `redactInternalAll()` for arrays. It strips a known set of internal-only keys — starting with `notes`, extensible as more are added — returning a new object rather than mutating.

Requirements:
- Null/undefined-safe (portal lookups can miss), and a no-op on rows that don't carry the key.
- Applied at **every** portal row fetch, immediately at the query boundary, so the redacted object is the only thing the templates ever see. Same treatment for any future public/embed route that reads submission or contact rows.
- Covered by a unit test asserting `notes` is absent from the returned object, so the guarantee survives refactors.

**Status:** Approved for implementation (1, 2 and 3). Not yet applied.

---

# Deferred from the E2E run (docs/14, tests/secondary-flow-e2e.md, tests/unhappy-paths-e2e.md)

The items below were found by the unattended test-and-fix run and deliberately NOT fixed by it:
each is unbuilt feature work rather than a broken code path, so building it unattended was out of
scope. Citations re-verified against the working tree at the time of writing.

## Agenda publish/unpublish is specified but not built (FR-AGENDA-9)

**Finding:** `agenda_published` exists end-to-end as *state* and is written by nothing.
- Column: `packages/db/migrations/0001_init.sql:38` (`INTEGER NOT NULL DEFAULT 0`), seeded at `packages/db/seed/seed.sql:18`.
- Typed: `packages/core/src/types.ts:42`, `apps/api/src/routes/agenda.ts:31`, `apps/admin/src/api.ts:350`.
- Read into the agenda payload: `apps/api/src/routes/agenda.ts:125`.
- No `UPDATE … agenda_published` anywhere, and no publish / unpublish / go-live control exists under `apps/admin/src/agenda`. Confirmed twice from the browser: the Agenda header offers only Search sessions, Group by, Send confirmations and + Add Session.

**Fix:** add an event PATCH endpoint that sets `agenda_published`, a go-live control on the Agenda header, and a published-state affordance so the current state is visible. Decide first what "published" gates — a public agenda route is the obvious consumer, and none exists yet.

**Status:** Confirmed gap, spec vs implementation. No fix applied — deferred as feature work.

## Session capacity cannot be set, so ROOM_CAPACITY_EXCEEDED can never fire (FR-AGENDA-6)

**Finding:** The conflict engine implements the check and nothing can trigger it.
- Guard: `packages/core/src/agenda.ts:133-137`, severity `warning` at `:62`, code declared at `:14`.
- It needs a *session* capacity: `submissions.capacity` exists (`packages/db/migrations/0001_init.sql:210`) and is read into the agenda payload (`apps/api/src/routes/agenda.ts:62,114`) — but no route ever writes it (no `UPDATE` touches `capacity` in `apps/api/src/routes/`).
- In the SPA, `capacity` appears only as a **room** attribute: `apps/admin/src/agenda/dialogs.tsx:104`, `RoomsBoard.tsx:88`, `AgendaSection.tsx:310`. The Move dialog offers Date / Start / Duration / Room only; the Add Session dialog and the submission detail panel offer no capacity field either.

**Fix:** add a capacity input to the Add Session and Move dialogs (or to the submission detail panel) and a write path for `submissions.capacity`. The engine then needs no change. Until then FR-AGENDA-6's "capacity is editable" is unmet and the warning is dead code.

**Status:** Confirmed gap. No fix applied — deferred as feature work.

## File-request upload policy is stored but never enforced (FR-PORTAL-8)

**Finding:** `file_requests.allowed_types` and `max_size_mb` are declared and seeded but read by no code.
- Declared: `packages/db/migrations/0001_init.sql:398-399` (`allowed_types TEXT -- json string[]`, `max_size_mb INTEGER`).
- Seeded: `packages/db/seed/seed.sql:326`.
- No reader anywhere in `apps/` or `packages/`. Portal task uploads validate against the generic document allow-list instead, so a per-request restriction ("PDF only, max 5 MB") is silently ignored.

Verified from the browser: a `.txt` upload IS rejected — but by the generic list, not by the request's own policy, so a request that permits `.txt` would still reject it, and one that forbids PDF would still accept it.

**Fix:** read both columns in the portal upload handler and validate against them, falling back to the generic list when they are null. Worth a unit test per branch, since the failure mode is silent acceptance.

**Status:** Confirmed gap. No fix applied — deferred as feature work.

## Workspace has no free-text search, though the API implements one

**Finding:** `/app/api/meta` advertises a `q` filter and the backend fully implements it — free-text match over first/last name, email and company for contacts (`apps/api/src/routes/adminApi.ts:153,191`), over title and code for submissions (`:227,274`), and over task title and assignee for tasks (`:308,332`). The Submissions tab exposes only status chips; no search input exists on any workspace tab.

**Fix:** add a search input to the workspace tab header, bound to the existing `q` parameter. Server-side work is already done, so this is a UI-only change.

**Status:** Confirmed gap, first observed in the primary-plan run and re-confirmed in the secondary run. No fix applied — deferred.

## Tasks are read-only in admin; portal forms and file requests have no admin surface at all

**Finding:** Nuance matters here.
- **Tasks** DO have an admin read surface — a workspace tab with filtering and CSV/XLSX export (`apps/admin/src/App.tsx:226-280`, `:336-346`) — but `apps/api/src/routes/adminApi.ts` exposes no POST/PUT/PATCH/DELETE for tasks. They can be viewed and exported, never created or edited. The only writer is `autoAssignAcceptTasks` on acceptance.
- **Portal forms and file requests** have no admin surface whatsoever: `file_requests` and `portal_forms` appear only in `apps/api/src/routes/portal.ts` (the speaker-facing side). They exist solely as seed data.

**Fix:** for tasks, add the write endpoints and reuse the existing schema-driven form (the same five-edit pattern as `contacts.notes` above). For portal forms and file requests, an admin CRUD surface is a larger piece — scope it deliberately rather than growing it from the seed.

**Status:** Confirmed gap. No fix applied — deferred as feature work.

## UNRESOLVED — invited session may move silently via the Move dialog (FR-COMM-6)

This one is **not** a deferred feature; it is a contradiction between two competent observations, and it needs a human.

**What the runner saw (phase U, M4.9):** moving an already-invited session through the **Move dialog** produced no "notify speakers?" prompt — the block moved and persisted silently. Reproduced twice, the second time after a full reload of `/app` against a fresh agenda payload, with `/app/api/agenda` reporting SESS-1 `invited=1`. Screenshot: `tests/screenshots/u-01/m4.9.png`.

**What the fixer saw:** on a clean seed `calendar_invites` is empty, so nothing is invited — the runner's `invited=1` came from that run's own invite send. It recreated the state by inserting a `method='REQUEST'` invite, confirmed `invited=1`, then drove the dialog twice (M-key from the Day grid changing room; List-view row double-click changing start time). **Both raised the prompt.** `MoveDialog.onSave` already calls `commitSchedule` (`apps/admin/src/agenda/AgendaSection.tsx:537`) — the same guard as the drag path — so there is nothing to reroute. It changed no code rather than fix a symptom it could not observe, which was the right call.

**Why this is still open:** the two observations differ in *how* `invited` was established — a real send during the run versus a synthetic invite row — so the trigger is not understood. `docs/07-agenda-and-scheduling.md` §6 says invited sessions never change silently; if the runner's path is reachable in production, that guarantee is broken.

**Suggested next step:** reproduce the runner's exact sequence — bulk-send confirmations first, so `calendar_invites` is populated the way the app populates it, then move via the dialog — and compare the `session.invited` value the component actually sees against the one the API returns. A shape mismatch after a real send (`invited` arriving as a string, or the payload not refetched after the send) would explain both observations at once.

**Status:** Unresolved. Needs investigation before the agenda is trusted to notify.

## Minor, accepted as safe — duration 0 does not visibly clamp

**Finding:** Typing `0` into Duration in the Move dialog is rejected via `min="5"` and the save is refused, but the field settles back to the existing value (e.g. 30) rather than visibly clamping to 5. No zero-length session is ever created, so the data stays correct; only the feedback is unclear.

**Fix (optional):** clamp the displayed value to the minimum on blur so the rejection is legible.

**Status:** Recorded and accepted as safe. No fix applied.
