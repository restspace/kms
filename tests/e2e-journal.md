# E2E Run Journal

Append-only. Driven by [`tests/e2e-high-level.md`](e2e-high-level.md).

Run started 2026-08-08. Budgets: MAX_ITERATIONS 8/phase · PHASE_TIME_BUDGET 90 min ·
RUN_TIME_BUDGET 6 h · ERROR_BATCH 5.

## 2026-08-08T21:29Z · phase P · iteration 1 · orchestrator
- baseline: migrate ok (no pending) | seed ok | build ok (tsc clean) | health 200
- browser-pilot: provider novita / zai-org/glm-5.2, daemons stopped
- notes: run id `p-01`. Committed docs + strategy as 3051782 so fix commits stay discrete.

## 2026-08-09T00:35Z · phase P · iteration 1 · runner
- baseline: reset ok | build ok | health 200
- outcome: 4 defects, 3 test-plan bugs, 1 flake
- steps: last step reached = X.6 (plan complete; stage P skipped per orchestrator)
- quarantine: —
- notes: both gates (S0.3, M1.3, M1.8) passed. Defects: M2.6 seed has zero messages so
  Ada's message-log demo is empty; M6.5 no landing page/demo logins exist at all; X.4
  agenda timestamps carry no per-timestamp tz abbreviation (NFR-12); X.6 zero-result lists
  render no empty state. browser-pilot wedged for ~25 min on the M4.5 drag — killed,
  `stop --all`, re-briefed, step then passed (flake).

## 2026-08-09T02:05Z · phase P · iteration 1 · fixer
- baseline: db reseeded mid-fix (seed.sql changed) | typecheck pass | build pass | health 200
- outcome: 3 defects fixed, 4 test-plan bugs corrected (F3 reclassified), 0 deferred
- steps: re-drove M2.6, M6.5, X.6, X.4, S0.2, M6.4 with RUNID `p-01f` — all pass
- quarantine: —
- notes:
  - F1 · M2.6 · DEFECT fixed · a2618bc — eight fixed-uuid `message_log` rows added to
    `packages/db/seed/seed.sql`, six of them Ada's across five templates and the
    sent/failed/queued statuses. Re-driven: anchoring Ada narrows Messages to 6 rows.
  - F2 · M6.5 · DEFECT fixed · 5719100 — the requirement IS real, but it lives in
    docs/12 §2 "Demo logins" + §4 checklist, not in FR-PLAT-7 itself (which only mandates
    seeded demo data). New server-rendered landing page at `/` in
    `apps/api/src/routes/landing.ts`: demo admin login, demo speaker login (both read out
    of the seed, not hard-coded) and a Reset demo data button posting to a public
    `/demo/reset` that reuses `resetDemoData` behind the same `DEMO_RESET` gate. `/` no
    longer redirects to `/app`; the only callers were the two logout redirects.
  - F3 · X.4 · TEST-PLAN BUG (reclassified from DEFECT) · 7fee25c — **correcting the plan
    IS the fix.** docs/07 §2 states the abbreviation is shown *in the header*; NFR-12's
    example is a prose timestamp, not a per-block rule. The plan's "every timestamp"
    wording was wrong. Agenda header reads "… · AI.Engineer Sandbox Event – NYC · PDT".
  - F4 · X.6 · DEFECT fixed · d289f6d — `DataList` renders "No records match the current
    filters." when the result set is complete, empty, not in error and has no open draft.
    Screenshot tests/screenshots/p-01f/X.6.png.
  - F5 · S0.2 · TEST-PLAN BUG · 21b2219 — **correcting the plan IS the fix.** Heading
    expectation changed to "AI.Engineer NYC — Call for Speakers 2026".
  - F6 · M6.4 · TEST-PLAN BUG · 32a0ca2 — **correcting the plan IS the fix.** Step now
    names the Forms list; the Workspace has no delete affordance.
  - F7 · X.6 · TEST-PLAN BUG · 4ca0c2f — **correcting the plan IS the fix.** Step now
    names the Decline Queue status chip instead of implying a free-text search.
  - observation (out of scope, not fixed): `/app/api/meta` advertises a `q` filter on
    `submissions` that the workspace UI exposes no input for. Possible real gap.

## 2026-08-09T00:52Z · phase P · iteration 2 · orchestrator
- baseline: migrate ok | seed ok | build ok (tsc clean) | health 200 | browser-pilot stopped
- quarantine: —
- notes: run id `p-02`. All 7 iteration-1 findings fixed or corrected (a2618bc, 5719100,
  7fee25c, d289f6d, 21b2219, 32a0ca2, 4ca0c2f). Watch `/` — it now serves the new landing
  page instead of redirecting to /app.

## 2026-08-09T00:50Z · phase P · iteration 2 · runner
- baseline: reset ok (orchestrator) | build ok | health 200
- outcome: 0 defects, 0 test-plan bugs, 2 flakes
- steps: last step reached = X.6 (plan complete; stage P skipped per orchestrator)
- quarantine: —
- notes: run id `p-02`. Full plan S0→M6 + stage X re-run clean. All seven iteration-1 fixes
  re-proved: M2.6 (Ada anchored → 6 message_log rows, 5 templates, sent/failed/queued),
  M6.5 (server-rendered `/` landing page carries demo admin login, demo speaker login and
  Reset demo data — verified via fetch_source), X.6 ("No records match the current filters."
  on the Decline Queue chip), X.4 (agenda header "… · AI.Engineer Sandbox Event – NYC · PDT"),
  S0.2 (heading "AI.Engineer NYC — Call for Speakers 2026"), M6.4 (Forms delete uses an
  in-page role=alertdialog, no native dialog). The `/` change broke no navigation — /app,
  /portal and /submit all reached directly throughout.
  Flakes: M4.5 wedged browser-pilot again (>12 min, ignored its own --timeout); killed the CLI
  pid, `stop --all`, re-briefed, retried once → passed with ROOM_DOUBLE_BOOKED. X.1 hit the
  turn cap twice mid-step; retried from a fresh open with --max-turns 90 → passed.
  Observations (not defects, out of plan scope): M3.7 second decision send is correctly
  idempotent but gives no user-facing feedback at all (bulk bar just disappears);
  M5.1 dashboard Submissions KPI reads 14 while the Submissions tab and status tiles total 15.

## 2026-08-09T02:05Z · phase P · outcome · orchestrator
- **PHASE P PASSED** — iteration 2 ran the full plan (S0, M1–M6, X) on a clean baseline with
  0 defects, 0 test-plan bugs, 0 environment errors. All 7 iteration-1 fixes re-proved.
- iterations: 2 of 8. quarantine: — (none).
- flakes: M4.5 (browser-pilot wedged on the drag in BOTH iterations, second time ignoring its
  own --timeout 420; killed + restarted + retried once → pass). X.1 (agent turn cap, retried
  with --max-turns 90 → pass).
- carried observations, not plan expectations, so not counted as defects:
  - M5.1 — Dashboard "Submissions" KPI reads 14; the Submissions tab and the status tiles
    (8+4+1+1+1) both total 15.
  - M3.7 — repeat decision send is correctly idempotent but gives no user-facing feedback;
    the bulk bar just disappears.
- next: fix the two observations, then build the S and U plans (§4) before phase S.

## 2026-08-09T02:20Z · phase P · tooling note · orchestrator
- browser-pilot wedge on M4.5 diagnosed (source at C:\dev\browser-pilot, not modified).
  `src/agent/loop.ts` bounds the instruction deadline only between turns (:142) and around
  the LLM call via the watchdog AbortController (:159-172). Tool execution at :253 is awaited
  with no deadline and no abort signal — `if (Date.now() > deadline) break` at :213 is checked
  BEFORE the call, never during. So one hanging tool call (drag on a blocked renderer, goto's
  30s, wait_for's polling loop) runs to completion regardless of `--timeout`.
- workaround in force for the rest of the run: kill the CLI pid, `browser-pilot stop --all`,
  re-brief, retry once, then fall back to agent-browser.

## 2026-08-09T03:05Z · phase P · post-pass fixes · fixer
- baseline: seeded ok | typecheck pass | build pass | health 200 | RUNID p-03f
- F1 · M5.1 · fixed · cb59170 — `apps/api/src/routes/dashboard.ts` computed
  `kpis.submissions` as total-minus-drafts while the Accepted/Pending/Declined/Drafts/Withdrawn
  tiles and the workspace Submissions tab counted every row. docs/09 §1 lists those five tiles
  directly under the Submissions KPI as its breakdown, so the tiles' total is the correct one:
  the KPI now counts all submissions. The Submissions Pipeline board's own "Total Submissions"
  stat still excludes drafts — docs/09 §3 defines it as the funnel's "received", a different
  number on a different board, so it was left alone. Re-driven: KPI 14, tiles 6+5+1+1+1 = 14,
  Submissions tab (All) 14 — three-way agreement on a fresh seed.
- F2 · M3.7 · fixed · 0a458da — the bulk bar already had a note slot; `handleChecklist` in
  `apps/admin/src/App.tsx` cleared it on every checklist emission, and the post-action refetch
  re-emits an empty checklist, so the note was wiped in the tick it was set. The note now
  survives until a genuinely new (non-empty) selection replaces it. `send-decisions` also now
  splits `skipped` into `skipped_notified` vs other, so a repeat send reads as "already
  notified" rather than a bare zero. Idempotency behaviour untouched. Re-driven M3.5→M3.7:
  first send "2 decision emails sent — 2 accepted, 0 declined, 2 tasks assigned"; repeat send
  on the same rows "0 decision emails sent — 0 accepted, 0 declined, 0 tasks assigned;
  2 skipped (already notified)".
- notes: no plan edits — both observations were app defects, not plan bugs. browser-pilot did
  not wedge (neither fix needs a drag). DB left seeded.

## 2026-08-09T07:24Z · phase S · iteration 1 · orchestrator
- interruption: the parent process exited mid-run and took the wrangler dev server with it.
  Restarted `wrangler dev` (the sandboxed background shell cannot hold a listening socket —
  it must run unsandboxed); health 200 again.
- database NOT reset: nothing touched it between the stop and the restart, so the runner's
  own records are intact and it resumes the same iteration rather than restarting it.
- runner resumed with instructions to re-brief browser-pilot (its daemon died with the parent).
- quarantine: —

## 2026-08-09T08:35Z · phase S · tooling note · orchestrator
- browser-pilot wedge FIXED upstream (C:\dev\browser-pilot d6da824 "Bound tool execution by
  the instruction deadline"). The global CLI is symlinked to that checkout but runs from
  `dist/`, which was a day stale — rebuilt it (`npm run build`, artifacts only, no source
  edits). Verified in dist/agent/loop.js:75-81: executeTool is now raced against
  `deadline - Date.now()` with an abort signal, so a hung tool call reports blocked instead
  of running past `--timeout`.
- the daemon serving phase S still holds the old code in memory; the fix takes effect on its
  next restart. In force from phase U onward.
- the kill/stop/re-brief/retry mitigation stays in the runner prompts as a belt-and-braces
  fallback.

## 2026-08-09T08:45Z · phase S · iteration 1 · runner
- baseline: seeded ok | build ok | health 200 | RUNID s-01 (dev server restarted mid-run by the
  orchestrator after the parent process exited; DB not reset, run continued from M4.6)
- outcome: 2 defects, 2 test-plan bugs, 1 unimplemented, 0 flakes
- steps: last step reached = M6.11 — plan complete (S0.1 → M6.11, all 75 steps attempted)
- quarantine: none
- notes:
  - D1 · M1.1 — Call for Speakers 2026 card renders "Closes Sep 16, 2026"; seed stores
    2026-09-16T06:59:00Z = Sep 15 23:59 in the event timezone (America/Los_Angeles). Close date
    is formatted in UTC, not the event tz, so it reads one day late. Same string on the
    Dashboard Today → Submission Forms tab.
  - D2 · M1.4 — Welcome Screen "Page Heading" accepts 20 characters against a stated 15-char
    limit; the counter renders "20/15" rather than the input being hard-capped.
  - TP1 · M3.6/M3.11 — a newly created evaluation plan always has 0 submissions: routing to a
    plan happens only through a form's routing rules at submission time, and there is no admin
    control to move an existing submission onto a plan. Assign on the new plan correctly reports
    "s-01 Round 2 — Programme committee: 0 assignments across 0 submissions". M3.7/M3.8/M3.11
    were driven against Round 1 — Track leads instead and passed there.
  - TP2 · M1.8 — Headshot is a contact-scoped library field, so it is offered on Participant
    Information, not Abstract Information; the Add Field dialog on Abstract Information correctly
    says "No unused library fields match." Step passed once run on the right step.
  - U1 · M4.14 — FR-AGENDA-9 confirmed unimplemented: no publish/unpublish control anywhere in
    the Agenda header or view bar (matches the plan's own note).
  - browser-pilot did not wedge on either drag step (M1.7, M4.12); both passed first try with
    --max-turns 70/80.

## 2026-08-09T07:54Z · phase S · environment note · orchestrator
- wrangler dev CRASHED mid-fix with an empty `X [ERROR]` immediately after a hot-reload
  following an asset rebuild (log: wrangler-2026-08-09_07-23-56_825.log — Sentry reporting
  disabled, no stack). Not an app fault; the worker had been serving 200s right up to it.
- restarted unsandboxed in the background; health 200 within seconds. Fixer notified so it
  re-drives anything attempted during the outage and does not misclassify a connection
  failure as a defect.
- second server death of the run. If it recurs, prefer a full stop/start around each
  `npm run build` rather than relying on wrangler's hot-reload.

## 2026-08-09T08:10Z · phase S · iteration 1 · fixer
- baseline: reseeded ok | typecheck ok | build ok | health 200 (after the orchestrator's restart)
- outcome: 2 defects fixed, 2 test-plan bugs corrected, 1 deferred (unbuilt feature)
- F1 · M1.1 · fixed · 2a6241e — Forms list and Dashboard Today each carried a private `fmtDate`
  that formatted in the viewer's timezone, so `2026-09-16T06:59:00Z` read as Sep 16 instead of
  Sep 15 in `America/Los_Angeles` (NFR-12). Added one shared `fmtDateInTz` helper
  (`apps/admin/src/utils/dates.ts`) and threaded the event timezone in from `me.event.timezone`
  (Forms) and `data.event.timezone` (Dashboard); the same helper also fixes the Created / due-at
  columns that shared the cause. Re-driven: Forms card meta now `Closes Sep 15, 2026`, Dashboard →
  Today → Submission Forms now `closes Sep 15, 2026`.
- F2 · M1.4 · fixed · 892c62b — `maxLength` only constrains typing, so a programmatic fill left
  Page Heading holding 20 chars with a `20/15` counter. docs/04 §1 and docs/02 both state a hard
  15-char cap (already truncated server-side in `formsAdmin.ts:20`), so the field was wrong, not
  the counter; clamped on change. Re-driven: typing 20 chars yields counter `15/15`, value length 15.
- F3 · M3.6/M3.11 · plan-corrected · 97520cf — **plan correction, not an app change.** A plan
  created in M3.4 can never have submissions: routing happens only via a form's routing rules at
  submission time (`FormBuilder.tsx:888`) and there is no admin control to move a submission onto
  a plan, so `N assignments across M submissions` was unreachable. M3.6, M3.8 and M3.11 now drive
  the seeded `Round 1 — Track leads` plan; M3.12's expectation drops the round-2 wording that
  inherited the assumption. Re-driven M3.6: `Round 1 — Track leads: 18 assignments across 6 submissions`.
- F4 · M1.8 · plan-corrected · 5794989 — **plan correction, not an app change.** Headshot is a
  `contact`-scoped library field (`seed.sql:88`), so the builder correctly offers it only on
  Participant Information; the step now names that step. Re-driven: Headshot (type `file`) added
  at the bottom of the Participant Information question list.
- F5 · M4.14 · deferred — FR-AGENDA-9 agenda publish/unpublish is unbuilt, confirmed by source:
  `agenda_published` exists in the schema (`0001_init.sql:38`), the core type and the agenda
  payload (`apps/api/src/routes/agenda.ts:125`) but is never written and never read by the SPA,
  and no publish control exists in `apps/admin/src/agenda`. Implementing it means a PATCH endpoint
  on the event plus a go-live control and published-state affordance on the Agenda header —
  feature work, out of scope for an unattended run. Plan step left as-is; it documents a real gap.
- steps: re-driven M1.1, M1.4, M1.8, M3.6 (all pass)
- quarantine: none
- notes: DB left seeded. `npm run typecheck` and `npm run build` both pass. Four separate commits,
  one per finding.

## 2026-08-09T08:00Z · phase S · iteration 2 · orchestrator
- baseline: server STOPPED first, then seed ok | build ok | typecheck clean | server restarted
  | health 200 | browser-pilot stopped (daemon now picks up the deadline fix)
- changed procedure: the server is now stopped around the build rather than relying on
  wrangler's hot-reload, which crashed it during the iteration-1 fixes.
- quarantine: —
- notes: run id `s-02`. Iteration-1 findings: 2 defects fixed (2a6241e event-timezone date
  formatting, 892c62b Page Heading cap), 2 plan corrections (97520cf, 5794989), 1 deferred
  (M4.14 FR-AGENDA-9 publish/unpublish — unbuilt feature, not fixed by design).

## 2026-08-09T10:08Z · phase S · iteration 2 · runner
- baseline: reset ok (pre-prepared by orchestrator) | build ok | health 200
- outcome: 0 defects, 1 test-plan bug (M1.10), 1 unimplemented (M4.14, known/accepted), 2 turn-cap retries (M1.10, M1.16)
- steps: last step reached = M6.11 — plan complete, S0.1 through M6.11
- quarantine: none
- notes: all four iteration-1 fixes re-proved — M1.1 "Closes Sep 15, 2026" on both the Forms
  list and Dashboard → Today → Submission Forms; M1.4 Page Heading hard-caps at 15 with a
  15/15 counter; M3.6/3.8/3.11/3.12 drove the seeded "Round 1 — Track leads" plan cleanly;
  M1.8 Headshot library field added on Participant Information. M1.10's "Format equals
  Workshop" condition is unreachable — the Logic dialog only offers earlier questions in the
  same step, so Format (Abstract Information) cannot be referenced from Participant
  Information; re-run with Biography and the Conditional chip appeared, so the feature is
  correct and the plan text is wrong. M4.14 re-confirmed: no publish/unpublish control in the
  Agenda header or view bar.

## 2026-08-09T09:10Z · phase S · outcome · orchestrator
- **PHASE S PASSED** — iteration 2 ran the full 75-step plan on a clean baseline with
  0 defects. All four iteration-1 changes re-proved (event-tz dates read "Closes Sep 15, 2026";
  Page Heading clamps to 15/15; the seeded Round 1 plan drives assignment/scoring; Headshot
  adds on Participant Information).
- iterations: 2 of 8. quarantine: — (none).
- flakes: M1.10 and M1.16 both hit the agent turn cap on the first attempt and passed on rerun
  with a raised --max-turns. Agent budget, not app behaviour. No browser-pilot wedges this
  iteration — the deadline fix held.
- TEST-PLAN BUG corrected by the orchestrator: M1.10 asked for a condition "Format equals
  Workshop", but Format lives on a later step and the Logic editor deliberately offers only
  earlier questions on the SAME step ("Only earlier questions can be referenced, so rules can
  never cycle"). FR-FORM-9 is correct; the plan's fixture was wrong. Step now references the
  earlier Biography question and states the constraint.
- deferred to a human: M4.14 · FR-AGENDA-9 agenda publish/unpublish is unbuilt.
- next: phase U (unhappy paths), 63 steps.
