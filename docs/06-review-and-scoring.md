# 06 — Review, Evaluation & Scoring

Covers brief requirement **#4 — "Submission evaluation and scoring workflows"**.
AI-assisted review is struck through in the brief and is **out of scope**.

Reference screenshots: 19–23 (Abstracts grid, status picker, column preferences, export menu,
Add Abstract drawer), 37 (review-progress dashboard).

---

## 1. Abstracts grid (`/app/e/:event/abstracts`)

Header: "Abstracts — Review and manage your abstract submissions", with **⋯ Options** and
**+ Add Abstract**.

### Status tabs (with live counts)
`All Abstracts · Accepted · Accept Queue · Pending · Decline Queue · Declined · Withdrawn · Drafts`

### Toolbar
Search · a density/layout toggle · **Saved Views ▾** · **Columns** · **Sort** · **Filter**

### Table
Default columns, in order: selection checkbox, quick-edit pencil, **Status**, **Source**,
**Title**, **Client Session ID**, **Description**, **Notified**, **Rating**, then
Session Submitter, Speaker, Track, Tags, Files, Location, Capacity, CEU Credits, Format,
Language, Level.

Footer: `1 — N of N rows`, pagination, `Show: 25 ▾` (25/50/100).

Rows virtualise; sticky header; horizontal scroll with the first columns pinned.

### Inline status editing
Clicking the status chip opens a popover listing the statuses as coloured chips with a tick on
the current value, a **Clear** action, the current selection as a removable chip, and
**Cancel / Save**:

| Status | Chip colour |
|---|---|
| Accepted | green |
| Accept Queue | light green |
| Pending | yellow |
| Decline Queue | amber |
| Declined | red |
| Withdrawn | slate |
| Draft | grey |

### Column preferences (right-hand drawer)
Tabs: **Columns (18/25)** · **Sort** · **Filter** · **Drafts**.
Left pane switches **Fields / Reporting Fields**, has a column search, and groups fields
(e.g. "SESSION DETAILS (18/39)") with **Show All / Hide All**; each field shows a checkbox, a
type icon and its type name. Right pane lists **Selected (18)** with drag-to-reorder, an ✕ to
remove each, and **Reset to Default**. Footer: **✓ Apply Changes**.

Preferences persist per user per event and can be stored as a named **Saved View** (shared or private).

### Options menu
`Import Sessions` · `Export .CSV` · `Export .XLSX` · `Download files bundle…`

### Bulk actions (appear when rows are selected)
Change status · Add/remove tags · Assign to evaluation plan · Assign reviewers · Send decision
emails · Export selection · Delete.

---

## 2. Submission detail

A right-hand drawer (or full page) with tabs **Details** and **Participants**.

**Details** — all answers grouped by form section, plus the editable operational fields: Title,
Status, Description, Starts At, Ends At, Capacity, CEU Credits, Client ID, Format, Track, Tags,
Level, Language, Files. Sidebar shows: source form, submitted date, `code`, ratings per
evaluation plan, notified flag, and a change history.

**Participants** — ordered participant list with role, name, email, bio/headshot completeness
indicators, primary-contact marker; add/remove/reorder participants; link an existing contact
or create a new one.

**Add Abstract** drawer (manual creation) collects: Title *, Status, Description, Starts At,
Ends At, Capacity, CEU Credits, Client ID, Format — then Participants on the second tab.
Actions: **Cancel** / **Create Abstract**.

---

## 3. Status lifecycle

```
        ┌───────────── withdrawn (by submitter) ─────────────┐
        │                                                    │
draft ──┴──> pending ──┬──> accept_queue ──> accepted ──> (schedulable)
                       └──> decline_queue ──> declined
```

Rules:
- `draft` → `pending` happens on public submit.
- The two queue states let organisers stage decisions and then **send all notifications at once**
  ("Send decision emails" bulk action), which flips `accept_queue → accepted` /
  `decline_queue → declined` and stamps `notified_at`.
- Only `accepted` submissions can be scheduled onto the agenda ([07](07-agenda-and-scheduling.md)).
- Status changes are recorded in history with actor and timestamp.
- Moving out of `accepted` for a scheduled session prompts: keep the schedule slot or release it.

---

## 4. Evaluation plans

An **evaluation plan** is one review round.

### Plan configuration (`/app/e/:event/evaluation`)
| Field | Notes |
|---|---|
| Name | e.g. "Round 1 — Track leads" |
| Description | Reviewer-facing instructions |
| Status | `draft / active / closed` |
| Scoring criteria | One or more; each has name, description, scale (default 1–5), weight, and an optional required comment |
| Reviewers | Contacts with the `reviewer` role on the event |
| Submissions | Assigned by filter (track, format, tag, form) or by explicit selection; routing rules can auto-assign on submit |
| Assignment strategy | `all reviewers see all` \| `round-robin N reviewers per submission` \| `manual` |
| Anonymise submitters | Hides submitter and participant names from reviewers |

Multiple plans may run simultaneously or sequentially (the multi-round need); each keeps its
own scores, and the grid can show a `Ratings: <plan name>` column per plan.

### Reviewer workspace (`/app/e/:event/evaluation/:plan/review`)
- Queue with progress ("12 of 40 reviewed") and filters (unreviewed / in progress / complete).
- One submission at a time: title, description, track, format, level, tags, files, participants
  (unless anonymised).
- Score inputs per criterion (radio scale or slider), an overall comment box, and
  **Save & Next** / **Skip** / **Flag conflict of interest**.
- Keyboard shortcuts: `1–5` to score the focused criterion, `→` next, `←` previous.
- Autosave on blur so nothing is lost.

### Aggregation
```
weighted_total(review)   = Σ(score_i × weight_i) / Σ(weight_i)
submission_rating(plan)  = mean(weighted_total) over completed reviews
```
Also surfaced: review count, standard deviation (to spot disagreement), min/max.
`rating_cache` on the submission keeps sorting fast.

### Review-progress reporting
Per the dashboard screenshot: **Evaluation plans**, **Evaluated submissions**,
**Reviews in progress**, **Most active plan**, plus per-reviewer workload and a
"reviewer assignments will appear here once evaluations begin" empty state.

---

## 5. Decisions

1. Filter or sort by rating (e.g. `Ratings: Round 1 desc`).
2. Bulk-select the top N → **Change status → Accept Queue**.
3. Review the Accept Queue tab; adjust.
4. **Send decision emails** → accepted speakers get the acceptance template (with a portal link
   and any auto-assigned tasks), declined get the decline template. `notified_at` is stamped and
   the `Notified` column updates.
5. Accepted submissions now appear in the agenda's unscheduled tray.

Decision emails are idempotent — re-running the action does not double-send (see
[08 §Idempotency](08-communications.md)).

---

## 6. Import & export

**Import Sessions** — CSV/XLSX upload with a column-mapping step, a dry-run preview showing
create/update/error counts, and `client_session_id` as the upsert key.

**Export .CSV / .XLSX** — respects the current filters and visible columns; includes participant
columns flattened (`speaker_1_name`, `speaker_1_email`, …).

**Download files bundle** — ZIP of all files attached to the filtered submissions, organised
`<code>-<title>/<filename>`.

---

## 7. Acceptance tests

1. Create a plan with two weighted criteria and three reviewers; assign 10 submissions
   round-robin at 2 reviewers each; every submission receives exactly 2 assignments.
2. Scores entered by two reviewers produce the expected weighted mean in the grid's Rating column.
3. Sorting by rating and bulk-accepting the top 3 moves exactly those to Accept Queue.
4. Sending decision emails flips queue states, stamps Notified, and does not re-send on a second click.
5. Column preferences persist across reload and a Saved View restores them.
6. A CSV export of a filtered view contains only the filtered rows and the visible columns.
