# Workplan 15 — What `docs/2026-08-09-fabian-five-questions-reply.md` implies

Status: **planned 2026-08-13** — not built. Migrations reserved as
`0040_decision_meeting.sql` + `0041_materials_loop.sql` (0037–0039 are taken by
formats / saved embeds / pipeline).

The source document is a program chair answering five questions about what four
commercial CFP tools never modelled, with every claim counted from a 10,383-message
archive spanning 2016–2026. Like `tests/features/GeneKim.md` before it (workplan
13), it is a real user interview rather than a requirement list — and it is from a
person who has run the job for a decade, not from someone imagining it.

**Framing principle:** workplan 13 removed the lies the tool tells. This plan
removes the places the tool *stops early*. Its closing sentence is the whole
brief: *"Every tool we have paid for models the CFP as a funnel that ends at
accepted. In our archive, accepted is roughly the halfway point."* Four of the
seven waves below are about what happens on either side of that point — the
decision meeting that produces the accept (W1–W2), the outcome that is neither
accept nor decline (W3–W4), and the editorial cycle that follows it (W5–W6).

**Explicitly dropped from this plan:** Post 3's sponsor modelling (slot types,
sponsor-affiliation flag). Sponsors are out of scope per `docs/00-overview.md` §3
and the decision to keep them out is deliberate, not an oversight. Post 3's
finding — that the committee/sponsor separation was enforced by which Slack
channel you stood in, never by a tool — is recorded here so a later reader does
not re-derive it, and nothing is built for it.

## 0. Audit — what already holds

File anchors are current implementations, not proposals.

| Post | Ask | Verdict |
| --- | --- | --- |
| 1 | Sort by score descending — the decision-meeting agenda | ✅ submissions `sortable.rating` (`adminApi.ts`), off `rating_cache` |
| 1 | Sort by fewest reads — the coverage worklist | ✅ workplan 13 W2: `review_count` sortable + `min_reviews`/`max_reviews` filters + coverage bar |
| 1 | The full proposal one keystroke away, every score **and** comment inline and attributed | ✅ `submission_comments` (0018) — one thread, reviewer rationales folded in as `kind='rationale'`, same thread in the organiser panel and the reviewer screen |
| 1 | Per-submission permalink (the thing that got a tool abandoned) | ✅ `router.ts` — `?v=workspace&tab=submissions&rec=<id>`, `rec` is a PUSH key |
| 1 | Deciding and telling are different acts | ✅ `accept_queue`/`decline_queue` + explicit batch send + `notified_at` + workplan 10's hold filter + the `DecisionReviewDialog` preflight |
| 1 | **Remaining slots, by track, counting down as you accept. Live.** | ❌ **W1a** — `tracks` has `id, event_id, name, color, position` and no target; the only slot math in the product is the agenda header's `unplaced · pencilled · conflict` (workplan 13 W5), which is the wrong screen at the wrong time |
| 1 | **Per-reviewer "my top-ranked, not yet accepted"** — a lobbying queue per human in the room | ❌ **W1b**. We ship the *aggregate* sort and the *coverage* sort; the doc's author built this one himself in 2022 and says it is the view that actually got used on the call |
| 1 | **An accept action that captures the condition** ("needs a business co-presenter — Ann to follow up") | ❌ **W2**. "Dozens of times a season", and the doc calls that note *the actual work product of the meeting*. We have nowhere to put it |
| 2 | **"Resubmit with guidance" as a first-class outcome** | ❌ **W3**. `SUBMISSION_STATUSES` is accept-or-decline; every tool the author used forced this into a decline, and so do we |
| 2 | **Carry the near-miss cohort forward as next season's invite lane** | ⚠️ **W4** — the destination now exists (`pipeline_cards`, 0039, org-wide; contacts org-scoped since 0015). Nothing routes into it from a decision |
| 2 | Let the champion attach one optional sentence to a decline; default to sending nothing rather than something generic | ✅ workplan 13 W4 assisted mode is exactly this shape (staged draft, editable, nothing leaves without a click); the decline path reuses it once W3 lands |
| 2 | Do **not** build a feedback questionnaire or anything that auto-sends | ✅ `chase_mode` (0022) exists precisely so a human is in the loop |
| 3 | Slot types, sponsor-affiliation flag | ⛔ out of scope — see above |
| 4 | Don't own the last 72 hours; own the **handoff** into it | ⚠️ **W6**. Green room (0019, workplan 12) covers check-in and nudge; there is no export from it, so every show-flow fact is still re-typed |
| 4 | Escalation ladder is SMS and a phone call at the top | ✅ `chase_drafts.rung` (0022) records the rung and never climbs it |
| 4 | The full speaker list *including* the co-presenter who appeared in week six | ✅ `submission_participants` + placeholder contacts; workplan 14 D7 made post-decision participant edits possible for the organiser |
| 5 | The deck attaches to the submission, with versions | ✅ `file_request_uploads.version`/`is_current` (0007) — the chain is materialised, not derived |
| 5 | Review comments sit next to the review comments that got it accepted | ⚠️ half — `file_comments` (0007) are version-anchored and `submission_comments` (0018) hold the accept discussion, but they are two threads on two surfaces |
| 5 | **"Materials received / reviewed / revision requested / final" as a visible state** | ❌ **W5**. The single largest gap in the document |
| 5 | **"Whose deck have I not seen, and who owes me a v2?"** | ❌ **W5**. The chase detector resolves when *a* file lands; there is no second chase |
| 1 | Last year's attendee feedback as a veto on repeat speakers — "the most decisive single input we have, and no CFP tool has ever held it" | ❌ **W7**, partially. We collect no attendee feedback at all, so only the *carry* half is affordable |

## 1. Decisions

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Track slot targets are a **target, never a cap**. `tracks.target_slots` is nullable; a track over target shows a red counter and nothing refuses a save | The doc's binding constraint is "the count, not the quality" — but the same archive shows slots moving between tracks all season. A cap would be the modal-that-refuses-the-save that workplan 13 D8/W5 spent a wave removing |
| D2 | Accepted-count for the counter is `status IN ('accepted','accept_queue')` | The whole point of the counter is to run *during* the decision meeting, where the accepts of the last ten minutes are still queued and unsent. Counting only `accepted` would make it read zero on the screen it exists for |
| D3 | The lobby queue is a **purpose-built endpoint** (`GET /evaluation/lobby`), not a new sortable on the submissions resource | `sortable` maps a field name to a static SQL expression and the ORDER BY builder carries no binds (`adminApi.ts`, `ResourceDef`); "my score" needs `reviews.reviewer_contact_id = session.contactId` in the ordering. A `reviewed_by` *filter* is bindable and cheap, but sorting by the caller's own score is not expressible in the registry without widening it for one consumer |
| D4 | The accept condition is a **flag alongside the accepted state**, not a status value | Straight reuse of workplan 13 D4 (`approval_state`). A speaker is accepted *and* owes a co-presenter; the two axes are independent, and a status value would force every `status = 'accepted'` query into an `IN` list |
| D5 | "Revise and resubmit" is **also a flag** (`decision_outcome`), not an eighth status — despite being conceptually a third outcome | `submissions.status` carries a `CHECK` from `0001_init.sql`, and SQLite cannot widen a CHECK without a full table rebuild. 14 child tables hold `REFERENCES submissions(id)`, so that rebuild is a genuinely risky migration for a vocabulary change. The 0026 precedent (`scoring_criteria.kind`, no CHECK, validated in the route) is the house style; this follows it. **Honest cost:** `status` alone no longer tells the whole story, so W3 adds a derived `outcome` column to the submissions export — see D6 |
| D6 | Exports expose a derived `outcome` (`accepted` \| `declined` \| `revise_requested` \| the raw status) rather than making consumers join two columns | Workplan 13 W1e already established that the decisions export is the submissions export plus the columns it was missing. A reader of the CSV must not have to know about D5's compromise |
| D7 | Revise guidance is shown back inside next year's form by **lookup at render time**, keyed on the org-scoped contact, not by copying text between events | 0015 already gives one person one id across every event in the org. Copying would fork the guidance the moment someone edits it. `resubmission_of` records the lineage so "did they act on it?" is answerable |
| D8 | Near-miss enrolment creates a **pipeline card per person**, not per submission, and is idempotent on the existing `(org_id, contact_id)` unique index | `pipeline_cards` is a people board (0039). Re-running the enrolment after a second decision batch must update the rationale, not 409 or duplicate. The talk title and score ride in `rationale`/`score` |
| D9 | `materials_state` is a flag alongside `accepted`, exactly like D4 — and `revision_requested` **re-arms the chase detector** rather than starting a second mechanism | The doc's second chase is the same chase: same idempotency story, same staged-draft inbox, same rungs. A parallel reminder path is the double-nudge risk workplan 13 D5 refused |
| D10 | The show-flow export is a **generated artifact**, not a new module | Post 4's stated lesson is *don't try to own the last 72 hours; own the handoff into it*. Building a run-of-show editor would be building the thing the doc says lives in Google Docs and text messages for good reasons |
| D11 | Prior-event speaker rating is **imported, never collected** | Building attendee feedback capture is a product of its own. The value in the doc is entirely in *having last year's number on screen during this year's decision* — and their number lives in Sessionboard/Sched, which the importer already reads |

## Wave 1 — The decision-meeting screen (Post 1)

The doc knows exactly what this screen is, because its author built it and watched
a committee use it. We have two of its four elements.

**W1a — slot targets and a live counter.** In `0040_decision_meeting.sql`:

```sql
ALTER TABLE tracks ADD COLUMN target_slots INTEGER;   -- NULL = untracked
```

- Editable in the settings Rooms & Tracks card and in `CreateEventDialog`, via
  the shared row editors in `components/RoomsTracksFields.tsx` — `TrackRowEditor`
  grows a numeric field beside the colour swatch, the same way `RoomRowEditor`
  already carries capacity. One row shape, two surfaces, as that file's header
  comment requires.
- A **slot counter strip** above the submissions grid: one chip per track with a
  target, reading `Agents 12/15 · Evals 15/15 · RAG 9/12`, plus an untracked
  total. Counts per D2. Over target renders in the error tone and blocks nothing.
- The counter reads the same filter state as the grid, so it can never disagree
  with the list — the rule workplan 13 W2 set for the coverage bar.

**W1b — the lobby queue.** `GET /evaluation/lobby` (per D3) returns, for
`session.contactId`, the submissions they personally scored that are not yet
`accepted`/`accept_queue`, ordered by *their own* `weighted_total` descending:

```sql
SELECT s.id, s.code, s.title, s.status, r.weighted_total AS my_score,
       s.rating_cache, (SELECT COUNT(*) FROM reviews r2 WHERE r2.submission_id = s.id) AS review_count
  FROM reviews r JOIN submissions s ON s.id = r.submission_id
 WHERE r.reviewer_contact_id = ? AND s.event_id = ?
   AND s.status NOT IN ('accepted','accept_queue','withdrawn','draft')
 ORDER BY r.weighted_total DESC
```

Surfaced as a **"My top-ranked, not yet accepted"** panel on the review screen
(`ReviewerWorkspace.tsx`) and as a collapsible rail on the submissions tab for
staff who also review. Each row opens the record via the existing `rec` permalink
— the doc's "full proposal one keystroke away" is already satisfied once the
queue points at it.

Also add a bindable `reviewed_by` filter to the submissions resource
(`eq('...')` over a correlated `EXISTS`), which is the cheap half of the same
idea and costs one line.

**Tests.** Counter arithmetic over a seeded event with one track at target, one
over, one untracked; the counter and a `track_id`-filtered grid agree on the same
number. Lobby endpoint excludes the caller's already-accepted rows, orders by the
caller's own score (not the mean — seed a submission where the two disagree), and
returns 403 for a session with no reviewer seat.

## Wave 2 — Conditional accept (Post 1)

*"And the outcome is often not accept/decline at all but conditional: 'accepted
if you bring a business co-presenter.' Dozens of times a season."*

Per D4, in the same `0040`:

```sql
ALTER TABLE submissions ADD COLUMN accept_condition TEXT;    -- the proviso, free text
ALTER TABLE submissions ADD COLUMN condition_met_at TEXT;    -- UTC ISO, NULL = outstanding
```

- Captured **in the accept action**, not in a later edit — the accept-queue bulk
  action and the inline status editor both offer a one-line "condition" field.
  That placement is the point: the doc's complaint is that the note is produced by
  the meeting and lands nowhere.
- Chip in the detail panel beside the status and approval chips; filter
  (`has_condition`, `condition_outstanding`) and `condition_met_at` sortable on
  the submissions resource.
- **Speaker Tracking gets a "Conditions outstanding" panel**, sitting next to the
  existing *Approval pending* panel (`DashboardSection.tsx`) and sorted by
  days-until-event. Same reasoning as workplan 13 W3: a condition nobody chases
  is a decline discovered late.
- Optional `{{accept_condition}}` block in `decision_accepted`, rendered only when
  the row has one — so the speaker is told the condition in the letter that tells
  them they are in.
- Marking a condition met is a one-click action from the panel; it never changes
  status.

**Tests.** A condition survives the accept-queue → accepted flip and the decision
send; the email renders the block only for rows carrying one; the panel excludes
rows with `condition_met_at` set.

## Wave 3 — Revise and resubmit (Post 2)

*"The most valuable rejection in our archive isn't a rejection… 'column 2, we
need to ask them to resubmit with some new guidance to them.'"*

Per D5 this is a flag, and per D6 the export hides the compromise. In `0040`:

```sql
ALTER TABLE submissions ADD COLUMN decision_outcome TEXT;   -- NULL | 'revise'
ALTER TABLE submissions ADD COLUMN revise_guidance TEXT;    -- what to change, speaker-facing
ALTER TABLE submissions ADD COLUMN resubmission_of TEXT REFERENCES submissions(id) ON DELETE SET NULL;
```

- **Setting it.** From the decline queue: "Ask to revise" sets
  `decision_outcome='revise'` and opens the guidance field. The row stays in
  `decline_queue`/`declined` for every state machine that already exists —
  scheduling, notification, the queue counts — so nothing downstream changes.
- **The letter.** A new `decision_revise` template key alongside
  `decision_accepted`/`decision_declined`, selected in the same place
  (`bulkJobs.ts` `send-decisions` expander and `evaluation.ts`). It carries
  `{{revise_guidance}}`. Merged multi-decision speakers (`decision_summary`) get a
  third block after accepts and declines.
- **Shown back next year** (D7). When a CFP form renders for a signed-in contact,
  look up that contact's submissions across the org carrying
  `decision_outcome='revise'`; if any exist, the form shows a dismissible panel
  with the guidance and the prior title. A submission created from that panel
  stamps `resubmission_of`.
- **The grid.** A distinct "Revise & resubmit" chip driven by the flag, a filter
  chip alongside the status chips, and the derived `outcome` column in the
  export per D6.

**Tests.** A `revise` row sends `decision_revise` and never `decision_declined`;
the merged summary carries three blocks in the right order; a returning contact
sees their guidance and a first-time submitter sees nothing; `resubmission_of`
survives the round trip and the export's `outcome` column reads
`revise_requested` where `status` reads `declined`.

## Wave 4 — The near-miss invite lane (Post 2)

*"The near-miss cohort — those 13 talks at 4.5+ that didn't fit — evaporates
annually. Nothing carries it into next season… It is the highest-quality lead
list the conference owns, and we throw it away every year."*

The destination shipped in 0039. This wave is the road to it, and needs **no
migration**.

- `POST /app/api/crm/pipeline/enroll-submissions` — body is a list of submission
  ids (or the current grid filter, matching how other bulk actions scope). For
  each submission's primary speaker: upsert a `pipeline_cards` row at stage
  `identified`, per D8 idempotent on `(org_id, contact_id)`. `score` takes the
  submission's rating normalised to 0–100; `rationale` takes
  `"<code> — <title> (rated 4.6, declined 2026)"`. Writes one
  `pipeline_activity` row of `kind='enrolled'` exactly as the existing card-create
  path does, so a card enrolled this way is indistinguishable from a hand-made one
  in the timeline.
- **Bulk action in the submissions grid**: "Add to speaker pipeline", live
  wherever the existing bulk actions are. The natural gesture is: sort by rating
  desc, filter to `declined`, select the top of the tail, enrol.
- A **suggestion on the decision review dialog**: after a batch that declined
  rows rated above the event's accepted-mean, offer "N declined talks rated 4.5+
  — add their speakers to the pipeline?" as one click. This is the actual moment
  the archive says the list is lost.
- Re-enrolment appends a second `rationale` line rather than overwriting, so a
  person who near-missed twice reads as a stronger lead, which is true.

**Tests.** Enrolling the same contact twice produces one card and two activity
rows; a submission with no participants is skipped and counted in the response;
cards land at `identified` with the rating carried; the pipeline board renders
them without a schema change.

## Wave 5 — The post-accept editorial loop (Post 5)

The document's own answer to "the one we stopped noticing", and the largest wave
here. Every ingredient exists; there is no state over them.

**W5a — the state.** In `0041_materials_loop.sql`, per D9:

```sql
ALTER TABLE submissions ADD COLUMN materials_state TEXT;      -- NULL | received | reviewed | revision_requested | final
ALTER TABLE submissions ADD COLUMN materials_state_at TEXT;
ALTER TABLE submissions ADD COLUMN materials_owner_id TEXT REFERENCES contacts(id) ON DELETE SET NULL;
```

No CHECK (0026 precedent); validated against an exported `MATERIALS_STATES` set
the way `APPROVAL_STATES` is. `materials_owner_id` exists because the doc's
sharpest structural point is that this work *has never scaled*: the 2016 retro
action item was "divide up slide deck reviews and share the load", and ten years
later it is still one person. A reviewer per deck is the smallest thing that makes
sharing the load expressible.

- `received` is set **automatically** when a current upload lands against the
  event's slides file request — that transition needs no human and pretending
  otherwise adds a click to every deck.
- `reviewed`, `revision_requested` and `final` are set by a human, from the
  submission detail panel and from the tracking board.

**W5b — the second chase.** `revision_requested` re-arms the detector:
`chase_drafts.subject_of` grows `'materials'`, and the sweep in
`jobs/reminders.ts` stages a draft for any accepted submission sitting in
`revision_requested` past its offsets. In `chase_mode='auto'` it sends as
everything else does; in `'assisted'` it lands in the chase inbox. One mechanism,
one idempotency key, per D9 — the unbroken 2018→2025 second chase the doc
documents becomes the same machinery as the first.

**W5c — the answer to the question.** A **Materials** panel on the Speaker
Tracking board, in the doc's own two questions:

- *Whose deck have I not seen* — accepted, `materials_state = 'received'`.
- *Who owes me a v2* — `revision_requested`, sorted by days since the request.

Plus a third line the existing data already supports and nobody surfaces:
accepted with no upload at all (`materials_state IS NULL`), which is the front of
the same queue.

**W5d — one thread, not two.** The submission detail panel renders `file_comments`
for the current version inline beneath the `submission_comments` thread, labelled
by version, so the deck feedback and the accept discussion read as one history —
"the review comments sit next to the review comments that got it accepted". No
schema change: both tables already carry author, role and denormalised name, and
`file_comments` is deliberately version-anchored (0007) so the labelling is
already correct.

**Tests.** An upload flips `NULL → received` and does not overwrite a later
state; `revision_requested` stages exactly one chase draft per offset and none
after the next upload; the tracking panel's three counts partition the accepted
set; a v1 comment stays visible and correctly labelled after v2 lands.

## Wave 6 — The show-flow handoff (Post 4)

*"Don't try to own the last 72 hours. Own the handoff into it. Every fact the
show-flow doc needs should be one generated export. Today every one of them is
re-typed by hand."*

Per D10 this is one endpoint and one column. In `0041`:

```sql
ALTER TABLE submissions ADD COLUMN intro_script TEXT;   -- what the host reads out
```

The doc's median intro script lands at T-20 with a 10th percentile of T-2, so this
is a field that gets filled late by whoever is nearest — it belongs on the
submission, editable from the green room screen as well as the detail panel.

`GET /app/api/greenroom/showflow.csv` (and `.xlsx`, via the existing `toCsv`/
`toXlsx` writers in `export.ts`), one row per scheduled session in running order:
day, start, end, room, track, code, final title, format, every participant with
role and the job title *as it read at submission* (`title_at_time`, workplan 13
W1c), primary contact and mobile, `intro_script`, `materials_state` and the
current deck's filename, AV notes (room `notes`), and the arrival flag from
`event_contacts.arrived_at` (0019).

Pencilled sessions (0035) are included and marked, rather than dropped — a
show-flow doc built three days out has half-placed sessions in it, and omitting
them would reproduce exactly the failure workplan 13 W5 fixed on the agenda.

**Tests.** Running order matches the agenda's day/room ordering; a session with a
week-six co-presenter lists both speakers; a pencilled session appears flagged;
the XLSX parses back through the importer's reader.

## Wave 7 — Last year's number, on this year's screen (Post 1)

*"That is the most decisive single input we have, and no CFP tool has ever held
it — it lives in the other tool, for the previous event."*

Per D11 we carry it, we do not collect it. In `0041`:

```sql
ALTER TABLE event_contacts ADD COLUMN prior_rating REAL;        -- attendee rating at THIS event
ALTER TABLE event_contacts ADD COLUMN prior_rating_note TEXT;   -- e.g. "bottom quartile, n=41"
```

It lives on `event_contacts` (not `contacts`) because a rating is a fact about one
person at one event — the same field-split rule `docs/02` §2 applies to bio and
job title.

- **Importer**: two new mappable columns on the contacts import, so a Sched or
  Sessionboard feedback export lands in one pass. This is the whole delivery
  mechanism; there is no capture UI.
- **Reviewer screen**: when a submission's speaker has an `event_contacts` row at
  an *earlier* event in the same org carrying `prior_rating`, show it as a chip —
  "Spoke at AIE 2025 · 3.1" — linking to that event's record. The org-scoped
  contact (0015) makes this a single join.
- Never folded into the score. The doc is explicit that this input is used as a
  veto argued out loud by a human, and quietly weighting it would be exactly the
  auto-applied score `docs/15` §2 rules out for AI review.

**Tests.** A returning speaker's chip reads the *earlier* event's row and not the
current one; a first-time speaker shows nothing; the rating never enters
`rating_cache` or any aggregate.

## Sequencing

`0040` carries W1a, W2 and W3; `0041` carries W5, W6 and W7 — two files so the
decision-meeting work and the materials work can build in parallel, the same split
workplan 13 used for `0021`/`0022`. W4 needs no migration and depends on nothing.

Suggested order, by value per hour:

**W4 → W2 → W1 → W5 → W6 → W3 → W7**

W4 is an afternoon and reuses a board that already exists. W2 and W1 are small and
land in patterns the codebase already carries (`approval_state`; the coverage
bar). W5 is the largest and the most valuable. W3 is cheap in code but wide in
surface (template, merged summary, public form, export), so it wants a clear run.
W7 is last because its value depends on someone actually having a feedback export
to import.

## Acceptance

The document's five posts, restated as things a user can do when this is done:

1. During the decision call, the screen shows remaining slots per track counting
   down as talks are accepted, and each member has their own "my top-ranked, not
   yet accepted" list to lobby from. *(W1)*
2. An accept can carry its condition — "needs a business co-presenter" — the
   speaker is told it in the acceptance letter, and it appears on the tracking
   board until someone marks it met. *(W2)*
3. "Resubmit with guidance" is an outcome the tool can express, the guidance goes
   out in its own letter, and it is shown back to that person inside next year's
   submission form. *(W3)*
4. The near-miss cohort does not evaporate: declined-but-highly-rated speakers are
   one click from next season's invite lane, and the click is offered at the
   moment the batch is decided. *(W4)*
5. An accepted talk keeps accumulating. The deck has a state, a second chase, and
   an owner; the tracking board answers *whose deck have I not seen, and who owes
   me a v2* without asking one person to remember. *(W5)*
6. Every fact the show-flow doc needs leaves in one export, pencilled sessions
   included and marked. *(W6)*
7. Last year's attendee rating for a returning speaker is on screen during this
   year's review, as a fact a human argues with — never as a number folded into a
   score. *(W7)*
