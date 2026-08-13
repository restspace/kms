# Workplan 16 — Fix eval-run issues + Airtable settings UI

Source: `tests/eval-run-2026-08-13-issues.md` (run 2026-08-12T23-01-47-hwil15, 92.2%).
Scope: all product defects #1–#30 plus a new feature — Airtable sync configurable from the
Settings page. Excluded: #26 (fixture text in demo seed data — content hygiene, not code),
#31 and the "coverage gaps" section (manual-check candidates, not defects).

Execution model: parallel subagents in waves. Waves are partitioned so agents in the same
wave touch disjoint files (App.tsx and adminApi.ts are the contention hotspots). Agents fix,
add targeted tests, and typecheck; they do NOT commit or deploy. Integration, full test run,
commit, deploy and remote migrations happen inline at the end.

## Wave 1 — 5 parallel agents (disjoint surfaces)

| Agent | Model | Issues | Primary surface |
|---|---|---|---|
| speaker-forms | fable (inherit) | #2 Edit clears Status, #3 inline Status dropdown loses update, #4 social links not repopulated, #5 custom field never on form, #16 Status absent from create/Edit, #25 panels stuck "Loading…" | admin SPA speaker forms/detail + adminApi.ts speaker endpoints |
| reviewer-eval | sonnet | #1 event-switcher forbidden dead-end, #11 cross-round discussion bleed, #17 reviewer credential path, #24 round date auto-save, #30 participant role vocabulary | evaluation.ts + reviewer UI |
| agenda | sonnet | #20 auto-place picks 6:00 AM, #21 "+ Add room" instant live placeholder, #22 double-booking only warns | apps/admin/src/agenda + agenda.ts |
| public-portal | sonnet | #12 bio not joined portal↔submission, #23 "Untitled form" heading, #27 .ics no feedback, #28 empty session card | portal.ts, submit.tsx, embed/public clients |
| content-files | sonnet | #7 "Remind all outstanding (3) → 0 sent", #9 files not associated with sessions, #18 global file-collection setting, #29 Track select shows "— No track —" | filesAdmin.ts, chase/tracking, dashboard.ts |

## Wave 2 — 3 parallel agents (surfaces freed by wave 1)

| Agent | Model | Issues | Primary surface |
|---|---|---|---|
| messaging | sonnet | #8 Preview-as never loads, #14 Declined-speakers audience preset, #19 template picker in compose | messagingAdmin.ts + compose UI |
| org-crm | sonnet | #6 "record no longer exists" + inconsistent event linkage, #10 bulk send logged to wrong event, #13 near-duplicate import warning, #15 directory multi-select → email | crmAdmin.ts + directory UI |
| airtable-settings | fable (inherit) | NEW: Settings-page Airtable config — store enabled flag + API key + base ID in D1 (org settings, migration 0040+), sweepAirtableSync reads DB config with env fallback, test-connection button, key masked in UI | jobs/airtableSync.ts, packages/airtable, settings UI, migration |

## Wave 3 — integration (inline, no subagents)

1. Full monorepo typecheck + test suite; fix fallout.
2. Single commit; deploy to kms.r-s.workers.dev; `migrate:remote` (0032–0038 already pending
   there per memory, plus any new migration from airtable-settings).
3. Post-deploy smoke: publish-gate untouched, reminder button, Airtable settings page loads.
4. Update memory + this file with outcomes.
