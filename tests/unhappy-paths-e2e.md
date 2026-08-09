# Unhappy Paths — End-to-End Browser Test Plan (browser-pilot)

Phase **U** of [`tests/e2e-high-level.md`](e2e-high-level.md) §4. Written in the shape of
[`docs/14-e2e-browser-test.md`](../docs/14-e2e-browser-test.md): milestone sections, one numbered
step per row, one natural-language `do` per step, one assertion per `do`.

This plan covers the **error cases** — expired and reused magic links, the per-user submission
limit, submitting after the close date, validation on every required field type, a conditional
rule hiding a required field, rejected and oversize uploads, the `expected_updated_at` → 409
concurrent-edit conflict, scheduling outside the event dates, room capacity, the reviewer
conflict-of-interest skip, permission denials across all four roles, and duplicate-send
idempotency.

> Load this file as the brief before the first `do`:
> `browser-pilot brief tests/unhappy-paths-e2e.md`

**Refusal to fail is itself a failure.** Every step below expects the app to *reject* something.
A step that "worked" when it should have been blocked is a defect, not a pass.

---

## S0 — Environment & smoke (always run first)

Preconditions, run in the shell — not through the agent — exactly as
[docs/14 §S0](../docs/14-e2e-browser-test.md):

```sh
npm run migrate:local
npm run seed:local
npm run build
npm run dev                        # wrangler dev → http://localhost:8787
```

`.dev.vars` must contain `DEV_MODE=on`. Base URL for local runs: `http://localhost:8787`.

```sh
browser-pilot brief tests/unhappy-paths-e2e.md
browser-pilot note "run id is <RUNID>; use it as a prefix for every record this run creates"
browser-pilot open http://localhost:8787/health
```

**Fixtures — reused verbatim from [docs/14 §S0](../docs/14-e2e-browser-test.md), none invented:**

| Thing | Value |
|---|---|
| Event slug | `ai-engineer-sandbox-event` |
| CFP form (the judged one) | `form0000-0000-4000-8000-000000000001` — *Call for Speakers 2026*, open, limit 3/user |
| Limit-1 form | *Session Submission Form #2* — `form0000-0000-4000-8000-000000000002`, limit 1/user, no close date |
| Closed form | *Lightning Talks* — `form0000-0000-4000-8000-000000000003` |
| Admin login | `james@atelyr.com` |
| Reviewer login | `rosalind.franklin@example.com` |
| Speaker logins | `ada@example.com`, `grace.hopper@example.com` |
| Event window | Oct 12 06:00 → Oct 14 15:00 event-local (America/Los_Angeles) |

| # | Step | Expect |
|---|---|---|
| S0.1 | `open http://localhost:8787/health` | 200, JSON `ok` |
| S0.2 | `do "using fetch_source, request /app/api/me with no session cookie and report the HTTP status and error code"` | 401 `unauthenticated` — **NFR-4** |
| S0.3 | `do "log in as an admin: go to /app, enter james@atelyr.com, pick the AI.Engineer Sandbox Event, then follow the DEV_MODE sign-in link. Confirm you land on the admin shell"` | Admin shell — **FR-PLAT-1** |

**Gate:** if S0.3 fails, stop — most of this plan is authenticated.

**Run hygiene:** prefix every record with `<RUNID>`. This plan mutates the *Session Submission
Form #2* close date and one agenda slot; both are restored by an explicit step, and a clean
baseline is one `npm run seed:local` away.

---

## M1 — Public submission: validation, limits and closed forms

*Covers FR-FORM-9/13/14, FR-SUB-4/9/10. Spec: [04](../docs/04-cfp-and-forms.md).*

| # | Step | Expect |
|---|---|---|
| M1.1 | `do "on the Call for Speakers 2026 form, sign in as <RUNID>-val@example.com via the DEV_MODE link, then on the Submission step press Next with every field empty and report each inline validation message shown"` | `Title is required`, `Description is required`, `Format is required`, `Tags is required`, `Track is required` — **FR-SUB-4** (gate) |
| M1.2 | `do "fill Title with a 300-character string, leave the other required fields filled, press Next and report the validation message and the state of the character counter"` | `Title exceeds 255 characters`, counter shown in its over state — **FR-SUB-4** |
| M1.3 | `do "set Format to Workshop and confirm 'Room Setup Requirements' appears marked required; then change Format to Talk and confirm it disappears from the step"` | Conditional show/hide — **FR-FORM-9** |
| M1.4 | `do "with Format still Talk (so the required 'Room Setup Requirements' question is hidden), fill the remaining required fields with '<RUNID> Hidden Required Test' and continue to Review; confirm the step advances and Room Setup Requirements is absent from the read-only summary"` | A hidden required question never blocks submission and is not stored — **FR-FORM-9** |
| M1.5 | `do "on the Participant step of that submission, clear the First Name field and press Next; report the message shown"` | `Every participant needs a first name, last name and email.` — **FR-SUB-5** |
| M1.6 | `do "restore the participant name, submit, and confirm the success page shows a submission code"` | Baseline for the limit checks below — **FR-SUB-8** |
| M1.7 | `do "open /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000002, sign in as <RUNID>-limit@example.com via the DEV_MODE link, complete the three required questions with the title '<RUNID> Limit Probe' and submit"` | First submission on a limit-1 form succeeds |
| M1.8 | `do "reopen /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000002 while still signed in as <RUNID>-limit@example.com and report exactly what the Account step says and whether a Next button is offered"` | `You have reached the limit of 1 submissions for this form.`, no Next — **FR-SUB-10** |
| M1.9 | `do "as an admin, open Session Submission Form #2 in the builder, set the Close Date on Form Settings to a datetime in 2026-08-01, press Save and confirm the header shows a Saved marker"` | Close date accepted — **FR-FORM-13** |
| M1.10 | `do "open /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000002 in a public context and report the notice shown instead of the wizard"` | `This form is closed — submissions ended …` with a portal link — **FR-SUB-9**, **FR-FORM-13** |
| M1.11 | `do "as an admin, clear the Close Date on Session Submission Form #2 and save, then confirm the public URL shows the wizard again"` | Restores the fixture for later phases |
| M1.12 | `do "open the Lightning Talks form at /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000003 while signed out and confirm the closed notice renders rather than a sign-in prompt"` | Closed beats unauthenticated — **FR-SUB-9** |

> **Note:** FR-SUB-10 says the limit is enforced "at step 3"; the implementation blocks earlier,
> on the Account step, once the signed-in submitter is known. M1.8 asserts the behaviour that
> exists rather than the spec's wording — treat a mismatch here as a TEST-PLAN observation, not a
> defect, unless nothing blocks at all.

---

## M2 — Auth, uploads and record isolation

*Covers FR-PORTAL-5/6, FR-SUB-12, NFR-4, NFR-5. Spec: [05](../docs/05-speaker-portal.md).*

| # | Step | Expect |
|---|---|---|
| M2.1 | `do "request a portal sign-in link for <RUNID>-reuse@example.com at /portal/ai-engineer-sandbox-event, copy the DEV_MODE link, use it once to sign in, then log out and open the exact same link again; report the page heading and HTTP status"` | `This link has expired` · 410 — single-use, **NFR-4** (gate) |
| M2.2 | `do "open /auth/callback?t=not-a-real-token and report the page heading and HTTP status"` | `This link has expired` · 410 — unknown/expired token — **NFR-4** |
| M2.3 | `do "log into the portal as ada@example.com via the DEV_MODE link, open Profile, clear the Last Name field, save and report the error flash"` | `First and last name are required.` — **FR-PORTAL-5** |
| M2.4 | `do "on the portal Profile as ada@example.com, set the LinkedIn URL to 'linkedin.com/in/ada' with no scheme, save and report the error flash"` | `Links must start with http:// or https://` — **FR-PORTAL-5** |
| M2.5 | `do "on the portal Profile as ada@example.com, attempt to upload a plain-text .txt file as the Headshot and report the error flash"` | `File type text/plain is not accepted.` — **FR-SUB-12** |
| M2.6 | `do "on the portal Profile as ada@example.com, attempt to upload a locally generated image larger than 5 MB as the Headshot and report the error flash"` | `File is too large (max 5 MB).` — **FR-SUB-12** |
| M2.7 | `do "on the portal Tasks page as ada@example.com, submit the Speaker Agreement acknowledge task without ticking the confirmation checkbox and report what happens"` | Blocked — the checkbox is `required`, and the server answers `Please tick the confirmation first.` — **FR-PORTAL-6** |
| M2.8 | `do "on the portal Tasks page as ada@example.com, press 'Upload & complete' on the Presentation Upload task with no file chosen and report what happens"` | Blocked — `Choose a file to upload.` — **FR-PORTAL-6** |
| M2.9 | `do "on the portal Tasks page as ada@example.com, upload a plain-text .txt file to the Presentation Upload task and report the error flash"` | `File type text/plain is not accepted.` — **FR-SUB-12** |
| M2.10 | `do "log into the portal as grace.hopper@example.com, then open ada@example.com's submission SESS-4 by its portal URL and report what happens"` | Not shown — redirected back to the submissions list — **NFR-5** |
| M2.11 | `do "while signed in as grace.hopper@example.com, open /app and report the page heading and HTTP status"` | 403 `Admin access required` — **NFR-4**, **FR-PLAT-1** |
| M2.12 | `do "open /portal/ai-engineer-sandbox-event in a signed-out context and confirm the sign-in card renders rather than portal content"` | 401 login page — **FR-PORTAL-1** |

> **Note:** the *Presentation Slides* file request declares `allowed_types` of PDF and PPTX, but
> the portal's file-upload handler validates against the generic document allow-list (PDF, PPT,
> PPTX, DOC, DOCX, ZIP, JPEG, PNG) and never reads `file_requests.allowed_types` or `max_size_mb`.
> M2.9 therefore uses `.txt`, which both lists reject. A per-request type restriction is specified
> (FR-PORTAL-8) but I could not locate its enforcement.

> **Note:** M2.6 needs a >5 MB image on disk; generate it in the shell before the step rather than
> asking the agent to produce one.

---

## M3 — Review, decisions and role gates

*Covers FR-REV-2/7/10/13, FR-PLAT-1, NFR-11. Spec: [06](../docs/06-review-and-scoring.md).*

| # | Step | Expect |
|---|---|---|
| M3.1 | `do "log in as rosalind.franklin@example.com and report every sidebar item available in the shell"` | Review only — no Dashboard, Workspace, Forms, Evaluation, Agenda or Settings — **FR-PLAT-1** (gate) |
| M3.2 | `do "while signed in as rosalind.franklin@example.com, use fetch_source on /app/api/forms and report the HTTP status and error code"` | 403 `forbidden` — the reviewer surface is `/app/api/review/*` only — **FR-PLAT-1** |
| M3.3 | `do "while signed in as rosalind.franklin@example.com, use fetch_source on /api/v1/events and report the HTTP status and error code"` | 401 `unauthenticated` — only owner/admin sessions pass the REST gate — **FR-PLAT-5** |
| M3.4 | `do "as rosalind.franklin@example.com, open an unreviewed assignment, score only one criterion and confirm both Save buttons stay disabled — report the hint text shown"` | `Score every criterion to save.` — **FR-REV-10** |
| M3.5 | `do "as rosalind.franklin@example.com, on that same assignment tick 'Flag conflict of interest (skips scoring)' and confirm the score buttons become disabled and Save becomes available"` | Conflict flag bypasses scoring — **FR-REV-10** |
| M3.6 | `do "save the conflict-of-interest flag and report the saved note plus the assignment's status chip in the queue"` | `Saved — flagged as conflict of interest.`, status `skipped` — **FR-REV-10** |
| M3.7 | `do "back as an admin, open that submission's detail tab and confirm the conflicted review is listed as 'Conflict of interest' rather than contributing a numeric score"` | Skipped review excluded from the mean — **FR-REV-11** |
| M3.8 | `do "as an admin, select two Pending submissions in the Submissions tab and press 'Send decision emails' without first moving them into a queue; report exactly what the bulk bar says"` | `0 accepted, 0 declined, 0 tasks assigned, 2 skipped (not in a queue)` — decisions only fire from a queue state — **FR-REV-2** |
| M3.9 | `do "select the seeded accept_queue submission SESS-3 plus one already-accepted submission, press 'Send decision emails' and report the counts"` | The already-accepted row is skipped, not re-notified — **FR-REV-13** |
| M3.10 | `do "press 'Send decision emails' a second time on SESS-3 alone and confirm the count reports it as skipped rather than sending again"` | Idempotent decision send — **NFR-11** |
| M3.11 | `do "open the workspace Messages tab filtered to SESS-3's speaker and confirm exactly one decision_accepted message exists for that submission"` | One decision email per submission, ever — **NFR-11**, **FR-COMM-8** |
| M3.12 | `do "on the workspace Submissions tab select the Decline Queue status chip so nothing matches, and report the empty state text"` | `No records match the current filters.` — empty state, not a crash |

---

## M4 — Scheduling constraints and invite idempotency

*Covers FR-AGENDA-3/4/5, FR-COMM-6, NFR-11. Spec: [07](../docs/07-agenda-and-scheduling.md).*

| # | Step | Expect |
|---|---|---|
| M4.1 | `do "open the Agenda, focus SESS-14 in the unscheduled tray, press M to open the Move dialog, set Date to Oct 14 and Start to 16:00 for 30 minutes in Main Stage, save, then open the Conflicts view and report the conflict raised against it"` | `OUTSIDE_EVENT_WINDOW` · error — the event ends at 15:00 event-local on Oct 14 — **FR-AGENDA-4** |
| M4.2 | `do "still in the Conflicts view, confirm the SESS-14 block is visually flagged in the Day view for Oct 14 as well as listed in Conflicts"` | Blocks are flagged, not just listed — **FR-AGENDA-5** |
| M4.3 | `do "use the Move dialog to put SESS-14 back on Main Stage on Oct 12 at 10:00 for 30 minutes and confirm the OUTSIDE_EVENT_WINDOW conflict disappears"` | Restores the fixture |
| M4.4 | `do "drag SESS-14 onto Main Stage on Oct 12 at 10:00 where a session already sits, and report the conflict code shown on the drop preview before you release"` | `ROOM_DOUBLE_BOOKED` shown as a red-ghost preview — **FR-AGENDA-4** |
| M4.5 | `do "in the Move dialog for SESS-14, type 0 into Duration (min) and report the value the field settles on"` | Clamped to 5 — no zero-length or negative session — **FR-AGENDA-3** |
| M4.6 | `do "open a Pending (not accepted) submission's row in the workspace Submissions tab and confirm it does not appear anywhere in the Agenda's unscheduled tray"` | Only accepted submissions are schedulable — **FR-AGENDA-2** |
| M4.7 | `do "press 'Send confirmations' on the Agenda and report how many invites were queued for how many sessions"` | Baseline count — **FR-COMM-6** |
| M4.8 | `do "press 'Send confirmations' again immediately and report the state of the button and any count shown"` | Disabled / zero pending — nothing re-sent — **NFR-11** |
| M4.9 | `do "move an already-invited session to a different room, choose 'Skip the email' on the prompt, and confirm the move still applies without queueing a schedule_changed message"` | Declining the notification still applies the change — **FR-COMM-6** |
| M4.10 | `do "report the capacity of the Lounge room as shown in the Move dialog's room list, and state whether any control anywhere in the agenda lets you set a session's expected capacity"` | Documents the ROOM_CAPACITY_EXCEEDED gap — **FR-AGENDA-4(d)** |

> **Note:** the `ROOM_CAPACITY_EXCEEDED` rule exists and is correct in `packages/core/src/agenda.ts`,
> but it can never fire from the browser: every seeded session has `capacity` NULL and there is no
> capacity input in the Move dialog, the Add Session dialog, the submission detail tab or anywhere
> else in the SPA. M4.10 is written as a reporting step so the missing editor is recorded rather
> than silently dropped. FR-AGENDA-6 lists capacity as an editable session field.

---

## M5 — Dashboard reminders and duplicate sends

*Covers FR-DASH-6/12, NFR-11. Spec: [09](../docs/09-dashboard-and-reporting.md).*

| # | Step | Expect |
|---|---|---|
| M5.1 | `do "open the Speaker Tracking dashboard and press 'Remind all' on the Overdue tasks card; report the note shown"` | `N reminders sent.` — **FR-DASH-6** |
| M5.2 | `do "press 'Remind all' a second time straight away and report the note shown"` | `Already reminded today — N skipped.` — **NFR-11** |
| M5.3 | `do "press 'Send reminder' on a single overdue row that was just reminded and confirm the note reports it as already reminded rather than sending again"` | Per-assignment, per-day idempotency — **NFR-11** |
| M5.4 | `do "open the workspace Messages tab and confirm the number of task_reminder messages created today matches the number reported as sent, not sent plus skipped"` | Skips leave no message_log row — **FR-COMM-8** |
| M5.5 | `do "on the Speaker Tracking dashboard, report what the Overdue tasks card shows when nothing is overdue — if the seeded overdue tasks are still present, report the card's row count instead and say so"` | Empty state `Nothing is overdue.` or the row count — empty-state handling |

---

## M6 — Concurrency, permissions and API errors

*Covers FR-PLAT-5, NFR-4, NFR-5. Spec: [10](../docs/10-api.md).*

| # | Step | Expect |
|---|---|---|
| M6.1 | `do "open the Call for Speakers 2026 form in the builder, change its Internal Form Name to '<RUNID> Conflict Probe' but do not save yet; in a second browser tab use the Forms list to Close the same form; return to the first tab and press Save — report the error banner shown"` | `This record changed in another session — reload to pick up the latest version before saving again.` (HTTP 409 `conflict` from `expected_updated_at`) — **NFR-4** (gate) |
| M6.2 | `do "reload the builder for the Call for Speakers 2026 form, confirm the Internal Form Name is back to its stored value, then Reopen the form from the Forms list so its status is Open again"` | Nothing was silently clobbered; fixture restored |
| M6.3 | `do "in the builder for the Call for Speakers 2026 form, open Edit on the Title question, clear the Label field and report the state of the Save button"` | Disabled — a question cannot lose its label — **FR-FORM-7** |
| M6.4 | `do "in the workspace Speakers tab, create a contact using the existing email ada@example.com and report the error message shown"` | `A contact with this email already exists for this event.` (409 `email_exists`) — **FR-REV-5** |
| M6.5 | `do "in the workspace Speakers tab, create a contact with the email field left empty and report the error message shown"` | `An email address is required.` (400 `email_required`) — **FR-REV-5** |
| M6.6 | `do "using fetch_source, call /api/v1/events with the header 'Authorization: Bearer kms_deadbeefdeadbeef' and report the HTTP status and error code"` | 401 `invalid_token` — **FR-PLAT-5** |
| M6.7 | `do "using fetch_source, call /api/v1/events with no Authorization header and no session cookie, and report the HTTP status and the message text"` | 401 `unauthenticated` naming Settings → API tokens — **FR-PLAT-5** |
| M6.8 | `do "as an admin, use fetch_source on /api/v1/events/00000000-0000-4000-8000-000000000000/submissions and report the HTTP status and error code"` | 404 `event_not_found` — **NFR-5** |
| M6.9 | `do "as an admin, use fetch_source on /api/v1/events/<event id>/widgets and report the HTTP status, error code and the list of available resources in the message"` | 404 `unknown_resource` listing contacts, submissions, tasks, messages — **FR-PLAT-5** |
| M6.10 | `do "as an admin, POST to /api/v1/events/<event id>/submissions/<SESS-4 id>/status with {\"status\":\"banana\"} and report the HTTP status and error code"` | 422 `invalid_status` listing the seven valid statuses — **FR-PLAT-5** |
| M6.11 | `do "as an admin, use fetch_source on /api/v1/events/<event id>/submissions?status=banana and report whether the unknown filter value errors or is ignored"` | Ignored, never an error — the documented `unknown_filters` convention — **FR-PLAT-5** |
| M6.12 | `do "as an admin, use fetch_source on /app/api/meta and confirm it documents the forms_update 409 conflict convention verbatim"` | `PUT /app/api/forms/:id accepts expected_updated_at; a stale value yields 409 …` — self-description matches M6.1 |

---

## Reporting

At the end of a run, produce a table of *stage · step · pass/fail/blocked/N-A · what was
observed*, then list failures with the exact `browser-pilot` report text. Distinguish:

- **Fail** — the expectation was contradicted (a real defect). For this plan that most often
  means *the app allowed something it should have refused*.
- **Blocked** — the step could not be attempted (missing seed data, upstream step failed, the
  agent could not find the control). Blocked is not pass.
- **N/A** — the feature belongs to a milestone above the requested ceiling.

**Never report a stage as passing when a step within it was blocked.** If the run was requested
"up to Mn", state explicitly which stages were skipped as N/A.

### Operating notes

- One assertion per `do`. Two unrelated artifacts in one instruction is the documented stall
  case — split it.
- Use `open` / `peek` / `screenshot` for navigation and spot-checks; they cost no agent tokens.
- Screenshot on every failure before moving on: `browser-pilot screenshot`.
- Anything about server-rendered output (the portal and CFP are SSR) must say `fetch_source` in
  the instruction, so an SSR bug is distinguished from a hydration bug. Every raw HTTP status
  assertion in this plan needs `fetch_source` — a rendered error page and a 200 with error text
  are not the same result.
- Bump `--max-turns` for the drag step (M4.4) if it runs out of turns; **don't split a drag**
  across two instructions. M4.4 asserts the *preview* — the drop may be released and undone.
- M6.1 needs two browser tabs on the same profile; keep both open for M6.2.
- Steps M1.9/M1.11, M4.1/M4.3 and M6.1/M6.2 are mutate-then-restore pairs. If the first half of a
  pair fails, still attempt the restore before moving on, and say so in the report.
