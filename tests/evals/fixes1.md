# fixes1.md — remediation plan from `report1.json`

**Source:** `tests/evals/report1.json` — killmysaas-evals kit 0.1.0, run 2026-08-09
15:23→17:04 against `https://kms.r-s.workers.dev`. Agent `claude-sonnet-5`, judge
`claude-opus-5`.

**Headline:** overall **42.5%**, coverage **56.8%**, score **withheld** — 44 of 80
rubric items are pending manual judgement, 36 of them `cannot_judge`.

| Area | Weight | Score | Coverage | Earned / Max |
|---|---|---|---|---|
| Call for Papers | 20 | 67.5% | 58.8% | 13.5 / 34 |
| Abstract Management | 20 | 50.0% | 25.0% | 3.5 / 28 |
| Speaker Management | 15 | 60.5% | 57.6% | 11.5 / 33 |
| Content Management | 15 | 33.3% | 38.7% | 4.0 / 31 |
| AI Agenda | 10 | 40.0% | 55.6% | 4.0 / 18 |
| Public & Embeddable Widgets | 20 | 4.4% | 100% | 1.5 / 34 |

Verdict spread: 8 pass · 17 partial · 3 fail · 18 not_found · **36 cannot_judge**.

**The single most important reading of this report:** only 21 of 80 items were
actually decided against the app. The dominant failure mode is not "the feature is
wrong", it is "**the agent never got to see it**" — because admin grids hang, two
admin sections error, and every scenario burned its 70-turn budget fighting the UI.
Fixing the load failures is worth more than building any one feature, because it
converts ~36 undecided items into judgeable ones.

Point arithmetic below uses each area's points-per-rubric-unit
(area weight ÷ area total weight): CFP 0.588, ABS 0.714, SPK 0.455, CNT 0.484,
AIA 0.556, EMB 0.588.

---

## Decisions — resolved

**D1 — Public widget scope → (a) all five widgets.** Build sessions list, speakers
list, agenda grid, schedule itinerary and speaker gallery. Clears EMB-01…EMB-14,
~+17 pts. Context: the app has no public HTML surface at all — `apps/public/src`
contains only the CFP submit wizard, and the sole public event artifact is the raw
JSON feed at `/e/:slug/agenda.json` (`apps/api/src/routes/landing.ts:215`). Full
sub-item breakdown in **F5**.

**D2 — Embed/share module → (a) full generator.** Per-widget snippet generator with
output-format, branding, filter and field-selection options (EMB-15, w=2, ~+1.2 pts).
The JSON feed already exists, so the JSON/iCal/XML output formats are mostly plumbing;
the styled-HTML `<script>` embed and the config UI are the real work. See **F8**.

**D3 — Demo tenant → (a) allow real self-signup on the public form.** CFP-05 lost
points purely because the portal is pre-authenticated as a fixed demo identity (Ada
Lovelace, email field disabled), so "a speaker can create a submitter account from the
portal" was never exercisable. Same root cause behind the SPK-02 duplicate-email dead
end. See **F16** and **F13**.

**D6 — Rooms/tracks → (c) fields on the create-event dialog; rooms and tracks are
per-event.** Rooms and tracks are read-only today: the API only SELECTs from
`rooms`/`tracks` (`apps/api/src/routes/agenda.ts:131`), there is no create endpoint,
and a freshly created event therefore offers only "No room" / "No track" — the sole
reason AIA-03 is an outright `fail`. See **F6**.

**D8 — Eval-harness turn budget → yes, adjust before the next run.** Raise the turn
cap and/or split the long scenarios in `C:\dev\killmysaas-evals\evalconfig.json`.
Every one of the six areas lost items to `agent_error` at the 70-turn limit.

**D9 — Re-run strategy → targeted first.** Re-run `02-abstract-management` +
`04-content-management` after P0 lands, then a full run.

**D4 — File versioning + file comments → in, built properly.** Satisfy the rubric
(version list, current flag, older versions retrievable, cross-role comment thread)
*and* close FR-PORTAL-8 properly. See **F17**.

**D7 — Import → option (ii), built to spec.** Build FR-REV-8's session importer
(CSV/XLSX, column mapping, dry-run preview) and a speakers variant on the same
machinery, plus FR-REV-8's files-bundle ZIP. Satisfies rubric SPK-03 and CNT-14 and
closes a Should-priority requirement. See **F18**.

**D5 — Content change history with restore → out.** Not built this round. The rubric
item (CNT-11, w=2, ~+1.0 pts) demands a working restore, not just an audit log, while
our own spec has only **FR-PLAT-4 at priority C** — "audit history of record changes
(who changed what, when)", with no restore specified. Accepted loss: CNT-11 stays
`cannot_judge`/fail. Rubric and spec text quoted below for the record.

---

## Decision record — the spec text behind D4, D5, D7

Quoting both the **eval rubric** (what we are scored against) and the **KMS product
spec** (`docs/01-requirements.md`, MoSCoW: M = must ship for the Aug 12 submission,
S = should, C = could, W = won't).

### D4 — File versioning + file comments (CNT-04, CNT-05, w=2 each, ~+1.9 pts) — **IN**

*Eval rubric — CNT-04 (`rule`), pass criteria:*
> "After the second slides.pdf upload, a version list shows two entries with
> timestamps, the latest is flagged as current, and the older version remains
> individually viewable/downloadable (a control exists) rather than being overwritten."

*Eval rubric — CNT-05 (`roundtrip`), pass criteria:*
> "The speaker's comment ('Draft deck - final version coming Friday.') appears with
> Priya's name and a timestamp, the organizer sees the same thread on the same file,
> and the organizer's reply is added to it. Do not require email notification of
> comments (SessionBoard itself sends none)."

Both are exercised by scenarios CNT-S2 (speaker uploads v1, comments, re-uploads v2)
and CNT-S3 (organizer sees the same 2-version file and replies on the thread). CNT-13
also wants the files library to show a **version count of 2**, so a files library
built without versioning still scores partial — the two items are coupled.

*KMS product spec:* **neither feature appears.** The closest requirement is
**FR-PORTAL-8 (S)** — "File requests: admin-defined upload asks (title, type,
rich-text instructions); files are stored against the request, downloadable/exportable
by admins." That is single-file storage with no version chain and no comment thread.
There is no FR for file comments anywhere in `docs/01-requirements.md`.

**Reading:** rubric-only scope, but cheaper than it looks — see **F17**: the schema
already appends one `file_request_uploads` row per upload, so the version chain is
latent in the data today.

### D5 — Content change history with restore (CNT-11, w=2, ~+1.0 pts) — **OUT**

*Eval rubric — CNT-11 (`depth`), pass criteria:*
> "The history panel lists at least two distinct timestamped entries attributed to
> Jordan Alvarez, and restoring the earlier version removes the second edit's sentence
> while keeping the first edit."

Note the rubric demands a working **restore**, not just an audit log — a read-only
history panel scores partial at best.

*KMS product spec:* **FR-PLAT-4, priority C (could).** "Audit history of record changes
(who changed what, when)." Attribution and timestamps only — **restore is not in our
spec at all**, and the requirement is the lowest priority tier short of "won't".

**Reading:** the most expensive of the three (touches every editable content entity)
and the weakest spec backing — **cut**.

### D7 — Import (SPK-03, w=2, ~+0.9 pts; CNT-14, w=2, ~+1.0 pts) — **IN, option (ii)**

*Eval rubric — SPK-03 (`bulk`), pass criteria:*
> "An import control accepts the speakers.csv fixture (with or without a column-mapping
> step) and the roster afterward contains the CSV speakers. The fixture CSV repeats the
> two manually added speakers (Priya, Marcus) plus one new person (Dana Kowalski):
> Dana appearing as a new record is the pass signal, and merging or skipping the two
> existing rows by email (dedupe) is acceptable and must not be penalized; duplicate
> rows for Priya/Marcus are also acceptable for this item."

That is a deliberately forgiving bar — no column mapping required, dedupe optional,
one new row is the entire pass signal.

*KMS product spec:* **FR-REV-8, priority S (should)** — "**Import sessions** from
CSV/XLSX; Export .CSV / Export .XLSX; **Download files bundle** (zip of submission
files)", with `docs/06-review-and-scoring.md:171` specifying "CSV/XLSX upload with a
column-mapping step, a dry-run preview…". **Note the mismatch:** our spec calls for
importing **sessions**, the rubric asks for importing **speakers**. Neither is built —
`grep` for `Import Sessions` / `importSessions` across `apps/` and `packages/` returns
nothing.

**Reading:** the spec'd feature (session import, with mapping and dry-run preview) is
strictly bigger than the scored feature (a speakers CSV that adds one row). **Chosen:
option (ii)** — build FR-REV-8's session importer as spec'd and put the speakers
variant on the same machinery, plus FR-REV-8's "Download files bundle (zip)", which is
rubric item **CNT-14** (w=2, currently `cannot_judge`). This satisfies both the rubric
and the spec, and closes a Should-priority requirement. See **F18**.

---

Note also: `specs/07-speaker-crm.yaml` exists in the kit but **no `speaker-crm` area
appears in this report** — that area was not run. Worth confirming that is intentional.

---

## P0 — Unblock the evaluation (fixes ~36 `cannot_judge` items)

These are defects the report observed directly. They gate roughly 20 of the 100
available points that are currently simply undecidable.

### F1. Workspace grids hang forever on "Loading row…"

**Evidence:** CFP-12, SPK-12, CNT-07 — "Workspace Submissions/Speakers grids hang on
'Loading row…' forever (badge counts correct)". CFP-S4 spent its *entire* run blocked
on this.

**Location:** `apps/admin/src/components/DataList.tsx:955-1005`.

**Hypothesis (verify before fixing):** `loadMoreItems` de-dupes concurrent fetches
with `inFlight` keyed on `from:size:filters:sort`. When the query signature changes
while a request is in flight, the reset effect (`:1011`) clears `items` and sets
`needsInitialLoadRef = true`, and the kick-off effect (`:1032`) issues a *fresh*
request whose key is byte-identical to the still-in-flight stale one.
`inFlight.has(key)` short-circuits it (`:969`) with `needsInitialLoadRef` already
flipped false; the original request then hits the stale-signature early return
(`:977`) and discards its result. Net state: `items = []`, `endReached = false`,
`loadError = null`, nothing scheduled — permanent loader rows, which is exactly the
reported symptom.

**Fix:** make the in-flight key signature-scoped (include `querySignature`), and on
the stale-signature early return re-arm `needsInitialLoadRef` instead of dropping the
result silently. Add a regression test that changes filters mid-flight.

**Unblocks:** CFP-12 (w3), CNT-07 (w3), CNT-09 (w2), CNT-10 (w2), CNT-12 (w3),
SPK-01/02/04/05 (w3/3/2/2), SPK-12 (w2), ABS-05/06/08 — **~+9 pts across four areas.**

### F2. "Failed to fetch" on the Review section and on the DevFlow event

**Evidence:** CFP-10 — "the admin 'Review' section itself errored with 'Failed to
fetch'"; CFP-12 — "the DevFlow event shows 'Failed to load items: Failed to fetch'".
`Failed to fetch` is a network-layer `TypeError`, i.e. the worker request died or was
aborted — not a 4xx the UI would have rendered.

**Location:** `apps/api/src/routes/evaluation.ts:466` (`GET /review/queue`) and the
workspace list endpoints in `apps/api/src/routes/adminApi.ts`.

**Action:** reproduce against the deployed worker, check `wrangler tail` for an
unhandled exception, and confirm the deployed build is current. Add an error boundary
so a failing section renders a diagnosable message rather than a bare fetch error.

**Unblocks:** CFP-10 (w2), CFP-11 (w2), and the whole ABS reviewer chain.

### F3. Evaluation section never renders — permanent "Loading…"

**Evidence:** ABS-01 — "the only captured screenshot of it shows an indefinite
'Loading…' state with no content"; ABS-02/03 confirm the view never rendered.

**Location:** `apps/admin/src/evaluation/EvaluationSection.tsx` against
`apps/api/src/routes/evaluation.ts:278` (`GET /evaluation/overview`).

**This is the highest-value single fix in the report.** The backend is substantially
built — plans, criteria CRUD, assignment and the reviewer queue all exist as routes —
yet the entire 20-point Abstract Management area scored 3.5/28 because *nothing
rendered*. ABS-01…ABS-09 are all `cannot_judge` for want of a screen that loads.

**Unblocks:** ABS-01 (w3), ABS-02 (w2), ABS-03 (w3), ABS-04 (w1), ABS-05 (w3),
ABS-06 (w2), ABS-07 (w2), ABS-08 (w2), ABS-09 (w1) — **19 rubric units ≈ +13.6 pts.**

### F4. Workspace task table stuck on "Loading..." in every capture

**Evidence:** SPK-12 — "the workspace task table that would show that
(TASK/ASSIGNEE/STATUS/DUE/COMPLETED columns) was stuck on 'Loading...' in every
capture". Likely the same root cause as F1; verify separately.

**Unblocks:** SPK-05 (w2), SPK-12 (w2), CNT-01 (w3), CNT-07 (w3).

---

## P1 — Missing features, by weight

### F5. Public widget suite — the largest gap in the report (**D1 = a: all five**)

**Evidence:** EMB-01…EMB-13 all `not_found`; EMB-14 `fail`. The agent probed ~15
public routes (`/sessions`, `/program`, `/speakers`, `/agenda`, `/schedule`,
`/gallery`, `/e/{slug}/…`) and every one 404s. Confirmed in source: `apps/public/src`
holds only `hello.client.tsx` and `submit.client.tsx`.

**Good news:** the data layer is already right. `/e/:slug/agenda.json` returns
sessions, rooms, tracks, speaker display names and day keys computed in the event
timezone, PII-redacted, gated on `agenda_published`, with sane cache headers. EMB-16
confirmed the feed matches the organizer record field-for-field. **This is a rendering
job, not a data job.**

Sub-items, each a rubric line:

- EMB-01 (w3) sessions cards: title, truncated description + Show more, date/time,
  room, speaker name/title/company, Format + Track tags
- EMB-02 (w2) keyword search matching titles **and** speaker names, with live count
- EMB-03 (w2) faceted filters — Track at minimum, ideally Format and Location
- EMB-04 (w3) speakers directory, surname-alphabetical, headshot/name/title/company
- EMB-05 (w2) speaker detail with bio + their sessions; directory name search
- EMB-06 (w3) agenda grid: room columns × time gutter, blocks at correct position
- EMB-07 (w2) day navigation re-rendering that day
- EMB-08 (w2) session-block detail: full start–end range, room, description, Format,
  Track, Back control
- EMB-09 (w2) schedule itinerary: day tabs, chronological cards, full speaker list
- EMB-10 (w1) + EMB-11 (w1) personal schedule with star/add, persistence across
  reload, and an export / add-to-calendar affordance
- EMB-12 (w2) speaker gallery photo grid with name search and photo-less fallback
- EMB-13 (w1) gallery card → speaker detail modal with sessions sublist
- EMB-14 (w3) **all five** surfaces reachable logged-out with no auth wall

**Also required:** a speakers feed — `/e/{slug}/speakers` and
`/e/{slug}/speakers.json` both 404 today, so EMB-04/05/12/13 have no data source. And
an `.ics` endpoint (`/e/{slug}/agenda.ics` 404s) for EMB-11.

**Gain:** up to **+17 pts** for the widgets, plus EMB-16 rises from partial to pass
(**+0.9**) once a second public surface exists to compare against.

### F6. Rooms and tracks are not creatable (**D6 = c: create-event dialog, per-event**)

**Evidence:** AIA-02 `not_found` — the agent searched the agenda builder, all view
modes, the Add Session dialog dropdowns, Settings, Forms admin, the new-event dialog
and the REST API docs. A fresh event offers only "No room" / "No track"; the seeded
AI.Engineer event has 6 rooms and 5 tracks. Confirmed in source: `rooms` and `tracks`
are only ever SELECTed.

**Cascade:** AIA-03 is a `fail` *solely* because no room could be selected —
"Placement into a room slot is not achievable for this event". AIA-05 and AIA-06 are
`cannot_judge` for the same reason.

**Fix:** `POST/PATCH/DELETE` for rooms and tracks, event-scoped (they already carry
`event_id` and `position` columns), surfaced as repeatable rooms and tracks fields on
the create-event dialog per **D6**.

**Implementation note on D6:** the create-event dialog covers creation, but AIA-02's
pass criteria require a *newly added* room to "immediately become usable in the agenda
builder", and the scenario adds a room to the already-created DevFlow event. So the
same fields need an editable home post-creation — the natural one is the event-settings
edit form behind the same `PATCH /app/api/events/:id` handler, reusing the dialog's
components rather than building a second editor. Flagging rather than re-asking: this
follows from (c), it is not a new choice.

**Gain:** AIA-02 (w2) + unblocks AIA-03 (w3), AIA-05 (w2), AIA-06 (w2) — **~+5 pts.**

### F7. Uploaded files leave no record

**Evidence:** CNT-02 `partial` — slides.pdf uploaded successfully and the task flipped
to complete, but "no filename, attachment record, or download/view link for slides.pdf
appears anywhere afterwards (Tasks page, Home, Submissions list, submission detail,
submission edit all checked)". CNT-13 `not_found` — no files library anywhere in the
admin nav. SPK-10 `cannot_judge` — no organizer-side file listing with metadata.

**Fix:** persist filename, size, uploader and timestamp against the task/session;
surface a download link on both the speaker task and the organizer record; add a files
view (per-session tab and/or central library).

**Gain:** CNT-02 partial→pass (**+1.0**), CNT-13 (**+0.5**), SPK-10 (**+0.9**), and it
is a precondition for CNT-04, CNT-05 and CNT-14. **D4 is in**, so build this surface
against the version chain from the start — see **F17**, which should be done as one
piece of work with this item rather than after it.

### F8. No embed/share area (**D2 = a: full generator**)

**Evidence:** EMB-15 `fail` — the agent walked every admin nav section; Settings holds
only API tokens, API docs and Reset demo data. The only publish affordance is the
Agenda publish toggle.

**Scope per D2:** an admin Embeds area with a widget-type picker covering all five
surfaces, output-format choices (styled HTML `<script>`, basic HTML, JSON, XML, iCal),
branding/colour options, content filters and field selection, producing a copyable
snippet. The JSON feed exists already; XML and iCal are serialisation over the same
query, and `.ics` is needed for EMB-11 regardless. The manual half of EMB-15 is the
snippet rendering inside a third-party page, so the styled-HTML embed must work
cross-origin.

### F16. Self-signup on the public form (**D3 = a**)

**Evidence:** CFP-05 `partial` — "the portal session was pre-authenticated as a fixed
demo identity (Ada Lovelace, email field disabled/non-editable), so 'a speaker can
create a submitter account from the portal' was never exercised or verified." The most
recent commit on `main` is the demo-login carve-out that introduced this.

**Fix:** let the public CFP wizard's Account step create a real submitter account for
an unrecognised email, rather than binding to the seeded demo identity. Keep the demo
convenience path for the seeded address if you still want it, but it must not be the
only path.

**Gain:** CFP-05 partial→pass (**+1.8 pts**), and it unblocks the SPK-01/SPK-02 roster
evidence that F13 currently dead-ends.

### F17. File versioning + cross-role comments (**D4 = in**)

**Evidence:** CNT-04 `not_found` — "no version list, no 'latest' flag, and no
re-upload/replace control once the task was completed — the upload is a one-shot
'Upload & complete' action". CNT-05 `not_found` — "No comment box or file-level thread
exists anywhere in the speaker portal after upload".

**The schema is already most of the way there.** `file_assets`
(`packages/db/migrations/0001_init.sql:417`) stores `filename`, `content_type`,
`size_bytes`, `uploaded_by_contact_id` and `created_at`; `file_request_uploads` (`:406`)
links request → contact → submission → asset with `uploaded_at`, and
`apps/api/src/routes/portal.ts:1005` **already INSERTs one row per upload**. Multiple
uploads therefore already append rows — the version chain is latent in the data today.
This is why D4 is cheaper than it reads.

**What is actually missing:**

1. **A re-upload path.** The task flips to `complete` on first upload and the control
   disappears, so a second version can never be created. Keep the upload control
   available on a completed file-request task (CNT-S2 step 6 re-uploads a revised
   slides.pdf).
2. **Version identity.** Add a version ordinal and a current-version flag (or derive
   both from `uploaded_at` ordering — but store it, because CNT-13 wants a *version
   count* in the files library and derived counts get expensive there).
3. **A version list UI**, speaker-side and organizer-side, with timestamps, the latest
   clearly marked, and a working download control on the older version — the rubric is
   explicit that the older one must remain "individually viewable/downloadable" rather
   than overwritten. `GET /files/:id` already serves any asset id with per-record
   access checks (`apps/api/src/fileAuth.ts`), so old versions are already
   addressable; note `resolveFileAccess` grants a speaker access via
   `file_request_uploads.contact_id`, which superseded versions still satisfy — verify
   that holds rather than assuming it.
4. **A comments table** on the upload/file, with author and timestamp, readable and
   writable from both the portal and the admin. Rubric explicitly does **not** require
   email notification of comments.

**Also closes:** FR-PORTAL-8's "downloadable/exportable by admins" half, which F7
covers, and CNT-13's version count.

**Gain:** CNT-04 (**+1.0**), CNT-05 (**+1.0**), plus it lifts CNT-13 from partial to
pass alongside F7.

**Sequencing:** build this *with* F7, not after it. F7 must surface the file record
anyway; building that surface against a version chain from the start avoids a
retrofit.

### F18. Import + files bundle, per FR-REV-8 (**D7 = option ii**)

**Evidence:** SPK-03 `cannot_judge` — no import control was ever found (the roster's
CSV/XLSX buttons are exports). CNT-14 `cannot_judge` — "Row checkboxes for multi-select
and CSV/XLSX export buttons are visible… but those are tabular data exports, not a bulk
file/ZIP download". Neither importer exists in the codebase: `grep` for
`Import Sessions` / `importSessions` across `apps/` and `packages/` returns nothing.

**Scope, per FR-REV-8 (S) and `docs/06-review-and-scoring.md:171`:**

1. **Session import** — CSV/XLSX upload, a column-mapping step, and a dry-run preview
   before commit. This is the spec'd feature and the larger half.
2. **Speakers/contacts import on the same machinery** — this is what SPK-03 actually
   scores. The rubric bar is forgiving: the fixture CSV repeats two existing speakers
   plus one new person (Dana Kowalski), and "Dana appearing as a new record is the pass
   signal"; dedupe-by-email is acceptable and "must not be penalized", as are duplicate
   rows. Dedupe by email is the better behaviour anyway and interacts with F13's
   duplicate-contact handling — make the importer's dedupe and the manual add agree.
3. **Download files bundle (ZIP)** — multi-select sessions/files, bundle the *latest*
   file version each (so it depends on F17's current-version flag), with grouping
   options if offered. `fflate` is already a top-level dependency, so ZIP generation
   needs no new package.

**Gain:** SPK-03 (**+0.9**), CNT-14 (**+1.0**), and FR-REV-8 goes from unbuilt to
complete.

---

## P2 — Correctness bugs (small, high confidence, cheap)

### F9. Event day labels are off by one

**Evidence:** AIA-01 — "the day labels are off by one from the configured event dates
(May 11–13 shown vs May 12–14 configured)".

**Root cause (confirmed in source):** `CreateEventDialog.tsx:248,262` submit an
`<input type="date">` value like `2027-05-12`; `isoOrNull`
(`apps/api/src/routes/adminApi.ts:932`) does `new Date("2027-05-12").toISOString()`,
which JS parses as **UTC** midnight → stored `2027-05-12T00:00:00Z`. Rendered back in
a US event timezone that instant is May **11** 17:00, so `eventDays()` (correct in
itself, `apps/admin/src/agenda/timeUtils.ts:53`) yields May 11–13.

**Fix:** interpret bare `YYYY-MM-DD` event dates as local midnight **in the event
timezone** (`localToUtc(day, 0, tz)` server-side), and end dates as end-of-day.
Backfill existing rows. Add a test for a UTC-negative-offset timezone.

**Gain:** AIA-01 partial→pass, **+0.6 pts**, and it removes a confusing artifact from
every future agenda screenshot.

### F10. Conditional-logic fields leak onto the edit-submission page

**Evidence:** CFP-02 — "the edit-submission page renders these workshop-only fields
regardless of format… a separate defect". Show-when logic is honoured on the create
wizard but not on the edit view.

### F11. Unused numeric fields render the literal string `"null"`

**Evidence:** CFP-06 — "unused numeric fields render the literal string 'null'".
Cosmetic, but it appears on the organizer submission detail, a screenshot-heavy
surface.

### F12. Duplicate/inconsistent Track display on submission detail

**Evidence:** CFP-06 — "the earlier observed duplicate/inconsistent Track display".

### F13. Duplicate-email validation blocks the manual add-speaker flow

**Evidence:** SPK-02 — the create returned "A contact with this email already exists
for this event", so no saved record displaying the entered values was ever shown. The
message is correct behaviour, but the form offers no recovery path (no "open the
existing contact" affordance). Pairs with **F16** (D3 = a).

### F14. Submission edit exposes only Title / Description / Format

**Evidence:** ABS-11 — "submission edit exposes only Title/Description/Format", so
co-participants cannot be added retroactively. The same item notes the participant
Role dropdown offers only the single value `speaker`, with no co-author /
co-presenter role — add the role vocabulary.

**Gain:** ABS-11 partial→pass, **+0.7 pts.**

### F15. Speaker records have no custom / logistics fields

**Evidence:** SPK-15 `not_found` (w=1) — the field set is First/Last/Email/Company/Job
title/Mobile/Pronouns/Biography/Internal notes; Settings has no custom-field
configuration. A travel-preferences or generic custom-field capability would close it.

---

## P3 — Features present but never demonstrated

Each of these exists in the UI but was never exercised, mostly downstream of P0. After
P0 lands, confirm each is genuinely functional; where it is not, it becomes a fix.

- **CFP-04 / CFP-16 (w2 each) — submission-window enforcement.** The close date was
  never moved into the past; no logged-out closed-portal state and no post-close edit
  lock were observed. The dashboard does label a form "closed · closes Jul 31, 2026",
  so the concept exists. **Verify server-side that a closed form rejects both new
  submissions and edits** — a UI-only close is a real defect.
- **CFP-14 (w2) — decision notification emails.** UI traces exist ("Not notified"
  badge, "1 decision is staged but the speakers haven't been told yet", a Notifications
  step in the form builder) but nothing was ever dispatched and no send confirmation or
  log was seen. `POST /submissions/send-decisions` exists at `evaluation.ts:153`. Note
  the known deploy caveat: the SendGrid key is still missing.
- **CFP-15 (w2) — accepted submission → agenda handoff.** Never observed.
- **AIA-07 (w2) — agenda publish.** The Publish button and DRAFT badge are visible but
  were never clicked; blocked in practice because F5 means there is no public surface
  for the handoff to land on. This item cannot pass until F5 ships.
- **AIA-04 (w3) — speaker double-booking warning.** A Conflicts tab exists with a live
  badge and `computeConflicts` is wired in `agenda.ts:145`. Needs D6 (rooms) before it
  can be triggered as the scenario specifies.
- **AIA-08 (w1) — auto-schedule assist.** Not visible in the toolbar; not explicitly
  ruled out either. Decide whether to build any auto-place action.
- **ABS-13 (w2) — review export.** CSV/XLSX buttons are present on the submissions
  grid but were never clicked. Verify the download actually initiates and includes
  scores.
- **ABS-10 (w3) — score sort.** Ascending sort demonstrated; the descending toggle and
  the aggregate arithmetic are unverified.
- **SPK-06 (w2) portal invitation, SPK-13 (w2) bulk email, SPK-14 (w1) merge-field
  templates, CNT-08 (w2) bulk reminders.** A Messages tab with non-zero counts exists;
  the compose flow was never opened. Verify recipient selection, send confirmation and
  a history entry.
- **SPK-04 (w2) — speaker workflow status.** "Confirmed 3 / Awaiting confirmation 2" on
  the dashboard implies the field exists; no control, persistence or filter was seen.
- **CNT-12 (w3) — content approval gate.** The grid's status dropdown is the
  *acceptance* decision, not a content-approval state. Confirm whether a separate
  content-approval status exists; if not this is a build item, and it gates the public
  agenda output.
- **CNT-14 (w2) — bulk file/ZIP download.** Now a build item under **F18**, not a
  verification item. Depends on F7 and F17.
- **CNT-11 (w2) — content change history with restore. Deliberately out of scope**
  this round per **D5**; expect it to stay unearned.
- **ABS-14 (w1) — AI-assisted triage.** Never explored, never ruled out. Decide whether
  the app claims this at all.

---

## Not a code fix — evaluation-harness notes

- **Turn exhaustion is the top cause of `cannot_judge`** — **D8 = yes, adjust before
  the next run.** ABS lost all three scenarios to the 70-turn limit; CNT lost both
  organizer scenarios; CFP-S1 and CFP-S4 both ended at the limit. Some of that is app
  friction (P0 will help), but not all of it. Raise the cap and/or split the longest
  scenarios (CFP-S1, CFP-S4, ABS-S2, CNT-S3) in `evalconfig.json`.
- **CFP-03 (w3) failed on a technicality worth fixing in the scenario:** the public
  portal genuinely showed event name, deadline banner, tracks and formats — but the
  browser was authenticated as `ada@example.com` throughout, so *logged-out
  reachability was never demonstrated*. A scenario that forces a clean anonymous
  context would likely convert this to a pass (**+1.8 pts**) with no code change.
- **CNT-03 (w3) similarly:** the agent probed `/admin`, `/organizer`, `/dashboard/…`,
  `/workspace/…`, `/events/…` for admin-route blocking and got 404s — but **the real
  organizer surface is `/app`**, which it never probed. The 404s therefore prove
  nothing. Either fix the scenario or make the app's admin route obvious.
- Consider whether `specs/07-speaker-crm.yaml` should be in the run set (see above).

---

## Suggested order

1. **P0 (F1–F4)** — nothing else can be measured until the grids and the Evaluation
   section load. Expected coverage jump is large; expected score jump ~+15–20 pts if
   the underlying features work as the routes suggest.
2. **Targeted re-run** per **D9**: `02-abstract-management` + `04-content-management`,
   with the turn budget already adjusted per **D8**, to convert `cannot_judge` into
   real verdicts and find out what is actually broken behind the loading screens.
3. **F5 (all five public widgets, D1=a)** and **F6 (rooms/tracks, D6=c)** — the two
   biggest genuine feature gaps, ~+22 pts combined.
4. **F8 (embed generator, D2=a)** and **F16 (self-signup, D3=a)** — F8 depends on F5
   existing first; F16 is small and can slot in earlier if convenient.
5. **F7 + F17 as one piece of work** (file record, version chain, comments — D4=in),
   then **F18** (session + speakers import and the files bundle — D7=option ii), which
   depends on F17's current-version flag for the ZIP. ~+4.9 pts combined, and it closes
   FR-PORTAL-8 and FR-REV-8.
6. **P2 correctness bugs** — cheap, and several are visible in every screenshot.
7. **P3 verification sweep** and a **full re-run**. CNT-11 stays unearned by choice
   (D5 = out).
