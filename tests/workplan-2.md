# Workplan 2 — eval-loop cycle 1 (baseline 65.5%, 2026-08-10)

Source: `C:\dev\killmysaas-evals\runs\2026-08-09T22-38-01\report.json`.
Loop contract: fix → deploy → rerun areas < 90% adjusted threshold; stop when all pass
or a cycle yields no improvement; ≥4 cycles allowed.

## Baseline scores & adjusted thresholds

| Area | pct | earned/weight | Excluded (not in docs/ spec) | Adjusted denom | Adjusted pct |
|---|---|---|---|---|---|
| call-for-papers | 68.0 | 17/34 | — | 34 | 68.0 |
| abstract-management | 66.1 | 18.5/28 | ABS-03 (w3, dropdown criteria), ABS-14 (w1, AI triage) | 24 | 70.8 |
| speaker-management | 63.3 | 19/33 | — | 33 | 63.3 |
| content-management | 48.2 | 13.5/31 | CNT-11 (w2, version restore — D5 out) | 29 | 46.6 |
| ai-agenda | 73.1 | 9.5/18 | AIA-08 (w1, auto-schedule) | 17 | 55.9* |
| public-widgets | 73.4 | 23.5/34 | — | 34 | 69.1* |

*AIA/EMB judged < full weight; adjusted pct uses full achievable denom (cannot_judge earns 0 until re-run).
Note ABS-01 round dates are NOT in docs/06 (status-only) but are built anyway as a cheap win.

## Root-cause themes

- **A. Grid detail/edit undiscoverable** — row click only toggles checkbox; `rec=` in URL renders
  nothing. Caps CFP-06/09, SPK-02/04/10/11, CNT-05/09/10/12, and burned the turn budget everywhere.
- **B. Evaluation assign dead** — Assign leaves plans at 0 submissions (ABS-05/06/07 chain);
  no reviewer provisioning (CFP-10/11), no reviewer reminders (ABS-09), no round dates (ABS-01).
- **C. Time bugs** — Sessions/Schedule widgets render raw UTC (EMB-16 critical);
  agenda builder day list off-by-one, drops last event day (AIA-01 critical).
- **D. Email dispatch** — decision emails send nothing yet stamp Notified (CFP-14);
  Remind-all hangs at "0/2 queued" forever (CNT-08 fail).
- **E. Missing links** — no add-participant UI on submissions (SPK-11, CFP-13/15, AIA-04
  precondition, EMB speaker plumbing); no track/status on admin create form.
- **F. Form builder** — Required toggle revert race (CFP-01); close date uneditable / Reopen
  no-op; new public submission silently overwrites an existing draft.
- **G. Widget detail depth** — speaker detail/gallery omit bio + session date/room (EMB-05/12/13),
  itinerary cards minimal (EMB-09), speaker-name search dead (EMB-02), day tabs only for
  days-with-sessions (EMB-07 blocked).

## Lanes (cycle 1)

| Lane | Model | Theme | Owns |
|---|---|---|---|
| L1 | opus | A + Speakers reload loop | components/DataList*, DataTabManager*, App.tsx REGION-NAV (view switch/URL/tab wiring) |
| L2 | sonnet (after L1) | E + SPK-15 seed + task status filter | workspace/extras.tsx, App.tsx REGION-TABCONFIG, packages/db/seed/seed.sql |
| L3 | opus | B | api/routes/evaluation.ts, admin/evaluation/*, migrations/0012_* |
| L4 | sonnet | C(widgets) + G | packages/ui/src/widgets/*, publicData.ts, api/routes/landing.tsx |
| L5 | sonnet | C(agenda) | admin/agenda/* only |
| L6 | sonnet | D | api/jobs/bulkJobs.ts, api/routes/messagingAdmin.ts, adminApi decision-email handler. NO App.tsx edits |
| L7 | sonnet | F | admin/forms/*, api/routes/submit.tsx, api SubmitPage/portal form-close paths |

Rules: subagents never commit; tests+typecheck must pass in owned files; App.tsx regions
are exclusive; migration numbering: L3 owns 0012. Orchestrator commits, deploys,
runs migrate:remote (user-authorized), reruns all 6 areas (fresh run dir).
