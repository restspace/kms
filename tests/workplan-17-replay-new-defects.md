# Workplan 17 — New defects from the fresh-eyes replay run

Source: `C:\dev\killmysaas-evals\runs\2026-08-13T07-49-54-vs4rrx` (Sonnet fresh-eyes replay of
run 2026-08-12T23-01-47-hwil15), cross-referenced against `tests/eval-run-2026-08-13-issues.md`.
Scope: the 14 findings NOT already covered by workplan 16 and NOT replay artifacts.
Excluded (replay artifacts / needs manual re-check, do not fix blind): reopened-CFP 404,
participant autocomplete `contact_not_found`, "Speakers — 0" audience, count-badge vs row
mismatches, CSV import event-scope modal (deliberate design).

Execution model: parallel subagents in waves, disjoint surfaces per wave (App.tsx and
workspace/ are the contention hotspots — only one agent per wave may touch them). Agents fix,
add targeted tests, typecheck; they do NOT commit. Integration, full test run, and commit
happen inline at the end. Deploy remains blocked on 0040/0041 remote migrations.

## Wave 1 — 4 parallel agents

| Agent | Items | Primary surface |
|---|---|---|
| eval-editor | **#1 (major)** criteria created for a new round ("Final Review") are appended to the previous round's ("Initial Review") scorecard, duplicating "Comments" and mangling both lists; **#2** criteria editor accepts duplicate criterion names on one scorecard with no warning | apps/api/src/routes/evaluation.ts + apps/admin/src/evaluation |
| agenda-settings | **#3** settings audit trail records nothing for room/track add/delete ("No settings edits recorded" after changes); **#13** room deletion is destructive with a lightweight confirm and no undo; **#14** Agenda page keeps operating on one event while the sidebar event filter reads "All events" (scope desync) | apps/admin/src/agenda, apps/admin/src/settings, apps/api/src/routes/agenda.ts, eventScope.tsx |
| public-portal | **#4** public CFP wizard exposes internal fields to submitters (Client Session ID, CEU Credits, Capacity) — respect/introduce an internal/audience flag, don't hardcode names; **#9** speaker-portal Biography textarea renders raw `<p>…</p>` HTML; **#5** embed sessions widget shows "No sessions are scheduled yet." when a track *filter* merely matches nothing — say "no sessions match this filter" | apps/api/src/routes/submit.tsx, portal.ts, embed.ts + public clients |
| dashboard | **#6** dashboard Events table shows an event ending a day late (May 12–15 vs actual May 12–14; likely exclusive-end or TZ rendering); **#8** "Asset completeness" shows green "Every accepted speaker has a bio, headshot and slides" when there are 0 accepted speakers — needs a neutral empty state | apps/api/src/routes/dashboard.ts + apps/admin/src/dashboard |

## Wave 2 — 2 parallel agents (workspace surfaces freed)

| Agent | Items | Primary surface |
|---|---|---|
| workspace-files | **#10** contact/speaker edit form lacks Company and Job title even though both are roster columns; **#11** opening a file from the Files library creates a "Detail: headshot.png" tab but the main pane keeps rendering the Submissions list | apps/admin/src/workspace, App.tsx (sole owner this wave), apps/api/src/routes/filesAdmin.ts |
| crm-messaging | **#7** pipeline kanban columns overflow the viewport with no horizontal scroll affordance (Declined column off-screen); **#12** bulk send finishes with mixed per-recipient states (queued/sent/failed) and no aggregate result summary in the composer | apps/admin/src/crm, apps/api/src/routes/messagingAdmin.ts + compose UI (avoid App.tsx) |

## Wave 3 — integration (inline, no subagents)

1. Full monorepo typecheck + test suite; fix fallout.
2. Single commit (no deploy — deploy still waits on 0040/0041 `migrate:remote`).
3. Update memory + this file with outcomes.
