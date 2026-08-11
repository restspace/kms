# Workplan 13 — Closing the four pains in `tests/features/GeneKim.md`

Status: **built 2026-08-11** — all five waves implemented and green (1003
tests, typecheck clean); migrations landed as `0021_provenance_approval.sql` +
`0022_chase_drafts.sql`, both pending on remote D1. Numbered 13 because 12 is
reserved for the in-flight Sessionboard import follow-up; nothing here depends
on workplan 11 landing first.

`tests/features/GeneKim.md` is four posts from a program chair with ~26 events
over 15 years, written as advice to people building exactly this tool. It is
the closest thing we have to a real user interview. This plan is the audit of
what we already satisfy, and five waves for what we don't.

**Framing principle:** every wave below removes a lie the tool currently tells.
We tell the committee a submission has been reviewed without letting them find
the unreviewed ones (W2). We tell an organiser their data is theirs while
holding the committee's work hostage (W1). We tell a speaker "accepted" when
their employer has not agreed (W3). We tell an event coordinator we sent the
reminder for her, which the doc says has never once worked (W4). We make the
schedule say "placed" or "not placed" when the truth for six weeks is "Tuesday
morning, somewhere" (W5).

## 0. Audit — what already holds

Recorded so a later reader does not re-derive it. File anchors are current
implementations, not proposals.

| Pain | Ask | Verdict |
| --- | --- | --- |
| #1 | Per-submission permalink | ✅ `apps/admin/src/router.ts` — every addressable bit of state is a query param (`?v=workspace&tab=submissions&rec=<id>`); `rec` is a PUSH key so Back walks records |
| #1 | One comment thread per proposal, shared by the whole committee | ✅ `apps/api/src/submissionComments.ts` + `packages/db/migrations/0018_submission_comments.sql` — append-only, same thread in the organiser detail panel and the reviewer scoring screen, reviewer rationales folded in as `kind='rationale'` |
| #1 | Sort by average score descending (the decision-meeting agenda) | ✅ submissions `sortable.rating` in `adminApi.ts`, computed off `rating_cache` |
| #1 | Sort by fewest ratings first (the coverage worklist) | ❌ **W2** |
| #1 | Deciding and telling are different acts | ✅ the strongest thing we have: `accept_queue`/`decline_queue` are distinct from `accepted`/`declined`, nothing emails on a status change, the batch send is an explicit click, `notified_at` blocks re-notification, already-notified rows are split out, and workplan 10's hold filter keeps a speaker queued indefinitely (`evaluation.ts`, `POST /submissions/send-decisions`) |
| #2 | Constraints surfaced, never enforced | ✅ conflicts recompute locally on every optimistic change, render as a chip count and a Conflicts view with a per-signature ignore list; no modal ever refuses a save (`AgendaSection.tsx`, `recompute`/`ignoredSet`) |
| #2 | "TBD" is a real value; partial states always save | ⚠️ representable, unreachable — **W5** |
| #3 | Stable ids on everything | ✅ UUID PKs throughout; the public agenda feed emits `UID:<submission id>@<slug>.kms` (`routes/landing.tsx`), so a re-publish does not churn subscribers' calendars |
| #3 | One speaker id across a decade of events | ✅ migration 0015 merged `contacts` to org level behind `event_contacts`, keeping `_contacts_premerge` and `_contact_merge_map` as the audit. This is the direct answer to "three systems say 6, 9 and 12" |
| #3 | `title_at_time` / `org_at_time` frozen at submission | ⚠️ `event_contacts.company`/`.job_title` are already *per event*, which is 80% of it — but they are mutable, so editing a profile silently rewrites history — **W1c** |
| #3 | Exports as a first-class surface | ⚠️ CSV/XLSX + JSON list endpoints + OpenAPI + `.ics` + `files.zip` exist, but only over `contacts`/`submissions`/`tasks`/`messages`. Scores, comments and decisions have no export at all — **W1** |
| #4 | Outstanding-item visibility | ✅ Speaker Tracking board: per-speaker missing bio/headshot/slides chips and a `days_overdue` list (`dashboard/DashboardSection.tsx`) |
| #4 | Co-presenter who is in no system yet | ✅ `submission_participants` + placeholder contacts (`isPlaceholderContact`) |
| #4 | Assisted chasing — a draft a human sends from their own address | ❌ **W4**. We do the opposite: `jobs/reminders.ts` `sweepReminders` auto-sends at T-7d/T-2d/T-12h plus up to `OVERDUE_CAP` overdue nudges, from `EMAIL_FROM`, with no human in the loop |
| #4 | Escalation runs by medium, not attempt count | ❌ **W4** — not modelled anywhere |
| #4 | "accepted, employer approval pending" as a state | ❌ **W3**. The doc says "Ours will." It does not |

## 1. Decisions already taken

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Reviews and comments become **resource specs in the existing registry**, not bespoke export endpoints | One `RESOURCE_SPECS` entry each buys the workspace grid, `/api/v1` list, CSV, XLSX and the generated OpenAPI at once (`openapi.ts` iterates `RESOURCES`). A hand-rolled `/export/reviews.csv` would buy one of those five and drift from the other four |
| D2 | Decisions are **not** a new table — the decision record is `submissions.status` + `notified_at` + the `message_log` row + the rationale comments | Nothing to backfill. The "decisions export" is the submissions export plus the columns it is currently missing, not a new entity |
| D3 | `title_at_time`/`org_at_time` are stamped on `submission_participants`, not frozen on `event_contacts` | The join row is the thing that happened at a moment; the profile row is current truth and must stay editable. Freezing the profile would break the portal's "fix my job title" flow |
| D4 | `approval_pending` is a **flag alongside the accepted state, not a status value** | A speaker is accepted *and* awaiting employer sign-off; the two axes are independent. Making it a status would force every `status = 'accepted'` query in the codebase into an `IN` list and would put the queue/notify state machine at risk for a field that machine does not care about |
| D5 | Assisted chasing **replaces** autonomous task reminders as the implementation; it does not sit alongside them as a second path. But `chase_mode` **defaults to `'auto'` for all events** — Brief.md #3 / FR-COMM-5 spec automated reminders as a must, and that contract is hard | Two chase mechanisms means two idempotency stories and a real chance of double-nudging a speaker. The cron becomes a *detector* that stages drafts; in `'auto'` mode the staged draft is sent in the same sweep, in `'assisted'` mode the send stays human. One pipeline, one idempotency story, spec-compliant default |
| D6 | Drafts send with the organiser's address in `Reply-To`, not in `From` | `From` spoofing fails SPF/DKIM on Resend and lands in spam — the exact failure the doc records twice ("got stuck in spam, I'm sending a personal email"). `Reply-To` gets the reply into her inbox honestly. Escalating past that is the human's job; the tool only records it |
| D7 | Escalation is **recorded, never automated** | The ladder (tool email → her email → cc chair → text → call) is a deliberate human signal per the doc. The tool's job is to show which rung a chase is on and how long it has sat there |
| D8 | Partial schedule states need no migration | `submissions.starts_at`, `.ends_at` and `.room_id` are already independently nullable and `PUT /agenda/sessions/:id` already accepts any combination. W5 is entirely UI |

## Wave 1 — Let the committee's work leave the building (pain #3)

The headline ask. Today the four registry resources are `contacts`,
`submissions`, `tasks`, `messages` (`adminApi.ts`, `RESOURCE_SPECS`). Reviews
and comment threads are reachable only through bespoke detail endpoints, so the
doc's sentence — "everything the committee produced has never left a CFP tool,
not once, in 15 years" — is currently true of us.

**W1a — `reviews` resource spec.** `baseFrom` joins `reviews r` →
`submissions s` → `contacts rc` (reviewer) → `evaluation_plans ep`. `selectSql`
exposes `submission_code`, `submission_title`, `reviewer_name`, `plan_name`,
`weighted_total`, `scores` (raw JSON — a CSV cell holding the per-criterion
object is honest; exploding criteria into columns is a per-plan-variable header
and belongs in a later wave, if ever), `comment`, `conflict_of_interest`,
`created_at`. `eventExpr` is `s.event_id` (reviews carry no event column).
Filters: `submission_id`, `plan_id`, `reviewer_contact_id`,
`conflict_of_interest`, `q` over the comment text. Sortable: `created_at`,
`weighted_total`, `reviewer_name`, `submission_code`.

**Access note, non-negotiable:** the workspace scope predicate is "every event
where this staff email holds a seat", and a *reviewer* seat must not be able to
list every other reviewer's scores wholesale. The visibility rules already
encoded in `reviewWindow.ts` and `submissionComments.ts` (`loadThread`'s
assignment check) apply here too — gate the resource to `owner`/`admin` seats
and 403 a reviewer-only session, rather than trying to filter rows.

**W1b — `comments` resource spec.** Same shape over `submission_comments`
(`event_id` is a real column there, so `eventExpr` is `sc.event_id`). Filters:
`submission_id`, `kind`, `author_contact_id`, `q`. Same seat gate as W1a.

**W1c — provenance columns.** Migration `0021_provenance_approval.sql`
(0020 was taken by the Sessionboard import, workplan 11):

- `ALTER TABLE submission_participants ADD COLUMN title_at_time TEXT;`
- `ALTER TABLE submission_participants ADD COLUMN org_at_time TEXT;`

Written once at row creation from the contributing `event_contacts` row, and
never updated. Three creation sites to cover: the CFP submit path, the admin
participant add (`adminApi.ts`), and the importer's speaker→session link. A
backfill in the same migration copies today's `event_contacts` values as the
best available approximation, with a comment saying exactly that — an
approximation labelled as one beats a NULL a future join silently reads as
"unknown".

**W1d — surface the two new resources.** Add `reviews` and `comments` to
`WorkspaceTabKey` / `WORKSPACE_TAB_KEYS` / `defaultTabs` (`App.tsx`) and to
`exportFor`, so both get the standard grid, the anchor slice and the export
button with no new UI. `/api/v1` and `/api/v1/openapi.json` follow from the
registry automatically.

**W1e — decisions in the submissions export.** Expose the columns that already
exist and are merely unselected for export: `notified_at`, the derived `rating`,
and `review_count`. There is no actor column on the status flip today, so "who
decided" cannot be exported; log it as an open question in
`docs/13-open-questions.md` rather than inventing an audit trail in this wave.

**Tests.** Registry parity test (every `RESOURCE_SPECS` key appears in the
OpenAPI document) extended to the two new resources; a reviewer-seat session
gets 403 on both; CSV round-trip over a seeded review; provenance columns
survive an edit to the contact's current job title.

## Wave 2 — The coverage sort (pain #1)

Two lines of substance. `review_count` is already computed in the submissions
`selectSql` as a correlated `COUNT(*)` over `reviews`; it is simply absent from
`sortable`, so "sort by fewest ratings first" — half of what the doc calls the
whole review UI — cannot be expressed.

- Add `review_count: '(SELECT COUNT(*) FROM reviews r WHERE r.submission_id = s.id)'`
  to the submissions `sortable` map. The NULL-ordering wrapper in
  `queryResource` does not bite here: `COUNT(*)` is never NULL, it is 0.
- Add a `min_reviews` / `max_reviews` filter pair, so "everything with fewer
  than two reads" is a filter and not just a sort — that is the actual worklist.
- Admin: the Ratings column header sorts on `review_count` on a second click
  (score desc / count asc are the two sorts the doc names), and the submissions
  tab header gets a coverage progress bar — `n of m have ≥2 reads` — reading the
  same `min_reviews` filter so the bar and the list cannot disagree.

**Tests.** Sorting ascending puts a zero-review submission first (assert
`review_count` is 0 and not NULL, or the NULL-last rule would bury it);
`min_reviews=2` and the progress bar's denominator agree on the same seeded
event.

## Wave 3 — `approval_pending` (pain #4, bonus pain)

The #1 cause of withdrawal in ten years of the author's records, with
withdrawals clustered 29 days out and a tail to 5 days — sometimes after the
speaker was announced.

Per D4 this is a flag, not a status. In the same `0021` migration:

- `ALTER TABLE submissions ADD COLUMN approval_state TEXT;` — NULL (not
  applicable / not asked) | `'pending'` | `'granted'` | `'refused'`. No CHECK
  constraint on a column we expect to grow values; validate in the route against
  one exported `APPROVAL_STATES` set, the same pattern as `SUBMISSION_STATUSES`.
- `ALTER TABLE submissions ADD COLUMN approval_note TEXT;` — "PR sign-off, legal
  says end of month", the thing that actually gets chased.

Surfaces:

- Filter and sortable on the submissions resource; a chip in the detail panel
  and an inline editor beside the status editor.
- **Speaker Tracking gets an "Approval pending" panel** next to the overdue
  list, sorted by days-until-event ascending — "approval chatter peaks about a
  month out" is only actionable if it is visible a month out.
- The accept decision email is the natural place to *ask*: an optional
  `{{approval_ask}}` block in `decision_accepted` that sets `approval_state =
  'pending'` on the covered submissions when the organiser enables it for that
  batch. Opt-in per send; not the default.
- `'refused'` does **not** auto-withdraw. It is a prompt for a human, same
  principle as D7.

**Note on the four `SUBMISSION_STATUSES` copies.** `adminApi.ts`,
`evaluation.ts`, `restApi.ts` and `importer.ts` each hold their own literal Set.
This wave adds no status value, so nothing has to be kept in sync — which is
precisely the argument for D4. Fold the duplication into one exported constant
opportunistically if the diff stays small; it is not a goal of this plan.

## Wave 4 — Assisted chasing (pain #4, the deep one)

The doc's sharpest empirical claim: *in 13 years of archive, there is zero
evidence of a tool successfully sending a reminder on our behalf*, and *a
feature that auto-emails speakers will be switched off within one event cycle*.
`sweepReminders` is that feature. Per D5 we convert it rather than add beside it.

**W4a — drafts table.** In `0022_chase_drafts.sql` (its own file so W4 can
build in parallel with W1c/W3's `0021`):

```sql
CREATE TABLE chase_drafts (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id  TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  subject_of  TEXT NOT NULL,   -- 'task' | 'draft_close' | 'approval' | 'manual'
  subject_id  TEXT,            -- assignment id, form id, submission id
  rung        TEXT NOT NULL DEFAULT 'tool_email'
                CHECK (rung IN ('tool_email','personal_email','cc_chair','text','call')),
  status      TEXT NOT NULL DEFAULT 'staged'
                CHECK (status IN ('staged','sent','dismissed','resolved')),
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL,
  staged_at   TEXT NOT NULL,
  acted_at    TEXT,
  acted_by    TEXT,
  idem_key    TEXT NOT NULL UNIQUE
);
```

`idem_key` carries exactly what today's send key carries (template, contact,
entity, offset or overdue-day index), so the existing no-double-nudge guarantee
moves from the mailer to the staging step unchanged.

**W4b — the sweep stages, it does not send.** `jobs/reminders.ts`
(`sweepTaskReminders` / `sweepDraftReminders`) keeps its selects and its offset
arithmetic verbatim; the `queueTemplated` call is replaced by an insert into
`chase_drafts` carrying the rendered subject and body. `OVERDUE_CAP` still
bounds staging. The email templates are untouched — the render step just lands
in a row instead of the outbox.

**W4c — the chase inbox.** A panel on the Speaker Tracking board listing staged
drafts grouped by speaker, each editable in place, with **Send** (queues via
`queueTemplated` with the acting organiser's address in `Reply-To`, per D6),
**Dismiss**, and **Escalate** (bumps `rung`, sends nothing — per D7 the higher
rungs happen outside the tool and the row only records that they happened, and
when). Bulk **Send all** for the common case, because a coordinator with 40
staged nudges will not click 40 times — but the click is hers.

**W4d — kill switch and migration path.** A per-event setting `chase_mode`:
`'auto'` (**default for all events, new and existing**) | `'assisted'` (opt-in).
Decided 2026-08-11: Brief.md #3 ("Automated, templated speaker communications,
including reminders") and FR-COMM-5 are hard contract, so out-of-the-box
behaviour must keep auto-sending — acceptance test 6 in `08-communications.md`
must pass on a default-configured event. The assisted inbox is the recommended
path (a one-time banner on the tracking board points at the setting), but
switching to it is the organiser's explicit choice, never the default.

**Not in scope:** actually sending from her own mailbox (needs per-user OAuth to
a mail provider — real, large, and the `Reply-To` version captures most of the
value); SMS or call logging beyond the `rung` field.

**Tests.** With `chase_mode='assisted'`, a sweep that would have sent N emails
stages N drafts and sends zero; re-running the sweep stages nothing new
(`idem_key`); Send queues exactly one message carrying the organiser's
`Reply-To`. With the default `chase_mode='auto'`, the sweep reproduces today's
behaviour byte for byte — including acceptance test 6 in `08-communications.md`
(offsets `[7,2,0]` produce exactly three sent reminders).

## Wave 5 — Partial schedule states (pain #2)

Per D8 there is no migration here. `starts_at`, `ends_at` and `room_id` are
independently nullable, and `PUT /agenda/sessions/:id` already validates each
independently (it rejects `ends_at <= starts_at` only when *both* are present).
The binary lives in one line of UI: the unscheduled tray is
`s.starts_at === null && s.room_id === null` (`AgendaSection.tsx`), so a
time-without-room session is in neither the tray nor a room column — it vanishes.

- **Three states, not two.** Tray (nothing set) · **Pencilled** (time set with
  no room, or room set with no time) · Placed. Pencilled sessions render in the
  day/week grid as a dashed, muted block spanning their time across all rooms,
  and as a chip in the room board's header strip when they have a room but no
  time.
- **Slot math in the header**, in the doc's own phrasing: `3 unplaced ·
  2 pencilled · 1 conflict`. The conflict chip already exists; the other two are
  counts over the same `filteredSessions` memo.
- **Day-only placement.** Dropping onto a day header (not a time slot) sets
  `starts_at` to the day's start and leaves the room NULL — no new column, and
  the conflict engine simply sees a session it cannot double-book a room with
  yet.
- **Never block the save.** Pencilled sessions are excluded from room-overlap
  conflicts (there is no room) but **included** in speaker double-booking
  checks, which is where the doc's named-chip-with-a-one-click-fix lives.
- The invite guard (`invite_notify_required`) must not fire on a
  placed → pencilled transition for an uninvited session; verify a pencilled
  session never reaches `sendScheduleEmails` at all.

**Tests.** Logic tests for the three-state classifier alongside
`timeUtils.logic.test.ts`; a PUT with `starts_at` and no `room_id` round-trips
and lands in the pencilled count; a pencilled session sharing a speaker still
raises the speaker conflict.

## Sequencing

W1 and W2 are independent but touch the same file (`adminApi.ts`,
`RESOURCE_SPECS`) — do them in one pass rather than conflicting with ourselves.
W3 shares migration `0021` with W1c, so those land together. W4 is the largest
and depends on nothing above. W5 is pure frontend and can go any time.

Suggested order, by value per hour: **W2 → W1 → W3 → W5 → W4**.

## Acceptance

The four pains, restated as things a user can do when this plan is done:

1. A committee member can sort the grid by fewest reads, see `n of m` coverage,
   and work the tail — the second of the two sorts the doc calls the whole
   review UI. *(W2)*
2. An organiser can export the committee's scores, comments and decisions — CSV
   or XLSX from the grid, JSON from `/api/v1` — and a speaker's job title as it
   read the year they submitted. *(W1)*
3. A speaker can be accepted *and* pending employer approval, visible on the
   tracking board a month out, when the withdrawals actually cluster. *(W3)*
4. On an event switched to `chase_mode='assisted'`, nothing emails a speaker
   unless a human clicked Send on a draft they could see and edit; the
   escalation rung is recorded. Default-configured events keep the spec'd
   auto-send (Brief #3 / FR-COMM-5). *(W4)*
5. The keynote can be "Tuesday morning, somewhere" for six weeks, and the header
   reads `3 unplaced · 2 pencilled · 1 conflict` without a modal ever refusing a
   save. *(W5)*
