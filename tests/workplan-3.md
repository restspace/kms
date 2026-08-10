# Workplan 3 — eval-loop cycle 2 fixes (EMB 88.2 / AIA 77.8 / CNT 61.1, 2026-08-10)

Sources: `runs\2026-08-10T07-23-57` (EMB+AIA), `runs\2026-08-10T08-01-37` (CNT).
All three areas < 90% adjusted threshold → fix wave, then rerun (ON HOLD until user
confirms — they are working on the e2e tester).

## Scoreboard vs baseline

| Area | Baseline | Cycle 2 | Threshold notes |
|---|---|---|---|
| public-widgets | 73.4 | 88.2 | needs ≥90; EMB-15 saved-embeds sub-gap excluded (docs/11 deferred list) |
| ai-agenda | 73.1 | 77.8 | AIA-08 excluded (auto-schedule, w1); AIA-04 is the blocker |
| content-management | 48.2 | 61.1 | CNT-11 excluded (version restore); CNT-S3 hit 150-turn cap |

## Root causes this cycle

1. **Detail tab is a dead end** (AIA-04 major, CNT-12, CNT-01-adjacent): everything L2
   built (participant picker, content_approved, track/status) lives in the edit form,
   but the primary click path opens `SubmissionDetailPanel` — read-only, no Edit button,
   empty Participants section with no add control.
2. **Task create is definition-vs-assignment mismatch** (CNT-01 critical, CNT-07): POST
   /tasks creates a definition; the grid lists assignments; manual mode + no assignee
   picker → 0 rows → looks like a silent failure. docs/05 create dialog includes
   Type (Contacts/Groups/Submissions) targeting.
3. **Remind-all completes but sends 0** (CNT-08): L6 fixed the hang; live run now ends
   "0 reminders sent" — every snapshot id is being disqualified at expansion time.
4. **Widget depth round 2** (EMB-01/05/13/15): bio never renders on speaker detail or
   gallery modal (data plumbing or seed gap); no session drill-down/Show-more; embed
   builder data formats hardcoded to /agenda.json; agenda grid blocks clip each other.
5. **Small**: sidebar event range shows exclusive end date (May 12–15 for a 12–14
   program); bulk ZIP export has no feedback toast; organizer speaker-edit has no
   headshot control (CNT-10 half).

## Lanes (cycle 2)

| Lane | Model | Fixes | Owns |
|---|---|---|---|
| M1 | opus | 1 | workspace/extras.tsx, App.tsx submissions-tab region only |
| M2 | opus | 2 | App.tsx task region (schema/create/config), adminApi.ts tasks region, api tests |
| M3 | sonnet | 3 | bulkJobs.ts, adminApi.ts remind/bulk-jobs regions, dashboard/DashboardSection.tsx |
| M4 | sonnet | 4 + headshot render | packages/ui/src/widgets/*, landing.tsx, admin embeds section, seed.sql (bios/headshots) |
| M5 | haiku | 5 (date + ZIP toast) | App.tsx sidebar region, DataTabManager.tsx bulk-bar region |

Rules: no commits by lanes; UTF-8 only; App.tsx and adminApi.ts are region-split as
above; orchestrator integrates, commits, deploys; eval rerun only after user go-ahead.
