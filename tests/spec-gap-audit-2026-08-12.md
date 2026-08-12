# KMS Spec Gap Audit — 2026-08-12

Static code audit of `C:\info\kms` (main @ ad5da98) against the seven eval specs in
`C:\dev\killmysaas-evals\specs`. Every scenario traced through the API, admin SPA, public
portal, and DB schema — no runtime, code evidence only. Produced by seven parallel
code-audit agents; `file:line` anchors verified in source at audit time.

**Headline:** the app implements the large majority of the ~66 rubric items. Genuinely
missing features cluster in the Speaker CRM area (pipeline, segments, org dashboard) and
auto-scheduling. The most damaging non-feature problems are read-path bugs and gating
rules that make working functionality *invisible* to an evaluator: the `agenda_published`
gate, the portal file-request chain lookup, and overdue-only reminders.

---

## 1 · Small fixes

Localized changes — a query, a render path, a label, a link. Roughly ordered by eval impact.

| # | Area | Fix | Where |
|---|------|-----|-------|
| 1 | Content | **Portal can't show file versions/comments for admin-created tasks.** Read path requires `tasks.file_request_id`, but uploads store under a synthesized `file-request-task-<id>` chain. Fall back to the synthesized id — one line. Unblocks CNT-04/05 speaker evidence. | `portal.ts:1306-1311` |
| 2 | Content | **Bulk reminders only exist for overdue tasks** — both the button render condition and the endpoint's SQL filter. With the fixtures' 2027 due dates nothing is ever overdue. Key on outstanding instead, or wire the existing per-task `POST /tasks/:id/remind` into the SPA. | `DashboardSection.tsx:759`, `dashboard.ts:523` |
| 3 | Speaker mgmt | **Portal home undercounts sessions.** The "My Submissions" widget uses a submitter-only query; participant-attached speakers see "You have not submitted anything yet" while the Submissions tab shows the session. Use the participant-aware query the tab uses. | `packages/db/src/index.ts:176`, `portal.ts:441` |
| 4 | CRM | **Contact notes never render on the profile.** Stored and editable, but the read-only detail panel omits `notes`. | `App.tsx:1024-1037` |
| 5 | CFP | **Speaker portal shows internal queue statuses.** Between "Accept Queue" and the send job completing, the speaker's dashboard literally reads "Accept Queue". Map queue states to a public label. | `portal.ts:240-243` |
| 6 | Agenda | **Conflict warning names the speaker only in a hover tooltip.** On-grid cards show a bare ⚠; the message text renders only in the Conflicts tab and the mid-drag ghost. Surface it on/near the card (the AIA-04 blocker). | `TimeGrid.tsx:425,450` |
| 7 | Agenda | **Publish toast advertises `agenda.json`** rather than linking the human agenda page `/e/:slug/agenda`. | `AgendaSection.tsx:588,701` |
| 8 | Widgets | **Session cards print the raw ISO day** (`2027-05-12 · 9:00–9:45`); the modal already uses `fmtDayLong`. Same for itinerary cards, which show no date at all. | `SessionsWidget.tsx:79`, `ScheduleWidget.tsx:176` |
| 9 | Abstracts | **Reviews export is not human-readable:** `scores` is JSON keyed by criterion UUID, and the `comment` column is always empty (rationale moved to `submission_comments`). Key by criterion name; join or drop the dead column. | `adminApi.ts:612` |
| 10 | Abstracts | **Rating sort's third click switches to review-count order**, which reads as a broken sort. Consider desc → asc → clear. | `App.tsx:1211-1214` |
| 11 | CFP | **Add-field dialog has no Required toggle** — fields are created optional and must be flagged afterwards in the row. | `FormBuilder.tsx:685`, `formsAdmin.ts:672` |
| 12 | CFP | **Public portal H1 omits the event name** (only in `<title>`), and a fresh form defaults to "Untitled form". | `SubmitPage.tsx:865`, `submit.tsx:461` |
| 13 | CFP | **Root landing page always advertises the oldest event**, so a new event's CFP link is only reachable via the builder's Copy Link. | `landing.tsx:33-37` |
| 14 | CFP | **New events start with an empty field library** — the first form in a second event has zero questions. Seed default field definitions on event create. | `adminApi.ts:3327`, `formsAdmin.ts:755` |
| 15 | Speaker mgmt | **Portal-invite link is built from `APP_URL` unconditionally**, unlike the magic-link path which honors request origin in dev. | `messagingAdmin.ts:88` |
| 16 | Speaker mgmt | **"Speakers" audience misses roster-only contacts** (defined as anyone attached to a submission). Consider an "All contacts on roster" audience. | `messagingAdmin.ts:167-208` |
| 17 | Content | **Files library loses the session association** when the upload task targeted contacts rather than submissions — "For" falls back to speaker name only. | `adminApi.ts:2493`, `App.tsx:1761` |
| 18 | Widgets | **Gallery detail modal: bio has no "Show more"; the sessions heading has no count.** Cosmetic against the rubric wording. | `SpeakerDetailWidget.tsx:22-34` |
| 19 | Agenda | **Rooms/tracks unreachable from the builder** — CRUD lives only in Settings. A link/affordance from the builder toolbar would close AIA-02. | `AgendaSection.tsx:672-721` |

## 2 · Feature-scale gaps

Missing capabilities needing real design decisions, new schema, or a new surface.

### Missing outright

- **Speaker sourcing pipeline (CRM-07/08).** No kanban board, stages, prospect/enroll
  concept, or stage-transition history anywhere — no tables in any of the 31 migrations.
  Nearest thing is the read-only submission-count funnel on the dashboard. Needs:
  pipeline/stage schema, contact enrollment, drag-and-drop board, per-card notes +
  timestamped stage history (`content_revisions` machinery reusable for the history half).
- **Saved segments / lists (CRM-09).** No saved-view concept in admin, API, or DB.
  Filters are already URL-encoded (`flt=` base64), so a minimal version is "name and
  store the current filter URL" — schema plus a small list UI.
- **Org-wide CRM dashboard (CRM-12).** Every dashboard query is bound to one event.
  Spec wants org-level KPIs: total contacts, returning speakers, top companies.
- **Auto-schedule assist (AIA-08).** No auto-place control, endpoint, or job; no AI on
  the agenda lane at all. Even a greedy "fill unscheduled sessions into free room slots
  avoiding speaker conflicts" button would score — the conflict engine already exists in
  `packages/core/src/agenda.ts`.

### Structural / needs a design decision

- **True org-level contact directory (CRM-01/02).** The Speakers tab scoped to
  "All events" is a union of event rosters — the query hard-joins `event_contacts`, so an
  org contact on no event never appears; no top-level CRM nav entry; only filter is
  confirmation status. A real directory also gives CRM-11's bulk email a
  directory-selection entry point (checkbox select → Communicate), currently absent.
- **Password auth / fixture credential sign-in (cross-cutting).** Auth is magic-link
  only — no signup, no passwords. Fixture personas carry passwords that cannot work;
  inline links appear only under `DEV_MODE=on` or for the two seeded demo identities.
  Every "sign out and sign back in as X" step in four of seven specs hinges on this.
- **Speaker status on the speaker record (SPK-04).** Status is derived from
  `submission_participants.confirmed_at` and only settable from a submission's
  participant row — unsettable for roster-only speakers; vocabulary is
  Confirmed/Awaiting only.
- **Co-author add on portal edit (ABS-11).** The portal edit form only rebuilds
  abstract-section answers and never touches participants.
- **Per-round scoring scale (ABS-01).** `scoring_scale_min/max` columns exist on plans
  (and criteria) but nothing writes or reads them — every round locked to 1–5; spec's
  Round 2 wants 1–10.
- **Per-submission reviewer assignment UI (ABS-05).** The assign endpoint accepts
  `submission_ids` but the UI never sends it — assignment always deals the whole round.
  Related: no per-reviewer assignment cap anywhere (ABS-06).
- **Decision email compose/preview step (CFP-14).** "Send decision emails" fires stored
  templates immediately with no compose or preview dialog; only queue-state rows send —
  statuses set directly to Accepted/Declined are silently skipped. Related: no template
  picker in general compose (SPK-14); no explicit "Save as draft" button on the public
  form (CFP-07 — autosave + resume exist, the control doesn't).
- **Session formats as a managed entity (CFP-S1).** Tracks are first-class; formats are
  seeded literals on a per-event field definition, editable only per-form.
- **Embeds: saved embeds list (EMB-15).** The embed area is a stateless generator —
  nothing persists, no list screen, no Save button.
- **Task audiences (CNT-01).** Task assignment is pick-contacts-one-at-a-time; no
  "all speakers" audience option like the messaging composer has.

## 3 · Eval-harness & fixture risks

Not app defects — things in the specs, fixtures, or run choreography that will fail
scenarios against working code.

- **`agenda_published` defaults to 0** and 404s every public feed, page, and headshot.
  EMB-S1's precondition only covers content approval — if area 05 never publishes, all
  five widgets render "not published yet" and ~16 EMB rubric items fail against correct
  code. (CNT-12's approval gate is equally unobservable at area-04 time.)
- **Fixture passwords are unusable by construction** — the app is magic-link only.
  Runs depend on demo-login buttons, the organizer-side invite-link display, or real
  mailboxes via `personaEmails`.
- **2027 due dates make CNT-08 untestable** — nothing is ever overdue (compounded by
  the app-side overdue-only design, fix #2).
- **Fixture merge placeholders (`{speaker_name}`, `{talk_title}`) are not the app's
  syntax** (`{{speaker.first_name}}`, `{{submission.title}}`) — pasted verbatim they
  render literally.
- **New review rounds default to anonymized** — CFP-S3's reviewer will not see Priya's
  name unless the organizer unticks "Hide submitter identities".
- **Feed caching (`s-maxage=60`, SWR 300)** means an edit-then-immediately-verify
  consistency check (EMB-16) can read stale data for up to 5 minutes; no manual refresh.
- **ABS-14 AI triage is explicitly out of scope** in the app's docs and the clone makes
  no AI claim in its UI — should score N/A, not missing.

## Per-area verdict

| Spec | State | One-line verdict |
|------|-------|------------------|
| 01 Call for Papers | strong | Builder, conditional logic, portal, decisions all real; frictions are two-stage decision queues, no compose step, and the auth model. |
| 02 Abstract Mgmt | strong | Rounds, weighted scorecards, blind review, CoI, exports all built; scale locked to 1–5, no co-author-on-edit, no assignment matrix or cap. |
| 03 Speaker Mgmt | strong | Roster, import, tasks, portal, bulk comms solid; status model and portal-home widget are the gaps, auth is the run risk. |
| 04 Content Mgmt | good, two traps | Versioning/comments/library/ZIP all built; portal chain-id bug hides them from speakers, and reminders are overdue-only. |
| 05 AI Agenda | good, one hole | Builder + conflicts + publish complete; auto-schedule (AIA-08) simply doesn't exist; conflict text visibility is the other deduction. |
| 06 Public Widgets | strong | All five widgets + embed generator genuinely implemented; risk is the publish gate leaving them empty, plus no saved-embeds screen. |
| 07 Speaker CRM | weakest | Contact plumbing (import, merge, custom fields, cross-event history) strong; pipeline, segments, and CRM dashboard don't exist; directory is event-bound. |
