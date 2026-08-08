# 14 — End-to-End Browser Test Plan (browser-pilot)

The executable form of the acceptance criteria in [01 §11](01-requirements.md) and the demo
script in [12 §3](12-build-plan.md). It is written for the `browser-pilot` CLI: every step is
one natural-language instruction scoped to a single verifiable outcome.

**How to ask for a run:** *"run docs/14 up to M4"*, *"run M5 including speed"*, *"run the S0
smoke and M1"*. Stages are cumulative and ordered — running "up to Mn" means S0 then M1…Mn.
Stage **P (Speed)** and stage **X (Cross-cutting)** are independent and can be appended to any
run; a bare *"including speed"* means append stage P.

> This file doubles as the browser-pilot **brief**. Load it into the session before the first
> `do` so the agent knows the app's URLs, logins and idioms:
> `browser-pilot brief docs/14-e2e-browser-test.md`

---

## S0 — Environment & smoke (always run first)

Preconditions, run in the shell — not through the agent:

```sh
npm run migrate:local
npm run seed:local
npm run dev                        # wrangler dev → http://localhost:8787
```

`.dev.vars` must contain `DEV_MODE=on`. This is what makes the whole plan runnable without an
inbox: `/auth/request` renders the sign-in link **on the page** (and returns `dev_link` in the
JSON response) instead of only emailing it. Every "log in" step below depends on it.

Base URL for local runs: `http://localhost:8787`. For a deployed run, substitute the deploy
origin everywhere and expect the DEV_MODE link steps to be replaced by real inbox checks.

```sh
browser-pilot brief docs/14-e2e-browser-test.md
browser-pilot note "run id is <RUNID>; use it as a prefix for every record this run creates"
browser-pilot open http://localhost:8787/health
```

| # | Step | Expect |
|---|---|---|
| S0.1 | `open http://localhost:8787/health` | 200, JSON ok |
| S0.2 | `do "confirm the seeded event 'AI.Engineer Sandbox Event – NYC' is reachable: open /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000001 and report the page heading and any deadline text"` | Welcome screen, "Speak at NYC", close date Sept 15 2026 |
| S0.3 | `do "log in as an admin: go to /app, enter james@atelyr.com, then follow the DEV_MODE sign-in link shown on the page. Confirm you land on the admin shell and report which sidebar items are present"` | Dashboard · Workspace · Forms · Evaluation · Agenda · Settings |

**Gate:** if S0.3 fails, stop — everything downstream is authenticated.

### Fixtures this plan relies on

| Thing | Value |
|---|---|
| Event slug | `ai-engineer-sandbox-event` |
| CFP form (the judged one) | `form0000-0000-4000-8000-000000000001` — *Call for Speakers 2026*, open, limit 3/user |
| Closed form | *Lightning Talks* — for the closed-state check |
| Admin login | `james@atelyr.com` |
| Speaker with a rich footprint | `ada@example.com` (multiple submissions, tasks, messages — the anchor demo) |
| Deliberate double-booking | Grace Hopper, Oct 12, seeded so Conflicts is non-empty on arrival |
| Unscheduled accepted session | SESS-14 — the tray + dashboard nudge |

**Run hygiene:** prefix every record you create with the run id from `note` so repeat runs stay
distinguishable, and treat the seed as read-mostly — the destructive steps below (bulk accept,
schedule moves) are all reversible from the UI, but a clean baseline is one `npm run seed:local`
away.

---

## M1 — Forms & public submission

*Covers FR-FORM-9/10/13/14/15/17, FR-SUB-1…11. Spec: [04](04-cfp-and-forms.md).*

| # | Step | Expect |
|---|---|---|
| M1.1 | `do "on the public CFP welcome screen for the Call for Speakers 2026 form, confirm the deadline banner and the per-user submission limit are both visible, and report their exact text"` | Deadline + "3 submissions per user" |
| M1.2 | `do "start a submission: enter <RUNID>-speaker@example.com at the Account step and follow the DEV_MODE link back into the form. Confirm you return to the wizard authenticated"` | Round-trips to the Submission step |
| M1.3 | `do "fill the submission step with title '<RUNID> Agents in Production' and a description, then set Format to Workshop. Confirm the conditional questions (room setup / prerequisites) appear only after Workshop is chosen"` | **FR-FORM-9** — conditionals reveal live |
| M1.4 | `do "add a second participant in the Speaker role with a distinct name and email, then continue to the Review step"` | **FR-SUB-5** — min/max respected |
| M1.5 | `do "on the Review step confirm every answer is shown read-only with per-section Edit links, then submit"` | **FR-SUB-6** |
| M1.6 | `do "confirm the success page shows the customised message, then wait and confirm the browser auto-redirects to the speaker portal"` | **FR-FORM-15**, the "make sure this works" path |
| M1.7 | `do "open the Lightning Talks form's public URL and confirm it shows a closed-form notice rather than the wizard"` | **FR-SUB-9** |
| M1.8 | `do "in the admin workspace Submissions tab, find the submission titled '<RUNID> Agents in Production' and report its status, its evaluation plan and any tags"` | Pending, routed to the *Workshops* plan, routing tag applied — **FR-FORM-10** |

**Gate:** M1.3 and M1.8 are the never-cut items (conditional logic, routing). A failure here
fails the milestone regardless of the rest.

---

## M2 — Portal & communications

*Covers FR-PORTAL-1…6, FR-COMM-1/3/4. Spec: [05](05-speaker-portal.md), [08](08-communications.md).*

| # | Step | Expect |
|---|---|---|
| M2.1 | `do "log into the speaker portal at /portal/ai-engineer-sandbox-event as <RUNID>-speaker@example.com using the DEV_MODE link, and report the four nav items and the sections on Home"` | Home · Submissions · Profile · Tasks; My Submissions, My Profile, Tasks panel |
| M2.2 | `do "on the portal Home, confirm the submission created in M1 appears as a card with its code, title and a status chip, and report the chip text"` | Pending |
| M2.3 | `do "edit the portal profile: set the biography to '<RUNID> bio text' and save. Reload and confirm it persisted"` | **FR-PORTAL-5**, the "update your own bio data" annotation |
| M2.4 | `do "upload a headshot on the portal profile and confirm the image renders after save"` | File seam (KV) round-trips |
| M2.5 | `do "as an admin, anchor the speaker Ada in the workspace Speakers tab (shift-click the row) and report how the Submissions, Tasks and Messages tab counts change"` | **The anchor moment** — all three narrow to Ada's records |
| M2.6 | `do "with Ada still anchored, open the Messages tab and confirm at least one logged email is listed with its template and status"` | **FR-COMM-8** — message log |
| M2.7 | `do "confirm the M1 submission generated a submission_confirmation email: find it in the Messages tab for <RUNID>-speaker@example.com and report its status"` | Sent/queued — **FR-FORM-17**, "must have" |
| M2.8 | `do "open the portal on a 375px-wide viewport and confirm Home, Profile and Tasks are all usable without horizontal scrolling"` | **NFR-7** |

---

## M3 — Review, scoring & decisions

*Covers FR-REV-1/2/4/9/10/11/13. Spec: [06](06-review-and-scoring.md).*

| # | Step | Expect |
|---|---|---|
| M3.1 | `do "in the workspace Submissions tab, click through the status filter chips and confirm the tab count tracks the active chip. Report the count for Pending and for Accepted"` | **FR-REV-1** as chips (the documented deviation from status tabs) |
| M3.2 | `do "log in as a reviewer and confirm you get the review-only shell — report which navigation is available compared with the admin shell"` | Reviewer role gate, **FR-PLAT-1** |
| M3.3 | `do "in the reviewer workspace, open an assigned submission, score every criterion and save. Report the scores you entered"` | **FR-REV-10** |
| M3.4 | `do "back in the admin Submissions tab, find that submission and report its rating value; confirm sorting by rating reorders the list"` | **FR-REV-11** — weighted mean, sortable |
| M3.5 | `do "select two pending submissions with the row checkboxes and use the bulk action bar to move them to the Accept Queue. Confirm both statuses changed"` | **FR-REV-7** |
| M3.6 | `do "send decision emails for those two rows and confirm the Notified flag flips on each"` | **FR-REV-13** |
| M3.7 | `do "trigger the decision send a second time on the same rows and confirm nothing is re-sent — report what the UI says"` | **NFR-11** — mailer idempotency |
| M3.8 | `do "confirm acceptance auto-assigned a task: anchor one of the newly accepted speakers and report the rows in the Tasks tab"` | *Presentation Upload* present |

---

## M4 — Agenda, conflicts & calendar invites

*Covers FR-AGENDA-1…6, FR-COMM-6. Spec: [07](07-agenda-and-scheduling.md).*

| # | Step | Expect |
|---|---|---|
| M4.1 | `do "open the Agenda and report the available views"` | List · Day · Week · Month · Rooms · Conflicts |
| M4.2 | `do "confirm the unscheduled tray contains SESS-14 and report every session in the tray"` | **FR-AGENDA-2** |
| M4.3 | `do "drag SESS-14 from the tray onto Main Stage at 10:00 on Oct 12 and confirm the block renders in that slot"` | **FR-AGENDA-3** |
| M4.4 | `do "reload the agenda and confirm SESS-14 is still scheduled at Main Stage 10:00"` | Persisted, not optimistic-only |
| M4.5 | `do "drag a second session onto the same Main Stage 10:00 slot and confirm both blocks are flagged as conflicting; report the conflict code shown"` | `ROOM_DOUBLE_BOOKED` — **FR-AGENDA-4** |
| M4.6 | `do "open the Conflicts view and report every listed conflict with its severity and the records involved"` | Includes the seeded Grace double-booking — **FR-AGENDA-5** |
| M4.7 | `do "resolve the room conflict you created by moving one session to a different room, and confirm the Conflicts count drops"` | Resolve path |
| M4.8 | `do "resize a scheduled block by dragging its bottom edge and confirm the duration changes and snaps to 5 minutes"` | **FR-AGENDA-3** |
| M4.9 | `do "focus a session block, press M to open the Move dialog, move it to another room and time, and confirm it moved"` | **NFR-6** — keyboard alternative to drag |
| M4.10 | `do "press Ctrl+Z and confirm the last scheduling change is undone"` | **FR-AGENDA-8** |
| M4.11 | `do "use Send confirmations and report how many schedule_confirmed messages were queued"` | One per speaker per session |
| M4.12 | `do "move an already-invited session, accept the 'notify speakers?' prompt, then find the resulting schedule_changed message in the Messages tab and report its status"` | **FR-COMM-6** — the `SEQUENCE:1` update path |

> **Out of browser scope:** whether the `.ics` renders as a *native* invite in Gmail / Outlook /
> Apple Calendar is a mail-client check, not a DOM check — it was proven by the M0 spike
> (`spikes/`) and is re-verified manually before submission. The browser plan verifies the
> message was generated, addressed and logged.

---

## M5 — Dashboard

*Covers FR-DASH-3/6/7/12. Spec: [09](09-dashboard-and-reporting.md).*

| # | Step | Expect |
|---|---|---|
| M5.1 | `do "open the Dashboard and report the greeting, the days-to-event countdown and every KPI tile with its value"` | **FR-DASH-1/2** |
| M5.2 | `do "report the submission status tiles and their counts"` | Accepted · Pending · Declined · Drafts · Withdrawn — **FR-DASH-3** |
| M5.3 | `do "report every nudge in the 'Also check' strip"` | Includes the unscheduled-accepted-session nudge — **FR-DASH-4** |
| M5.4 | `do "open the Speaker Tracking dashboard and report the outstanding-tasks total and the Top speakers by outstanding tasks list"` | **FR-DASH-6**, the brief's requirement #6 |
| M5.5 | `do "report the missing-assets nudge — how many accepted speakers are missing a bio or headshot, broken down"` | **FR-DASH-7** |
| M5.6 | `do "note the Outstanding Speaker Tasks count, then report it again"` — then complete a task in the portal (M5.7) before re-reading | Baseline for the live-move check |
| M5.7 | `do "in the speaker portal, complete an outstanding task by uploading a PDF, and confirm the task status changes to Complete"` | **FR-PORTAL-6** |
| M5.8 | `do "return to the Speaker Tracking dashboard, wait for it to refresh without a manual reload, and report whether the Outstanding Speaker Tasks count dropped from the value noted in M5.6"` | **FR-DASH-12** — the milestone's exit criterion |
| M5.9 | `do "send a reminder from an overdue speaker's row and confirm the message appears in that speaker's Messages tab"` | Overdue list action |

---

## M6 — API, exports & polish

*Covers FR-PLAT-5, FR-DASH-13. Spec: [10](10-api.md).*

| # | Step | Expect |
|---|---|---|
| M6.1 | `open http://localhost:8787/docs` then `do "confirm the API docs page renders an operation list and report the submissions endpoints"` | OpenAPI + `/docs` |
| M6.2 | `do "using fetch_source, retrieve /app/api/meta and report the resources it lists"` | Discovery endpoint — raw response, not live DOM |
| M6.3 | `do "export the Submissions tab to CSV and confirm the download completes"` | **FR-DASH-13** |
| M6.4 | `do "confirm no window.alert or window.confirm dialogs appear during a delete from the workspace — report what confirmation UI is used"` | Polish item |
| M6.5 | `do "open the deployed landing page and confirm the demo admin login, demo speaker login and the reset-demo-data button are all present"` | **FR-PLAT-7** — judges must never ask how to get in |

---

## P — Speed (append to any run: *"including speed"*)

*Covers NFR-1. Budgets: [03 §6](03-architecture.md).*

Run against the **built** app (`npm run build && wrangler dev`), never a hot-reloading dev
bundle, and on the deployed origin for the numbers that count.

| # | Step | Expect |
|---|---|---|
| P.1 | `do "open the public CFP welcome page, report the Navigation Timing values for TTFB and for the Largest Contentful Paint entry"` | TTFB < 200 ms · LCP < 1.5 s |
| P.2 | `do "open the speaker portal home and report TTFB and LCP the same way"` | Same budget |
| P.3 | `do "in the admin workspace, switch between the Speakers and Submissions tabs and report how long the row list takes to render after each click"` | < 100 ms perceived |
| P.4 | `do "apply a status filter chip on the Submissions tab and report the time from click to updated row count"` | < 100 ms perceived |
| P.5 | `do "report the transfer size and count of JavaScript resources on the public CFP page"` | The wizard island stays ~14 KB gzip |
| P.6 | Lighthouse on the public CFP page — run outside browser-pilot | Score recorded for the submission checklist |

Report every number as measured, with the origin and build mode named. A budget miss is a
finding, not a failure to hide — [00 §4](00-overview.md) ranks speed as a judged bonus.

---

## X — Cross-cutting checks (append on request)

| # | Step | Covers |
|---|---|---|
| X.1 | `do "confirm the CFP wizard is fully operable by keyboard alone: tab through the submission step, fill it and advance without using the mouse"` | NFR-6 |
| X.2 | `do "log in as a speaker and try to open /app — report what happens"` | NFR-4, FR-PLAT-1 — role gate |
| X.3 | `do "log in as one speaker and try to open another speaker's submission by URL — report what happens"` | NFR-5 — tenant/record isolation |
| X.4 | `do "report every timestamp shown on the agenda for Oct 12 and confirm each carries a timezone abbreviation"` | NFR-12 |
| X.5 | `do "submit the CFP form with the title field empty and report the validation message"` | Error states |
| X.6 | `do "open the workspace with a filter that matches nothing and report the empty state shown"` | Empty states |

---

## Reporting

At the end of a run, produce a table of *stage · step · pass/fail · what was observed*, then
list failures with the exact `browser-pilot` report text. Distinguish:

- **Fail** — the expectation was contradicted (a real defect).
- **Blocked** — the step could not be attempted (missing seed data, upstream step failed,
  agent could not find the control). Blocked is not pass.
- **N/A** — the feature belongs to a milestone above the requested ceiling.

Never report a stage as passing when a step within it was blocked. If the run was requested
"up to Mn", state explicitly which stages were skipped as N/A.

### Operating notes

- One assertion per `do`. Two unrelated artifacts in one instruction is the documented
  stall case — split it.
- Use `open` / `peek` / `screenshot` for navigation and spot-checks; they cost no agent tokens.
- Screenshot on every failure before moving on: `browser-pilot screenshot`.
- Anything about server-rendered output (the portal and CFP are SSR) must say `fetch_source`
  in the instruction, so an SSR bug is distinguished from a hydration bug.
- Bump `--max-turns` for the drag-heavy M4 steps if they run out of turns; don't split a drag
  across two instructions.
