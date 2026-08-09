# Secondary Flow — End-to-End Browser Test Plan (browser-pilot)

Phase **S** of [`tests/e2e-high-level.md`](e2e-high-level.md) §4. Written in the shape of
[`docs/14-e2e-browser-test.md`](../docs/14-e2e-browser-test.md): milestone sections, one numbered
step per row, one natural-language `do` per step, one assertion per `do`.

This plan covers the **main feature behaviour the primary plan's demo path never touches** —
form-builder editing, draft save/resume, portal forms and file requests, evaluation plan and
criteria configuration, multi-round scoring, the Week/Month/Rooms agenda views and their
filters, the dashboard's secondary tabs, and settings/library CRUD. It deliberately does *not*
re-prove anything docs/14 already proves.

> Load this file as the brief before the first `do`:
> `browser-pilot brief tests/secondary-flow-e2e.md`

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

`.dev.vars` must contain `DEV_MODE=on`; every "log in" step below depends on `/auth/request`
rendering the sign-in link on the page. Base URL for local runs: `http://localhost:8787`.

```sh
browser-pilot brief tests/secondary-flow-e2e.md
browser-pilot note "run id is <RUNID>; use it as a prefix for every record this run creates"
browser-pilot open http://localhost:8787/health
```

**Fixtures — reused verbatim from [docs/14 §S0](../docs/14-e2e-browser-test.md), none invented:**

| Thing | Value |
|---|---|
| Event slug | `ai-engineer-sandbox-event` |
| CFP form (the judged one) | `form0000-0000-4000-8000-000000000001` — *Call for Speakers 2026*, open, limit 3/user |
| Second open form | *Session Submission Form #2* — `form0000-0000-4000-8000-000000000002`, limit 1/user |
| Closed form | *Lightning Talks* — `form0000-0000-4000-8000-000000000003` |
| Admin login | `james@atelyr.com` |
| Reviewer logins | `rosalind.franklin@example.com`, `vint.cerf@example.com`, `frances.allen@example.com` |
| Rich-footprint speaker | `ada@example.com` (submissions, tasks, messages) |
| Portal-form speaker | `alan.turing@example.com` (seeded *Hotel and Travel Reservations* task) |
| Deliberate double-booking | Grace Hopper, Oct 12 |
| Unscheduled accepted session | SESS-14 |

| # | Step | Expect |
|---|---|---|
| S0.1 | `open http://localhost:8787/health` | 200, JSON `ok` |
| S0.2 | `do "open / and confirm the demo landing page renders with a Demo admin login section — report the admin email it shows"` | Landing page (no redirect to /app), `james@atelyr.com` — **FR-PLAT-7** |
| S0.3 | `do "log in as an admin: go to /app, enter james@atelyr.com, pick the AI.Engineer Sandbox Event, then follow the DEV_MODE sign-in link shown on the page. Confirm you land on the admin shell and report the sidebar items"` | Dashboard · Workspace · Forms · Evaluation · Review · Agenda · Settings — **FR-PLAT-1** |

**Gate:** if S0.3 fails, stop — every step below is authenticated.

**Run hygiene:** prefix every record you create with `<RUNID>`. The plan creates a form, an
evaluation plan, a criterion, a contact, a session and an API token; all are deleted or left
harmless, and a clean baseline is one `npm run seed:local` away.

---

## M1 — Form builder editing, field library & drafts

*Covers FR-FORM-1/4/5/7/8/9/11/13/14/19/20, FR-SUB-7. Spec: [04](../docs/04-cfp-and-forms.md).*

| # | Step | Expect |
|---|---|---|
| M1.1 | `do "open Forms and confirm each form card shows a status chip, a collection-type chip and its submission/draft counts — report the chips and counts on the Call for Speakers 2026 card"` | `Open` · `Abstracts & Participants` · N submissions · M drafts · Closes Sep 15, 2026 — **FR-FORM-19** |
| M1.2 | `do "click + Create Form, and confirm the six-step builder opens on Submission Setup with the rail reading 1 Submission Setup … 6 Notifications"` | Six steps, Payments omitted — **FR-FORM-2** |
| M1.3 | `do "on the Welcome Screen step rename the Internal Form Name to '<RUNID> Secondary Form', then press Save and confirm the header shows a 'Saved <time>' marker"` | Persisted — **FR-FORM-4** |
| M1.4 | `do "still on Welcome Screen, type 20 characters into Page Heading and report how many characters the field actually accepts"` | Hard-capped at 15 — **FR-FORM-4** |
| M1.5 | `do "go to Abstract Information and confirm the Title question shows a Locked chip and has no Remove action, unlike the other questions"` | Locked system field is undeletable — **FR-FORM-7** (gate) |
| M1.6 | `do "on Abstract Information, untick the Required checkbox on the Description question and confirm the required asterisk disappears from that row"` | Required toggle persists immediately — **FR-FORM-7** |
| M1.7 | `do "drag the Level question by its handle and drop it above Format, then reload the builder and confirm Level is still listed before Format"` | Drag reorder persists via the reorder endpoint — **FR-FORM-7** |
| M1.8 | `do "click + Add Field, search the field library for 'Headshot', add it, and confirm a Headshot row appears at the bottom of the question list"` | Library pick — **FR-FORM-8** |
| M1.9 | `do "click + Add Field then Create Field, create a text field labelled '<RUNID> Sponsor Code' with max 40 characters, and confirm the new row shows a Max 40 chars chip"` | Inline field creation — **FR-FORM-8** |
| M1.10 | `do "open Logic on the '<RUNID> Sponsor Code' question, tick 'Only show this question conditionally', add a condition Format equals Workshop, save, and confirm the row now carries a Conditional chip"` | Conditional editor writes visibility — **FR-FORM-9** |
| M1.11 | `do "on Participant Information, enable the co-speaker role with Max 2 and confirm the speaker role's checkbox stays disabled because it is mandatory"` | Roles panel — **FR-FORM-11** |
| M1.12 | `do "on Form Settings, turn off 'Auto-redirect to speaker portal', press Save, reload the builder and confirm the toggle is still off"` | Settings round-trip — **FR-FORM-15** |
| M1.13 | `do "return to the Forms list, use Duplicate on '<RUNID> Secondary Form' and report the internal name of the new card"` | `<RUNID> Secondary Form (copy)` — **FR-FORM-1** |
| M1.14 | `do "use Close on the '<RUNID> Secondary Form (copy)' card and confirm its status chip flips to Closed and the button becomes Reopen"` | Close/Reopen — **FR-FORM-13** |
| M1.15 | `do "delete '<RUNID> Secondary Form (copy)' and confirm an in-app confirmation dialog appears (not a browser alert) before the card disappears"` | App dialog, no `window.confirm` — polish item |
| M1.16 | `do "start a submission on the Call for Speakers 2026 form as <RUNID>-draft@example.com via the DEV_MODE link, enter the title '<RUNID> Draft Resume Test' on the Submission step, wait about 15 seconds without navigating and report the autosave marker shown"` | `Draft saved <time>` — **FR-SUB-7** |
| M1.17 | `do "reload /submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000001 while still signed in as <RUNID>-draft@example.com and confirm the Account step says the saved draft is being resumed and the title field is pre-filled"` | "Resuming your saved draft." — **FR-SUB-7** |

> **Note:** FR-FORM-16 (cross-field character limits) has no control on the Form Settings step —
> I could not locate any implementation of `cross_field_limits` beyond the database column, so no
> step asserts it.

> **Note:** FR-FORM-19's All/Open/Closed filter tabs, search box and sort control are not present
> on the Forms list — the list is an unfiltered card list. M1.1 asserts only the per-card chips
> and counts, which are implemented.

---

## M2 — Portal: submissions, profile detail, portal forms & file requests

*Covers FR-PORTAL-3/4/5/6/7/8, FR-SUB-12. Spec: [05](../docs/05-speaker-portal.md).*

| # | Step | Expect |
|---|---|---|
| M2.1 | `do "log into /portal/ai-engineer-sandbox-event as ada@example.com via the DEV_MODE link, open Submissions and report every submission code, title and status chip listed"` | SESS-1 Accepted, SESS-4 Pending, SESS-10 Draft — **FR-PORTAL-3** |
| M2.2 | `do "open SESS-4 from the portal Submissions list and report the participant rows shown, including who is marked primary contact"` | Ada Lovelace · speaker · primary contact — **FR-PORTAL-4** |
| M2.3 | `do "using fetch_source on the portal submission detail page for SESS-1, confirm the server-rendered HTML already contains the answers list rather than an empty shell"` | SSR, not hydration — **NFR-1** |
| M2.4 | `do "on the portal Profile, set Pronouns to she/her and the LinkedIn URL to https://example.com/<RUNID>, save, and confirm the success flash then the persisted values after a reload"` | "Profile saved." — **FR-PORTAL-5** |
| M2.5 | `do "on the portal Profile, confirm the Biography field shows a live character counter and report its text after typing"` | `N / 5,000 characters` — **FR-PORTAL-5** |
| M2.6 | `do "on the portal Tasks page as ada@example.com, confirm the page splits into Submission Tasks and My Tasks and report the task titles in each"` | Presentation Upload under Submission Tasks; Speaker Profile & Headshot + Speaker Agreement under My Tasks — **FR-PORTAL-6** |
| M2.7 | `do "complete the Speaker Agreement acknowledge task: tick 'I have read and agree', press Confirm, and confirm the task status chip becomes complete"` | Acknowledge action — **FR-PORTAL-6** |
| M2.8 | `do "complete the Presentation Upload file-request task by uploading a small PDF, and confirm the task reports a completion date"` | File request upload — **FR-PORTAL-8**, **FR-SUB-12** |
| M2.9 | `do "log into the portal as alan.turing@example.com via the DEV_MODE link, open Tasks and confirm the Hotel and Travel Reservations task renders its four questions inline with a Submit & complete button"` | Portal form rendered in the task — **FR-PORTAL-7** |
| M2.10 | `do "as alan.turing@example.com, answer the Hotel and Travel Reservations form (choose a hotel option and a check-in date) and submit it; confirm the flash reports the task completed"` | "Task completed — thank you!" — **FR-PORTAL-7** |
| M2.11 | `do "as an admin, open the workspace Messages tab and confirm a portal_form_confirmation message now exists for alan.turing@example.com — report its status"` | Confirmation email on portal-form completion — **FR-PORTAL-7**, **FR-COMM-8** |

> **Note:** there is no admin UI for creating or editing tasks, portal forms or file requests —
> `tasks`, `portal_forms` and `file_requests` are seed-only, with no route under `/app/api` and no
> section in the admin SPA. M2.6–M2.10 therefore exercise the seeded definitions from the speaker
> side only; the admin-authoring half of FR-PORTAL-7/8 is untested because it is unbuilt.

> **Note:** FR-PORTAL-9 ("View Portal" impersonation with a "Back to Admin" return) has a rendered
> banner in the portal layout but no admin-side entry point I could find, so no step triggers it.

---

## M3 — Evaluation plans, criteria configuration & multi-round scoring

*Covers FR-REV-9/10/11/12, FR-DASH-9. Spec: [06](../docs/06-review-and-scoring.md).*

| # | Step | Expect |
|---|---|---|
| M3.1 | `do "open Evaluation and report every plan card with its status, submission count and 'N/M reviews complete' line"` | Round 1 — Track leads · Workshops · General Review, all active — **FR-REV-9** |
| M3.2 | `do "on the Round 1 — Track leads card, report every scoring criterion with its weight"` | Relevance ×2, Speaker credibility ×1, Novelty ×1 — **FR-REV-9** |
| M3.3 | `do "change the weight of the Novelty criterion to 2 and blur the field; reload Evaluation and confirm the weight stuck at 2"` | Criterion weight edit persists — **FR-REV-9** |
| M3.4 | `do "press + Create plan, accept the browser prompt with the name '<RUNID> Round 2 — Programme committee', and confirm a new plan card appears"` | Plan creation (uses a native prompt) — **FR-REV-12** |
| M3.5 | `do "on the '<RUNID> Round 2 — Programme committee' card use + Add criterion to add 'Audience fit' with weight 3, and confirm the criterion row appears with ×3"` | Criteria configuration — **FR-REV-9** |
| M3.6 | `do "on the '<RUNID> Round 2 — Programme committee' card select the round-robin strategy with 2 per submission, tick all three reviewers, press Assign and report the assignment note shown"` | `<plan>: N assignments across M submissions` — **FR-REV-9** |
| M3.7 | `do "press Assign a second time on the same plan with the same settings and confirm the total assignment count does not double"` | `INSERT OR IGNORE` keeps re-runs additive, never duplicating — **FR-REV-9** |
| M3.8 | `do "set the '<RUNID> Round 2 — Programme committee' plan status to draft, then log in as frances.allen@example.com and confirm the draft plan's assignments do not appear in her review queue"` | Only `active` plans surface to reviewers — **FR-REV-9** |
| M3.9 | `do "as an admin set that plan back to active, then as rosalind.franklin@example.com open the review queue and report the queue header progress line"` | `My review queue — N of M reviewed` — **FR-REV-10** |
| M3.10 | `do "as rosalind.franklin@example.com open an already-completed assignment on Round 1 — Track leads and confirm her previous scores and comment are pre-loaded into the form"` | Re-open and revise — **FR-REV-10** |
| M3.11 | `do "as rosalind.franklin@example.com score every criterion on an open '<RUNID> Round 2 — Programme committee' assignment and press Save & Next; report the saved note and confirm the queue advances to the next unreviewed item"` | `Saved — your total X, submission mean Y` — **FR-REV-10** |
| M3.12 | `do "back as an admin, open that submission's detail tab in the workspace Submissions tab and report the reviews listed with their weighted totals"` | Second round's review visible alongside round 1 — **FR-REV-12** |

> **Note:** FR-REV-10's keyboard shortcuts (`1–5` to score, `→`/`←` to move) and the explicit
> **Skip** action are not implemented in the reviewer workspace — only the conflict-of-interest
> checkbox and Save / Save & Next exist — so no step asserts them.

> **Note:** the plan card exposes name, status, criteria, reviewers and assignment strategy, but
> no control for `anonymise_submitters` or the plan description, though both exist in the API. No
> step asserts anonymisation from the UI.

---

## M4 — Agenda views, filtering & conflict management

*Covers FR-AGENDA-1/2/5/6/7/8/9. Spec: [07](../docs/07-agenda-and-scheduling.md).*

| # | Step | Expect |
|---|---|---|
| M4.1 | `do "open Agenda, switch to the Week view and confirm one column per event day is shown — report the column headers"` | Oct 12 · Oct 13 · Oct 14 — **FR-AGENDA-1** |
| M4.2 | `do "switch to the Month view and report the month heading plus every day cell that shows a session count"` | October 2026, Oct 12 with 5 sessions — **FR-AGENDA-1** |
| M4.3 | `do "click the Oct 12 cell in the Month view and confirm it navigates to the Day view already showing Oct 12"` | Month → Day drill-through — **FR-AGENDA-1** |
| M4.4 | `do "switch to the Rooms view and report every room lane shown with its heading"` | Main Stage · Hall A · Hall B · Studio · Pavilion · Lounge — **FR-AGENDA-1** |
| M4.5 | `do "switch to the List view, click the Title column header and confirm the rows reorder alphabetically with a sort arrow on that column"` | Sortable list — **FR-AGENDA-1** |
| M4.6 | `do "in the Day view set 'Group by' to Track and confirm the columns become track names plus a 'No track' column"` | Group-by switch — **FR-AGENDA-7** |
| M4.7 | `do "type 'Postmortems' into the agenda search box and confirm only SESS-14 remains visible in the unscheduled tray"` | Search filter — **FR-AGENDA-7** |
| M4.8 | `do "clear the search, then set the tray's track filter to 'AI in Production' and report which sessions remain in the tray"` | Tray track filter — **FR-AGENDA-7** |
| M4.9 | `do "clear the tray filters, then use + Add Session to create '<RUNID> Sponsor Showcase' as a Talk in Studio on Oct 13 at 11:00 for 30 minutes, and confirm it renders in that slot"` | Manual session creation — **FR-AGENDA-6** |
| M4.10 | `do "open the Conflicts view and press Ignore on the seeded Grace Hopper SPEAKER_DOUBLE_BOOKED conflict; confirm it moves into the collapsed 'Ignored' section"` | Ignore is remembered per signature — **FR-AGENDA-5** |
| M4.11 | `do "expand the Ignored section and press Restore on that conflict; confirm it returns to the Errors group"` | Restore path — **FR-AGENDA-5** |
| M4.12 | `do "drag the '<RUNID> Sponsor Showcase' block from the calendar back onto the unscheduled tray and confirm it appears in the tray as unscheduled"` | Drop-to-unschedule — **FR-AGENDA-3** |
| M4.13 | `do "press Ctrl+Z and confirm '<RUNID> Sponsor Showcase' returns to Studio on Oct 13 at 11:00"` | Undo of the last scheduling action — **FR-AGENDA-8** |
| M4.14 | `do "report every control in the Agenda header and view bar, and state whether any publish or unpublish action for the agenda exists"` | Documents the FR-AGENDA-9 gap — **FR-AGENDA-9** |

> **Note:** FR-AGENDA-9 (publish/unpublish the agenda) is not implemented. `events.agenda_published`
> exists in the schema and is selected into the agenda payload, but nothing reads or writes it and
> there is no control anywhere in the SPA. M4.14 is written as a reporting step so the gap is
> recorded rather than silently dropped.

---

## M5 — Dashboard tabs & deep-links

*Covers FR-DASH-4/5/8/9/10. Spec: [09](../docs/09-dashboard-and-reporting.md).*

| # | Step | Expect |
|---|---|---|
| M5.1 | `do "open the Dashboard and report the four tabs under the Today board"` | Submission Forms · Participants · Evaluations · Agenda — **FR-DASH-5** |
| M5.2 | `do "on the Today → Submission Forms tab, report the 'Your forms' rows with their status and submitted counts"` | One row per seeded form — **FR-DASH-5** |
| M5.3 | `do "on the Today → Submission Forms tab, confirm the Submission pacing chart renders a cumulative line and report the total it labels"` | Cumulative pacing — **FR-DASH-10** |
| M5.4 | `do "open the Today → Participants tab and report the 'Participants by role' bars with their values"` | speaker bar — **FR-DASH-5** |
| M5.5 | `do "open the Today → Evaluations tab and report Reviews written, Submissions evaluated, Reviews in progress and Most active plan"` | Review-progress stats — **FR-DASH-9** |
| M5.6 | `do "open the Today → Agenda tab and report Scheduled, Unscheduled and the Conflicts figures"` | Schedule health — **FR-DASH-5** |
| M5.7 | `do "click a row in Today's 'Recent submissions' table and confirm the workspace opens on the Submissions tab with a 'Filtered from dashboard' bar naming that submission"` | Deep-link with seeded filters — **FR-DASH-4** |
| M5.8 | `do "return to the Dashboard, open the Submissions Pipeline board and report all five funnel stages with their counts"` | Received · Reviewed · Decided · Accepted · Scheduled — **FR-DASH-8** |
| M5.9 | `do "on the Submissions Pipeline board, report the 'Submissions by track' bars"` | Per-track breakdown — **FR-DASH-8** |
| M5.10 | `do "click the Pending Review tile on the Submissions Pipeline board and confirm the workspace opens on Submissions filtered to Pending"` | Tile deep-link — **FR-DASH-4** |

---

## M6 — Settings, library CRUD, exports & API

*Covers FR-PLAT-5, FR-DASH-13, FR-REV-5. Spec: [10](../docs/10-api.md).*

| # | Step | Expect |
|---|---|---|
| M6.1 | `do "open the workspace Speakers tab, use the add-record control to create a contact named '<RUNID> Test Speaker' with email <RUNID>-crud@example.com, and confirm the row appears in the list"` | Contact create — **FR-REV-5** |
| M6.2 | `do "select the '<RUNID> Test Speaker' row, edit its Company to '<RUNID> Corp' and save; reload the tab and confirm the change persisted"` | Contact update — **FR-REV-5** |
| M6.3 | `do "delete '<RUNID> Test Speaker' from the Speakers tab, confirming through the in-app dialog, and confirm the row is gone"` | Contact delete — **FR-REV-5** |
| M6.4 | `do "on the workspace Submissions tab select the Accepted status chip, then use the ↓ CSV export control and confirm the download completes"` | Export honours active filters — **FR-DASH-13** |
| M6.5 | `do "on the workspace Messages tab use the ↓ XLSX export control and confirm the download completes"` | XLSX export — **FR-DASH-13** |
| M6.6 | `do "open Settings and create an API token named '<RUNID> plan token'; confirm the secret is shown once with a warning that it will not be shown again, and report its kms_ prefix"` | One-time secret — **FR-PLAT-5** |
| M6.7 | `do "confirm the new token now appears in the Settings token table with a Created timestamp and a truncated prefix rather than the full secret"` | Token list — **FR-PLAT-5** |
| M6.8 | `do "using fetch_source, call /api/v1/events with the '<RUNID> plan token' as an Authorization Bearer header and report the event names returned"` | AI.Engineer Sandbox Event – NYC — **FR-PLAT-5** |
| M6.9 | `do "using fetch_source, call /api/v1/events/<event id>/submissions?status=accepted&sort=-created_at&limit=5 with that token and report total and the first code returned"` | Filter + sort + paging — **FR-PLAT-5** |
| M6.10 | `do "revoke the '<RUNID> plan token' in Settings, confirming through the in-app dialog, and confirm the row shows a revoked chip"` | Revocation — **FR-PLAT-5** |
| M6.11 | `do "using fetch_source, call /api/v1/events again with the revoked token and report the HTTP status and error code"` | 401 `invalid_token` — **FR-PLAT-5** |

> **Note:** "library CRUD" in §4 maps only to the Speakers-tab contact CRUD (M6.1–M6.3), the form
> builder's field library (M1.8–M1.9) and Settings' API tokens (M6.6–M6.10). Tracks, rooms and
> tags have no create/edit/delete surface anywhere in the admin SPA — they are seed-only — so no
> step asserts CRUD on them.

---

## Reporting

At the end of a run, produce a table of *stage · step · pass/fail/blocked/N-A · what was
observed*, then list failures with the exact `browser-pilot` report text. Distinguish:

- **Fail** — the expectation was contradicted (a real defect).
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
  the instruction, so an SSR bug is distinguished from a hydration bug.
- Bump `--max-turns` for the drag steps (M1.7, M4.12) if they run out of turns; **don't split a
  drag** across two instructions.
- M3.4 and M3.5 go through native `window.prompt` dialogs — accept them in the same instruction
  rather than treating the prompt as a separate step.
