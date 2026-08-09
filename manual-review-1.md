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
