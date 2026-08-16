# Workplan 18 — Defects from the 2026-08-15 eval run

Source: `C:\dev\killmysaas-evals\runs\2026-08-15T20-51-45-EM4oz8` (full 18-scenario run against
production `https://kms.r-s.workers.dev/`, 20:51–22:17 UTC).

**Headline: overall 95.3%, coverage 99%, 16 manual items still unfilled.**

| Area | Score | Non-pass items |
|---|---|---|
| ai-agenda | 100% | — |
| public-widgets | 100% | — |
| content-management | 98.4% | CNT-13 (partial/high) |
| call-for-papers | 94.6% | CFP-17, CFP-18 (both partial/medium — turn-limit artifacts) |
| abstract-management | 91.1% | ABS-09, ABS-13 (turn-limit), ABS-14 (not_found) |
| speaker-management | 89.1% | SPK-02 (turn-limit), SPK-04, **SPK-15 (fail/high)** |

Six scenarios ended `agent_error` at the 100-turn cap (ABS-S1/S2/S3, CFP-S1, SPK-S1, SPK-S3),
which is where five of the eight non-passes come from. Those are **unverified, not broken** —
see §3. Only three findings are genuine product defects, plus four smaller ones the agents
logged as observations without them costing score.

---

## 1. Real defects — fix these

### D1 (P0) — Speaker edit in org scope silently discards Status and custom fields

*SPK-15 fail/high, SPK-04 partial. Evidence: `SPK-S3/screenshots/031,032,033`.*

The agent created a custom `Travel & Logistics` speaker field in Settings, filled it on Priya
Raman's edit form together with Status=Confirmed, saved (200, form closed), and on reload the
detail showed `Travel & Logistics —`, `Status —`, `Event —`. Repeating the edit lost it again.
Status had been "Confirmed" before the edit session, so this is **data loss on an unrelated
save**, not just a failed write.

Root cause is a read/write scope mismatch, not the write path:

- `apps/api/src/routes/adminApi.ts:1002` — the contacts resource's **org-scope** `selectSql`
  returns `NULL AS event_id`, `NULL AS custom_fields_json` and **no `speaker_status` column at
  all**, while `m.company / m.job_title / m.biography / m.notes` *are* coalesced from the
  most-recent membership (`baseFrom`, :986). So company and job title survive the round trip
  and status/custom fields can never render — exactly the asymmetry the screenshots show
  (Company "Latticework Systems" present, Status/Travel "—").
- `apps/admin/src/App.tsx:1072` (`buildSpeakerFormSchema`) renders the Status select and the
  `cf__*` inputs regardless of scope, so the organiser is offered event-scoped controls on an
  org-scoped record.
- `PUT /contacts/:id` (`adminApi.ts:1759`) falls back to `session.eventId` when the body carries
  no `event_id` — which an org row never does. The write probably lands on *an* event; the
  re-read then shows the org row, which shows neither field.

Fix (recommended): make the org-scope read symmetric with the write.

1. Add `m.speaker_status` and a membership-scoped `custom_fields_json` (subselect keyed on
   `m.event_id`, same shape as `contactWithCustomFields`, `adminApi.ts:4619`) to the org-scope
   select, and expose `m.event_id` as e.g. `profile_event_id` so the client knows which
   membership it is reading.
2. In `PUT /contacts/:id`, when the body has no `event_id`, target that same
   most-recent-membership event rather than `session.eventId`, guarded by the existing
   `requireEventAccess`/`isWriter` check.
3. Label it in the UI: the detail panel should say which event the status/custom values belong
   to instead of rendering `Event —` next to values that are event-owned.

Also check, and fix if confirmed: the Speakers tab was showing an **org-scope** record while the
header read `Event: DevFlow Conf 2027` (screenshot 033 shows "Delete from organisation" and
`Events 2`). Under a selected event, the Speakers grid should default to that event's scope; if
org scope is deliberate there, it must at minimum not present event-only fields as if they were
the record's own.

Regression tests: PUT-then-GET round trip for `speaker_status` + one custom field, once in event
scope and once in org scope; assert nothing else on the record changed.

### D2 (P1) — Uploaded files are never associated with a session

*CNT-13 partial/high. Evidence: `CNT-S3/screenshots/046,049`.*

The Files library lists `slides.pdf` (uploader Priya Raman, VERSIONS 2) with an empty **SESSION**
column, and the per-submission Files tab on "Taming 40-Minute CI" says *"No files uploaded for
this submission"*. Speaker association and version counting are correct; session association is
missing on both surfaces.

`apps/api/src/routes/filesAdmin.ts:65` (`LIBRARY_SELECT`) already has a fallback: it resolves the
session via any `task_assignments` row for the same `(contact_id, file_request_id)` that carries
a non-null `submission_id`. That fallback misses when the upload task was targeted at the
*contact* rather than a submission — which is how the portal's "Upload Session Presentation"
task is seeded, so the column is empty for the normal path.

Fix:

1. Stamp `file_request_uploads.submission_id` at upload time when the assignee has exactly one
   accepted/scheduled session in the event (portal upload handler, `portal.ts`).
2. Give the organiser an explicit **link to session** control on the file row for the ambiguous
   cases (0 or >1 candidate sessions), so association is never a dead end.
3. Make the per-submission Files tab query use the same resolution the library uses — today the
   two surfaces disagree, which is what made this read as "the file is lost".

### D3 (P1) — Scheduling + publishing a session does not put it on the public agenda

*AIA-S2 observation ("BUG FOUND"); scenario still scored 100%, so this costs nothing today but
is a real product trap.*

After auto-placing, confirming and publishing SESS-5, the public agenda kept showing "2 sessions"
while the organiser-side agenda showed it scheduled and published with 0 conflicts. The session
only appeared after (a) ticking a separate **"Visible in public agenda"** checkbox buried in
*Edit submission*, which was **unchecked by default** despite status=Accepted and a scheduled
slot, and (b) a full **Unpublish → Publish** cycle — re-saving was not enough.

Two distinct bugs:

- **Default**: an accepted, scheduled session should be publicly visible by default, or the
  agenda UI must show a "scheduled but hidden" badge with a one-click fix. A hidden-by-default
  flag on another screen is not discoverable.
- **Cache**: publish did not regenerate the public feed when the visibility flag changed —
  only unpublish+publish did. Find the revision/cache-bump path for the visibility flag
  (`bumpEventRevision`) and make the flag change bump it.

Per `CLAUDE.md`, whichever way the default lands, update the help files for the publish flow.

---

## 2. Smaller findings from agent observations

| # | Finding | Where | Action |
|---|---|---|---|
| D4 (P2) | Portal profile nags *"Your bio or headshot is missing"* although a bio was entered in the submission's Participant step — the per-submission participant bio and the persistent profile bio are separate fields with no bridge (CFP-S2) | `portal.ts` profile completeness | Seed the profile bio from the participant bio on submit, or make the completeness check accept it; the nag must link to the exact field it wants |
| D5 (P2) | Reviewer cannot reach the reviewer portal by password (fixture creds rejected) and signup demands an email confirmation with no on-screen link; the only working route is the organiser-side "Send sign-in link", which reveals a 15-min URL (ABS-S3) | `auth.ts`, reviewer invite flow | Confirm whether seeded reviewers get a password at all. Keep the reveal-link control (it works well), but a reviewer who was invited must be able to sign in unaided |
| D6 (P3) | Seed bug: Marcus Okafor's "Confirm participation" task references SESS-2 (Priya's talk) instead of his own SESS-5 (CNT-S1) | `packages/db/seed/seed.sql` | Fix the seed reference |
| D7 (P3) | Seed carries only two task types (Confirm participation, Complete bio and profile); scenarios expect a document-style task such as "Sign speaker release form" (SPK-S3) | `packages/db/seed/seed.sql` | Add one document/release task to the seed so the demo shows the full task vocabulary |

**Not a defect — no action.** EMB-S1 flagged the marker `SBEK-PORTAL-BIO-01` in Priya's public
bio as leaked test data. That string was written by the eval agent itself in an earlier scenario
(SPK-S1's sentinel); the daily `DEMO_RESET` clears it. Confirm on a fresh reset, then close.

---

## 3. Turn-limit partials — verify, do not fix blind

These five scored partial purely because the run ended before the confirming click. Each judge
comment says the control exists and is correctly targeted; nothing is known to be broken. Verify
each locally and only open work if verification fails.

| Item | What went unverified | Verification |
|---|---|---|
| ABS-09 | "Remind" / "Remind all lagging" never clicked — no toast, sent status or log entry in evidence | Click both; assert a comms-log entry lands |
| ABS-13 | ↓CSV / ↓XLSX on Workspace › Reviews and on Submissions results never triggered | Trigger both; assert filename + row content |
| CFP-17 | Second fixture event "Forward Summit 2028" never created (the agent did create "DevFlow Conf 2027", so the capability is shown) | Covered — no app work |
| CFP-18 | No screenshot of a second event's submissions list once both events held data | Capture the direct contrast; per-event counts already differ correctly (0/0/0 vs 13/6/5) |
| SPK-02 | Manual **add**-speaker form never exercised (Priya/Marcus were pre-seeded, so the agent edited instead) | Create a speaker through the roster's Add form; assert it persists — worth real coverage since D1 lives in this form |

Reducing turn burn is the durable fix, and D5 is part of it: the reviewer sign-in detour cost
ABS-S3 a large share of its budget. On the evals side, consider raising the cap or splitting the
ABS and SPK scenarios.

## 4. Open product question — ABS-14

*not_found/low.* No surface anywhere claims AI-assisted review triage: the round editor exposes
only human criteria, weights and reviewer pools, and the submission Reviews block lists human
reviews with no AI/human distinction. Per the rubric this is *not applicable* absent an AI
claim, so it is not a bug — it is a decision:

- **Build**: a minimal AI triage pass that scores/summarises a submission with a visible
  rationale, clearly labelled as AI, human-overridable, and distinguished from human reviews in
  the Reviews block.
- **Or don't**: leave it out and accept the item stays not-applicable.

Recommendation: build it — the product already advertises an agent-facing API and an AI agenda
builder, so review triage is the conspicuous gap, and the rubric rewards the distinction being
explicit.

## 5. Manual checklist

`manual-results.json` is a blank template — all 16 items (ABS-07/09/13/14, CFP-08/14,
CNT-08/14, EMB-11/15/16, SPK-06/07/10/13/16) still read `"pass | partial | fail | not_found"`,
so `manualPending: 16`. Fill it before quoting 95.3% as final; several of these are the same
features §3 wants verified, so do both in one pass.

---

## 6. Execution

**Wave 1 (parallel, disjoint surfaces)**

| Agent | Items | Primary surface |
|---|---|---|
| contacts-scope | D1 | `apps/api/src/routes/adminApi.ts` (contacts resource + PUT), `apps/admin/src/App.tsx` (sole owner this wave) |
| files-session | D2 | `apps/api/src/routes/filesAdmin.ts`, `portal.ts`, submission Files tab |
| agenda-visibility | D3 | `apps/api/src/routes/agenda.ts`, `public.tsx`, agenda admin UI + help docs |
| portal-seed | D4, D6, D7 | `portal.ts` profile completeness, `packages/db/seed/seed.sql` |

**Wave 2 (inline)**

1. D5 (reviewer sign-in) — needs a look at how seeded reviewers get credentials before scoping.
2. §3 verification sweep + fill `manual-results.json`.
3. ABS-14 decision (§4); if "build", it becomes workplan 19, not this one.

**Wave 3 (inline)**

1. Full typecheck + `vitest` from the repo root.
2. Update help files for every user-visible change (D1 scope labelling, D2 link-to-session,
   D3 publish flow) — required by `CLAUDE.md`.
3. Commit; if any migration is added, run `migrate:remote` **before** deploying.
4. Re-run SPK-S3, CNT-S3 and AIA-S2 against production — publish the event first, and mind the
   09:00 UTC `DEMO_RESET`.

## Outcome

Built 2026-08-16. Typecheck clean; `vitest` green apart from the known midnight-window
GreenRoom flake (the test places sessions relative to the real clock, so a run just after
local midnight puts "up next" on the following day).

### D1 — root cause was not the write path

The diagnosis in §1 was wrong about the mechanism, and right that org scope is asymmetric.
Nothing was ever discarded: the save landed. What broke was the **read after a reload**.

`App.tsx`'s `?rec=` effect resolved the record on mount, and `filter` reads `'all'` until
`/api/me` returns (it cannot validate `route.ev` against the accessible set before then) — so a
deep link naming an event resolved the speaker through the **org** query, which selects
`NULL AS event_name / custom_fields_json` and no `speaker_status` at all. That is exactly the
screenshot: Company and Job title present (coalesced from the membership), Event/Status/Travel
"—". `handledRec` was already stamped, so the corrected re-run bailed out and the panel never
healed. The eval agent then re-edited from that empty form and read the same emptiness back.

Fixed on both sides:

- `App.tsx` — the effect waits for `me` before resolving, so the scope the URL asks for is the
  scope the record is read in. Regression test in `App.filesOpenDetails.test.tsx`.
- `adminApi.ts` — the org spec now reads `speaker_status` and a membership-scoped
  `custom_fields_json` from the same membership `m` the profile columns come from, and exposes
  `profile_event_id` / `profile_event_name`. `PUT /contacts/:id` with no `event_id` falls back to
  that same membership instead of 404-ing when the session's event has none.
- `App.tsx` detail panel — org mode captions the profile block with **Profile from &lt;event&gt;**,
  shows the status, and renders the custom-field keys the row actually carries; org edits address
  `profile_event_id`, so the event you read is the event you write. `getEditAccess` no longer
  requires switching the sidebar to that event first.
- Round-trip test (event scope + org scope, asserting nothing else moved) in `contact-fields.test.ts`.

The Speakers-tab scope question in §1 is answered by the same root cause: the grid was in event
mode throughout; only the deep-linked detail row came from the org query.

### D2 — built as specified

`filesAdmin.ts` grew one shared `RESOLVED_SUBMISSION_ID` used by the library select, the count
query and the `submission_id` filter — so the library and the per-submission Files tab can no
longer disagree — with a third resolution step: the uploader's single accepted session in the
file's own event, guarded by `HAVING COUNT(*) = 1`. `portal.ts` stamps the same answer at upload
time (`soleAcceptedSessionId`). For the ambiguous cases there is now
`PUT /app/api/files/uploads/:id/submission` (moves the whole version chain) and a **Link to
session** control on the file detail panel. Eight tests in `files-session-link.test.ts`.

### D3 — one real bug, one wrong diagnosis

- The **default** is not the problem: `content_approved` defaults to 1 (migration 0010), and
  nothing in the product sets it to 0 except the organiser's own switch. SESS-5 was held back by
  an earlier scenario in the same shared production data. What was missing was any way to *see*
  that: the agenda board never carried the flag. It does now — a **Hidden** badge on the block
  (one click makes it public), a count in the header summary, and a publish-time warning
  alongside the existing unplaced/conflict guards.
- The **cache** half was real but not a revision bug — every write path already bumps the event
  revision, and the public URLs are not keyed on it. The public pages served
  `s-maxage=60, stale-while-revalidate=300`, i.e. up to six minutes of stale content after a
  publish. Now 60s + 60s, and the publish toast says the public page takes a minute or two.
- Help updated: a new "Publishing and the public page" section in `docs/manual/agenda.md`.

### D4 — the bridge already existed; the wording did not

The participant-step bio does land on the profile (`participants.ts` merges it into
`event_contacts.biography`, covered by an existing test). The nag said "your bio **or** headshot is
missing" whichever was actually absent, so a speaker who had just written a bio read it as their
words having been lost. It now names the missing field and links to that control.

### D5 — narrowed

The reviewer sign-in machinery is sound and deliberate: invited reviewers have no password
(nobody sets one), signup is magic-link-activated by design, and `signin-link` mints a per-reviewer
link precisely because the demo has no mail path. The gap was the door's own copy — "Admin sign
in" over a password box, with no hint that an invitee's route is the link. Reworded.

### D6 / D7 — not repo defects

Both are eval-run data, not the seed. `packages/db/seed/seed.sql` contains neither Marcus Okafor
nor Priya Raman (and does carry a document-style task, "Speaker Agreement"); those records were
created by agents in earlier scenarios against shared production data — CNT-S1's own second
observation says as much ("leftover seed/test data from earlier scenario runs"). The mis-linked
task was created through the Tasks form, which requires the submission to be picked explicitly,
so there is nothing to fix on our side. No change made.

### Still open

- §3's verification sweep and `manual-results.json` (16 items) — not run; both need a live
  instance and the eval harness.
- ABS-14 (§4) — still a decision, not started; workplan 19 if it goes ahead.
- No migration was added, so `migrate:remote` is not required before the next deploy.
- The three production re-runs (SPK-S3, CNT-S3, AIA-S2) are still to do.
