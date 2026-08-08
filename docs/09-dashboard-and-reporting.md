# 09 — Dashboard, Reporting & Embeds

Covers brief requirement **#6 — "Real-time dashboard showing which speakers still have
outstanding onboarding tasks."**

The screenshots annotate the dashboard as *"optional but nice to have, best efforts"* — but
requirement #6 is a **primary** listed feature. Reconciliation: **the speaker-tracking view is
required; the wider dashboard-builder machinery is optional.** Build the speaker-tracking answer
well and keep the rest simple.

Reference screenshots: 34–40.

---

## 1. Dashboard home (`/app/e/:event/dashboard`)

Header line: `SATURDAY, AUGUST 8 · 65 DAYS TO EVENT`, then a greeting — "Good morning, Sw".

**Dashboard switcher** (coloured dots): `Today · Review Progress · Speaker Tracking ·
Submissions Pipeline`, with **+ Add Dashboard** on the right.

### KPI tiles
`Submissions` · `Accepted Speakers` · `Exhibitors` · `Sponsors`
(hide Exhibitors/Sponsors — the group types are out of scope.)

### Submission-status tiles
`Accepted · Pending · Declined · Drafts · Withdrawn`

### "Also check" strip — the actionable core
A single row of nudges, each deep-linking to the screen that resolves it:

- "1 accepted session still needs a time slot on the agenda." → Agenda, filtered to unscheduled
- "3 session submissions are awaiting a decision." → Abstracts, Pending tab
- "2 accepted speakers are missing a bio or headshot (2 bios, 2 headshots)." → Speakers, filtered
- "N speakers have outstanding tasks." → Speaker tracking
- "+N more" expands the rest

These are computed from the conflict/completeness rules and are the most valuable part of the
dashboard — an organiser should be able to work the list top to bottom.

### Tabs below
`Submission Forms · Participants · Evaluations · Agenda`

| Tab | Content |
|---|---|
| **Submission Forms** | *Submission Pacing* (cumulative submissions vs days-to-event, toggle "Days before event" / "Calendar date", optional prior-event comparison), *Your forms* cards with progress bars and View/Manage actions, *Recent Submissions* table (Source, Title, Status, Speakers, Tags, Submitted) |
| **Participants** | The two nudge banners (*awaiting a decision*, *missing bio or headshot*) plus a **Program snapshot**: PARTICIPANTS BY ROLE (unique-participant total with a per-role breakdown and share) and SUBMISSION STATUS donut (accepted abstracts / accepted sessions / pending abstracts / pending sessions, counts and %) |
| **Evaluations** | *Review progress* — reviewer assignments, evaluation plans, evaluated submissions, reviews in progress, most active plan |
| **Agenda** | Scheduled vs unscheduled, sessions per day, sessions per room, conflict count |

---

## 2. Speaker Tracking dashboard — **required**

Description line: *"Confirmation status, outstanding tasks, and an overdue list for accepted speakers."*

| Widget | Definition |
|---|---|
| **Accepted Speakers** (stat) | Distinct contacts who are participants on ≥1 `accepted` submission |
| **Outstanding Speaker Tasks** (stat) | `TaskAssignment` rows with `status != complete` for those speakers |
| **Speaker Confirmation Mix** (donut) | Confirmed / awaiting confirmation / declined among accepted speakers |
| **Top Speakers by Outstanding Tasks** (bar list) | Speaker name × count of incomplete tasks, descending — the direct answer to requirement #6 |
| **Overdue tasks** (list) | Task, speaker, due date, days overdue, with a "Send reminder" action per row and a "Remind all" bulk action |
| **Asset completeness** (list) | Accepted speakers missing bio, headshot, or slides |

Each row links to the speaker's contact record and to their portal task list. This screen is what
an organiser opens every morning in the last month before the event, so it must load fast and be
directly actionable — reminders sent from here, not from a separate module.

---

## 3. Submissions Pipeline dashboard

*"Funnel of submissions from received → reviewed → accepted, with per-form and per-track context."*

Widgets: `Total Submissions` (stat), `Pending Review` (stat), `Submissions by Form` (bar),
`Submissions by Track` (bar), plus a funnel (received → reviewed → decided → accepted → scheduled).

---

## 4. Review Progress dashboard

*"Reviewer workload, session scores, top-rated sessions, and pending submissions."*

Widgets: reviews completed vs assigned per reviewer, score distribution histogram,
top-rated sessions list, submissions with no reviews yet, average time-to-review.

---

## 5. Schedule Health dashboard (stretch)

*"Scheduled vs unscheduled sessions, sessions per day/room/track, and conflicts."*
Stats `Scheduled` / `Unscheduled`; bars for sessions per day and per room; conflict counter.

---

## 6. Dashboard builder (optional)

**+ Add Dashboard** opens a modal with three tabs — **Gallery**, **AI prompt**, **Build manually**.
The gallery offers pre-built dashboards with a thumbnail, description, category chip and widget
count: Event Overview, Submissions Pipeline, Speaker Tracking, Review Progress,
Evaluation Plans by Tracks, Schedule Health.

Custom dashboards support **+ Add Widget** and per-dashboard **Settings**. Widget types:
`stat`, `bar`, `donut`, `line`, `list`, `nudge`.

**Recommendation:** ship the four named dashboards as fixed layouts. Build the generic
widget/gallery machinery only if the core features are finished — it is explicitly optional and
the AI-prompt tab is far outside the frozen scope.

---

## 7. Real-time behaviour

The brief says *real-time*. Baseline implementation:

- Aggregates cached in KV with a 15-second TTL, invalidated immediately on any write that
  affects them (submission status, task completion, schedule change).
- The client polls `/api/v1/dashboard/:key/summary` every 15 s with `If-None-Match`; a 304 costs
  almost nothing.
- Stretch: a Durable Object per event pushes `submission.*`, `task.*` and `session.*` events over
  WebSocket and the dashboard subscribes.

Every widget shows a subtle "updated Ns ago" indicator so the freshness claim is visible.

---

## 8. Reporting & exports

- Every grid (Abstracts, Sessions, Contacts, Tasks, Reviews) exports to **CSV** and **XLSX**,
  honouring current filters, sort and visible columns.
- **Download files bundle** produces a ZIP of submission files.
- A **Reports** section can host saved, shareable queries (stretch).
- Exports are permission-gated and written to the audit log because they contain PII.

---

## 9. Embeds (optional — brief item #9 is struck through)

Reference screenshots 32–33: **CMS → Embeds**, *"Export a feed of your agenda, sessions, or
speakers to place in your app or website."*

If built, keep it minimal:
- Formats: `agenda`, `session_list`, `schedule_itinerary`, `speaker_list`, `speaker_gallery`.
- Each embed has a name, enabled flag, **Style Options**, **Filters** and **Field Options**.
- Delivery: a public token URL rendering server-side HTML plus a `<script>` loader that injects an
  iframe (`/embed/<token>`), auto-sizing via `postMessage`. Mobile-friendly, cached 5 minutes at
  the edge, auto-updating as sessions and speakers change.
- Editor has **Preview** and **Get Code**, with desktop/mobile preview toggles and a
  "Copy code" button.
- Only **published** sessions and accepted speakers appear.

---

## 10. Acceptance tests

1. Completing a task in the portal decrements *Outstanding Speaker Tasks* within one refresh cycle.
2. Accepting a submission increments *Accepted Speakers* and adds an "needs a time slot" nudge.
3. Scheduling that session removes the nudge.
4. A speaker with three incomplete tasks appears at the top of *Top Speakers by Outstanding Tasks*.
5. "Remind all" from the overdue list sends exactly one reminder per overdue assignment.
6. Uploading a headshot clears that speaker from the missing-assets list.
7. Exporting the Pending tab yields only pending rows with the visible columns.
