# workplan-1.md — parallelised implementation plan for sub-agents

**Sources:** `tests/evals/fixes1.md` (remediation plan from eval report1, decisions D1–D9
resolved) and `tests/manual-review-2.md` (manual QA notes, 2026-08). This plan merges
both into dependency-ordered waves. Items within a wave run as **parallel sub-agents**;
waves are sequential barriers only where a real dependency exists.

**Model key**
- `opus` — complex debugging, layout/timezone math, multi-surface features
- `sonnet` — standard feature implementation and well-scoped bug fixes
- `haiku` — trivial cosmetic fixes with an exact known location

**Isolation:** every parallel agent that edits files runs with `isolation: worktree`.
Lanes below are partitioned so no two agents in the same wave own the same file, but
worktrees make collisions harmless either way. Orchestrator merges each wave before the
next starts.

**Manual-review-2 mapping:** MR2-1 Event tab in Workspace → W2-E. MR2-2 dashboard
bubble → Workspace filter jitter → W2-E. MR2-3 detail-form scrollbar placement → W4-H.
MR2-4 speaker headshot image on contact detail → W2-E. MR2-5 uploaded file visible on
Tasks tab → folded into W2-C (same surface as F7). MR2-6 slides shown on submission
detail with /files/ links → folded into W2-C.

---

## Wave 1 — P0: unblock the evaluation (3 agents, parallel)

Nothing else is measurable until these land (~36 `cannot_judge` items gated here).

### W1-A · F1 + F4 — DataList permanent "Loading row…" deadlock — `opus`
- File: `apps/admin/src/components/DataList.tsx:955-1032`.
- Verify then fix the hypothesised race: in-flight de-dupe key collides with the
  post-reset re-fetch when the query signature changes mid-flight; the stale request's
  early return drops the result with `needsInitialLoadRef` already false.
- Fix: signature-scope the in-flight key; on stale-signature return, re-arm
  `needsInitialLoadRef`. Regression test: change filters mid-flight.
- Also verify F4 (workspace task table stuck on "Loading...") is the same root cause;
  if not, fix separately in the same lane.
- Unblocks: CFP-12, CNT-07/09/10/12, SPK-01/02/04/05/12, ABS-05/06/08 (~+9 pts).

### W1-B · F2 — "Failed to fetch" on Review section + DevFlow event — `sonnet`
- Files: `apps/api/src/routes/evaluation.ts:466` (`GET /review/queue`),
  `apps/api/src/routes/adminApi.ts` workspace list endpoints.
- Reproduce against the deployed worker (`kms.r-s.workers.dev`), `wrangler tail` for
  unhandled exceptions, confirm the deployed build is current. Add an admin error
  boundary so failing sections render a diagnosable message.
- Unblocks: CFP-10/11 + the ABS reviewer chain.

### W1-C · F3 — Evaluation section never renders — `opus`
- Files: `apps/admin/src/evaluation/EvaluationSection.tsx` vs
  `apps/api/src/routes/evaluation.ts:278` (`GET /evaluation/overview`).
- Highest-value single fix in the report: backend routes exist; the screen never
  loads. Diagnose (frontend fetch/render vs endpoint error) and fix end-to-end.
- Unblocks: ABS-01…ABS-09 — 19 rubric units ≈ +13.6 pts.

**Wave-1 exit gate:** all three admin surfaces load with live data in a browser smoke
test. Then trigger the targeted eval re-run (D9: `02-abstract-management` +
`04-content-management`) *after* the harness turn budget is adjusted (D8 — human task,
`C:\dev\killmysaas-evals\evalconfig.json`, not a sub-agent job).

---

## Wave 2 — feature lanes (parallel; W2-D has an internal sequence)

### W2-A · F6 — rooms & tracks creatable, per-event (D6=c) — `sonnet`
- API: `POST/PATCH/DELETE` for rooms and tracks (they already carry `event_id` +
  `position`), wired into `PATCH /app/api/events/:id`.
- UI: repeatable rooms/tracks fields on the create-event dialog **and** the same
  components on the event-settings edit form (AIA-02 requires adding a room to an
  existing event and it becoming immediately usable in the agenda builder).
- Gain: AIA-02 + unblocks AIA-03/05/06 (~+5 pts).

### W2-B · F16 — real self-signup on the public CFP wizard (D3=a) — `sonnet`
- Let the Account step create a real submitter account for an unrecognised email
  instead of binding to the seeded Ada Lovelace demo identity. Keep the demo path for
  the seeded address, but it must not be the only path.
- Gain: CFP-05 partial→pass (+1.8) and unblocks SPK-01/02 roster evidence.

### W2-C · F7 + F17 + MR2-5/6 — file records, version chain, comments — `opus`
One agent, one piece of work (fixes1 sequencing note: build the surface against the
version chain from the start).
1. Persist/surface file metadata (filename, size, uploader, timestamp) — the schema
   already appends one `file_request_uploads` row per upload
   (`apps/api/src/routes/portal.ts:1005`, `packages/db/migrations/0001_init.sql:406,417`).
2. Re-upload path on completed file-request tasks (versions are impossible today).
3. Stored version ordinal + current-version flag (CNT-13 needs a cheap version count;
   F18's ZIP needs the current flag).
4. Version list UI speaker-side and organizer-side; older versions individually
   downloadable via existing `GET /files/:id`; verify `resolveFileAccess` still grants
   the speaker access to superseded versions rather than assuming it.
5. Comments table on the upload/file, author + timestamp, readable/writable from both
   portal and admin. No email notification required.
6. **MR2-5:** list the uploaded file on the admin Tasks tab for completed file_upload
   tasks (link `file_request_uploads.file_asset_id`, currently invisible to organisers).
7. **MR2-6:** show submission-scoped uploads (slides) on the submission detail with
   `/files/` download links.
8. Files view: per-session tab and/or central library with version counts (CNT-13).
- Gain: CNT-02→pass, CNT-04, CNT-05, CNT-13, SPK-10 (~+4.4 pts) + closes FR-PORTAL-8.

### W2-D · F5 — public widget suite (D1=a: all five) — internal sequence
**W2-D1 first (blocking within this lane only), then D2–D5 in parallel.**

- **W2-D1 — data feeds + public shell scaffold — `sonnet`**
  - `/e/:slug/speakers.json` (PII-redacted, mirroring the agenda feed's conventions in
    `apps/api/src/routes/landing.ts:215`), `/e/:slug/agenda.ics`, and the shared public
    page shell/routing under `apps/public/src` (only the CFP wizard exists today).
- **W2-D2 — sessions list widget — `sonnet`** — EMB-01/02/03: cards (title, truncated
  description + Show more, date/time, room, speaker name/title/company, Format/Track
  tags), keyword search over titles **and** speaker names with live count, faceted
  filters (Track minimum, ideally Format and Location).
- **W2-D3 — speakers directory, detail, gallery — `sonnet`** — EMB-04/05/12/13:
  surname-alphabetical directory with headshot/name/title/company, detail with bio +
  their sessions, name search, photo-grid gallery with photo-less fallback, card →
  detail modal with sessions sublist.
- **W2-D4 — agenda grid — `opus`** — EMB-06/07/08: room columns × time gutter with
  blocks at correct positions, day navigation re-rendering that day, session-block
  detail (full start–end range, room, description, Format, Track, Back control).
  Layout math is the hard part.
- **W2-D5 — schedule itinerary + personal schedule — `sonnet`** — EMB-09/10/11: day
  tabs, chronological cards, full speaker lists; star/add persisting across reload
  (localStorage is fine); export / add-to-calendar using the `.ics` from W2-D1.
- All five surfaces must be reachable **logged out** with no auth wall (EMB-14, w3).
- Gain: up to +17 pts, plus EMB-16 partial→pass (+0.9).

### W2-E · Workspace fixes from manual-review-2 — `sonnet`
- **MR2-1:** add an Event tab to the Workspace — list events, add-event entry point
  (reuse the create-event dialog; W2-A edits that dialog and this lane only consumes
  it, but if timing collides, land W2-A first).
- **MR2-2:** dashboard bubbles link to Workspace but the screen jitters ~2s and the
  filter never applies — diagnose (likely interacts with the W1-A race; start this
  lane after Wave 1 merges) and make the linked filter actually apply.
- **MR2-4:** show the speaker's headshot image on the contact detail (admin currently
  shows only bio/headshot ticks, never the image); serve via
  `/files/<headshot_asset_id>`.

---

## Wave 3 — dependents of Wave 2 (2 agents, parallel)

### W3-A · F8 — embed/share generator (D2=a, depends on F5) — `opus`
- Admin Embeds area: widget-type picker over all five surfaces; output formats
  (styled-HTML `<script>` embed, basic HTML, JSON, XML, iCal); branding/colour options;
  content filters and field selection; copyable snippet. The styled-HTML embed must
  work cross-origin (the manual half of EMB-15 renders it in a third-party page).
- Gain: EMB-15 (~+1.2 pts).

### W3-B · F18 — import + files bundle, per FR-REV-8 (D7=ii, depends on W2-C) — `opus`
1. Session import: CSV/XLSX upload, column-mapping step, dry-run preview before commit
   (`docs/06-review-and-scoring.md:171`).
2. Speakers/contacts import on the same machinery; dedupe by email, agreeing with the
   manual-add duplicate handling from W4-E (F13).
3. Download-files-bundle ZIP: multi-select, latest version of each file (uses W2-C's
   current-version flag); `fflate` is already a top-level dependency.
- Gain: SPK-03 (+0.9), CNT-14 (+1.0), FR-REV-8 goes from unbuilt to complete.

---

## Wave 4 — P2 correctness/cosmetic batch (parallel small agents)

| Lane | Item | Model | Notes |
|---|---|---|---|
| W4-A | F9 event-day off-by-one | `sonnet` | `isoOrNull` (`adminApi.ts:932`) parses bare dates as UTC midnight; store as event-timezone local midnight (`localToUtc`), end dates end-of-day, backfill existing rows, test a UTC-negative offset. +0.6 pts. |
| W4-B | F10 conditional fields leak onto edit-submission page | `sonnet` | Honour show-when logic on edit as on create. |
| W4-C | F11 literal `"null"` in unused numeric fields | `haiku` | Organizer submission detail. |
| W4-D | F12 duplicate/inconsistent Track display | `haiku` | Same surface as W4-C — may merge lanes. |
| W4-E | F13 duplicate-email dead end on add-speaker | `sonnet` | Keep the validation; add an "open the existing contact" recovery affordance. Coordinate dedupe semantics with W3-B. |
| W4-F | F14 submission edit exposes only Title/Description/Format | `sonnet` | Expose the full field set incl. co-participants; add co-author/co-presenter to the Role vocabulary. +0.7 pts. |
| W4-G | F15 custom/logistics fields on speaker records | `sonnet` | w=1 — lowest priority in this wave; a travel-preferences or generic custom-field capability. |
| W4-H | MR2-3 detail-form scrollbar sits mid-working-area | `haiku` | CSS: make the scroll container the full working area so the bar hugs its right edge. |

---

## Wave 5 — verification sweep + full re-run

1. **Browser smoke (browser-pilot / browser-testing)** of every Wave 1–4 deliverable,
   including the MR2 items, against the deployed worker.
2. **P3 verification agents** (parallel, `sonnet`, verify-first — becomes a fix only
   where broken): CFP-04/16 server-side submission-window enforcement; CFP-14 decision
   emails (SendGrid key still missing on deploy — flag, don't fix); CFP-15
   accepted→agenda handoff; AIA-04 double-booking warning (needs W2-A); AIA-07 agenda
   publish (needs W2-D); AIA-08 auto-schedule (decide whether to build); ABS-10 score
   sort; ABS-13 review export; SPK-04 workflow status; SPK-06/13/14 + CNT-08 messaging
   flows; CNT-12 content-approval gate (build item if absent — it gates the public
   agenda).
3. **Full eval re-run.** Expected: CNT-11 stays unearned by choice (D5=out); ABS-14
   remains undecided unless the user opts in.

---

## Out of scope / human tasks

- **D5 — content change history with restore: OUT** this round (accepted loss, CNT-11).
- **D8 — eval-harness turn budget**: user edits `killmysaas-evals\evalconfig.json`
  (raise the cap, split CFP-S1 / CFP-S4 / ABS-S2 / CNT-S3).
- **Scenario fixes, not code**: CFP-03 needs a clean anonymous browser context; CNT-03
  should probe `/app`; confirm whether `specs/07-speaker-crm.yaml` belongs in the run
  set.
- **Deploy caveat**: SendGrid key missing on the deployed worker — CFP-14 cannot pass
  until it is set.

## Dependency graph (summary)

```
Wave 1 (F1+F4 | F2 | F3)  ──►  targeted re-run (D9, after D8)
Wave 2:  F6 | F16 | F7+F17+MR2-5/6 | F5 (D1 ► D2–D5) | MR2-1/2/4
   F5 ──► F8 (W3-A)          F7+F17 ──► F18 (W3-B)
Wave 4: independent bug lanes (F13 ◄─ coordinate ─► F18 dedupe)
Wave 5: browser smoke + P3 verify + full re-run
```
