# Workplan 4 — eval-loop cycle 3 fixes (CFP 84.8 / ABS 80.4 / SPK 86.7, 2026-08-10)

Source: `runs\2026-08-10T11-45-32`. Exclusions: ABS-03 (w3), ABS-14 (w1).

## Defect clusters

1. **Evaluation persistence trio (critical+2 major, ABS-07 fail, unlocks CFP-11)**:
   anonymise checkbox reverts on refetch AND reviewer view still shows names;
   reviewer-pool removals don't persist; "Send sign-in link" for reviewer X shows the
   ORGANIZER's link instead.
2. **Forms status duality (major+minor)**: Reopen "sometimes" reverts on next load;
   admin Status reads Open when close date past (two uncoordinated controls);
   submission cap counts drafts/withdrawn (blocked the agent at 3).
3. **Contacts hygiene (major+minors)**: CSV import creates duplicates instead of
   merging by email; no social-link fields organizer-side (portal captures them);
   speaker detail doesn't list sessions; nameless cfp-preview-tester contact pollutes
   roster + Speakers preset; demo login says ada@ but session is Priya.
4. **Small UX (minors)**: task definitions read-only (no due-date edit); public form
   participant role dropdown only 'speaker' (organizer has Co-Speaker); Level blank in
   organizer edit form; dashboard Recent Submissions missing Track; one bulk-email
   recipient stuck 'queued' with no retry/error.

Agent-coverage gaps needing no fix (should clear on rerun): CFP-16 (turn cap),
SPK-10/CFP-09/CFP-05-06 halves (organizer never inspected sandbox event).

## Lanes

| Lane | Model | Cluster | Owns |
|---|---|---|---|
| O1 | opus | 1 | api evaluation.ts, admin evaluation/*, review/ReviewerWorkspace.tsx |
| O2 | sonnet | 2 | api formsAdmin.ts, admin forms/*, submit.tsx (cap/close regions only) |
| O3 | sonnet | 3 | adminApi.ts import region, App.tsx speakers-tab region, seed.sql, landing.tsx demo-login region |
| O4 | sonnet | 4 | App.tsx tasks-tab region, workspace/extras.tsx + TaskCreateForm.tsx, packages/ui SubmitPage.tsx role region, outbox stuck-queued investigation |

Rules: no lane commits; UTF-8; region splits as noted; orchestrator integrates,
commits, deploys; rerun (CFP/ABS/SPK + EMB/CNT re-verify) after tomorrow's 09:00 UTC
automatic reseed.
