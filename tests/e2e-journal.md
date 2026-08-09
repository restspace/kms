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
