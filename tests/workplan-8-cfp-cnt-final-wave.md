# Workplan 8 — CFP/CNT final fix wave + eval rerun (handoff)

Prepared 2026-08-10 by the eval-loop agent for a scheduled follow-up agent. Everything below is
self-contained: context, defects, fix guidance, verification chain, and the rerun procedure.

## Context

- Live demo: **https://kms.r-s.workers.dev** (Cloudflare Worker, D1, DEMO_RESET=on, nightly reseed
  09:00 UTC, per-minute job cron). Last deploy `b4e48f70` (commit `164331e`), migrations 0001–0012
  applied remotely.
- Eval harness: `C:\dev\killmysaas-evals` (James's repo — **do not edit it without his OK**, one
  exception listed in step 5). Run reports land in `C:\dev\killmysaas-evals\runs\<timestamp>\report.json`.
- Latest evidence: run `runs\2026-08-10T20-58-42` (killed mid-CNT; **CFP scored 82.4%**, CNT
  unscored). Prior full run: `runs\2026-08-10T16-32-42` (CFP 85.1, CNT 77.6→83.3 adjusted).
- Passing target: **90% adjusted** per area. Adjustments = excluded not-in-spec items removed from
  the denominator; partials earn half weight. Current exclusions: ABS-03 (w3), ABS-14 (w1),
  AIA-08 (w1), **CNT-11 (w2)**. CFP has no exclusions.
- 4 of 6 areas already pass (AIA, EMB, SPK, ABS). This wave is only about **CFP and CNT**.

## The fixes (from the 2026-08-10T20-58-42 judge report)

### 1. MAJOR — Track round-trips to the WRONG track, then vanishes (regression)

Symptom (judge, CFP): submitter saved track "Infra & Serving"; the read-only detail page showed
**"Agents"** (the first seeded track), and later the Track row disappeared from the detail view
entirely.

Where to look:
- `apps/api/src/routes/submit.tsx` — `trackAnswers()`: recently changed to resolve a dropdown
  answer *value* through the question's own options list to a *label*, then match trimmed/lowercased
  against the event's track names. Suspect this resolution picks the wrong candidate or falls
  through to a first-track default somewhere.
- `apps/admin/src/workspace/extras.tsx` — `SubmissionEditForm` has a track/level backfill fallback
  (resolves a raw "Track" answer by name when `track_id` is empty); check it can't mis-assign.
- Same file, `SubmissionDetailPanel`: the answers list filters out `label !== 'track'` (dedup vs the
  canonical column). That filter is why the row *vanishes* when `track_id`/`track_name` is
  NULL/wrong — the canonical Track pair doesn't render and the raw answer is suppressed. Consider a
  fallback: if no canonical track, don't suppress the raw 'track' answer row.
- Diagnose LIVE first, not just in unit tests: previous cycles proved green unit tests ≠ live
  correctness here. Technique: node fetch scripts using the harness auth cookie — see
  "Live diagnosis" below. Create a submission through the real public form picking a non-first
  track, then read `/app/api/submissions/:id/detail` and see what `track_id`/`track_name` stored.

### 2. MAJOR — Form open/close toggle does not persist (close direction)

Symptom: closing "Session Submission Form #2" appears to succeed but reverts to "Open" after
reload. Reproduced 3× by the eval agent. (The *reopen* direction was fixed in an earlier wave —
list button sends `{status:'open', close_at:null}`; the close direction may have the mirror bug,
or a stale-row/index race in the forms list.)

Where to look: `apps/api/src/routes/formsAdmin.ts` (status PUT + any effective-status/`close_at`
derivation) and the forms list UI in `apps/admin/src/App.tsx` / `apps/admin/src/forms/FormBuilder.tsx`.
Note the form was named "…#2" — check the toggle targets the right row and the list refetch isn't
racing. Existing related test: `apps/api/test/forms-reopen.test.ts` (add a close-direction case).

### 3. MAJOR — Decision-email toast contradicts reality (job_id null branch)

Symptom: after Send decisions, UI reported "No decision emails were sent. 1 accepted, 1 declined",
yet the submission later gained a Notified timestamp — so mail WAS queued/delivered. The
"no emails" copy comes from the branch where the API returns `job_id: null`; that branch fired even
though items were queued.

Where to look: `apps/api/src/routes/evaluation.ts` send-decisions handler (when/why `job_id` comes
back null while decisions still enqueue), `apps/api/src/jobs/bulkJobs.ts` (`deliverNow()` inline
delivery), and the toast copy in `apps/admin/src/App.tsx` (search `skipped_no_submitter`). Fix the
API to report truthfully (return the job/queued count whenever anything was enqueued) rather than
just rewording the client.

### 4. MINOR — three small ones (cheap, do if time permits)

- Literal `null` rendered for empty numeric answers on the speaker-facing submission detail
  (portal / `apps/api/src/routes/portal.ts` or the SSR detail in `submit.tsx`). Render blank/em-dash.
- Reviewer sign-in-link **Copy** button always fails (headless clipboard permission). A
  manual-selection fallback already exists; make failure non-scary (select the text + hint) rather
  than an error.
- A newly created review plan has **zero criteria**, so its scorecard can't be saved. Seed one
  default criterion on plan creation (or allow comment-only save).

## Verification chain (run in this exact order before deploying)

From `C:\info\kms`:

1. `npx vitest run` — ~763 tests must pass (workers/ui/unit projects).
2. `npm run typecheck`
3. `npm run build` — the admin build has a STRICTER tsconfig than root; it catches things vitest
   doesn't (`possibly undefined`, `.at()` lib target, etc.).
4. Commit with **explicit `git add <paths>` only — NEVER `git add -A`**. Uncommitted files that must
   stay uncommitted (James's): `tests/workplan-6-theme-editorial.md`,
   `tests/workplan-7-submission-comments.md`, `tests/manual-review-3.md`, `tests/screenshots/*`,
   `docs/Description/`, `tests/e2e-unhappy-run-u08102133.md`, and this file. PowerShell gotcha: do
   NOT put double quotes inside `git commit -m` messages (argument passing breaks silently).
   End commit messages with the standard Co-Authored-By/session trailer.
5. Deploy: `$env:CI='true'; npm run deploy` (CI var suppresses interactive prompts). Raw
   `npx wrangler d1 migrations apply … --remote` is blocked — if a migration is needed use
   `npm run migrate:remote` (explicitly permitted by James). No new migrations are expected for
   this wave.
6. Reseed the demo so the eval starts from clean fixtures:
   `POST https://kms.r-s.workers.dev/demo/reset` (no auth needed; same code path as the nightly cron).

## Live diagnosis technique (recommended for fix 1)

The harness stores Playwright storageState files with a valid `kms_session` cookie:
`C:\dev\killmysaas-evals\.auth\kms.r-s.workers.dev.{organizer,speaker,reviewer}.json`.
A ready-made probe script pattern exists (fetch with that cookie against `/app/api/...`). Keep
probing read-only where possible; if you mutate live data, restore it afterwards. Useful endpoints:
`/app/api/submissions/query` (POST `{from:0,size:50}`), `/app/api/submissions/:id/detail`,
`/app/api/evaluation/overview`.

## Eval rerun

From `C:\dev\killmysaas-evals` (AFTER deploy + reseed):

```
npm run sbek -- run --areas cfp,cnt
```

- Run it in the background; a full 2-area run takes on the order of an hour and a few tens of $.
- `maxTurnsPerScenario` is 150. **CFP-S1 is not stuck when it hits 150 turns** — its checklist is
  simply too large; it has capped in four straight runs while working productively the whole time.
  James was going to be asked about raising the cap to ~200 or splitting the scenario; if he has
  approved it in the schedule request, bump `maxTurnsPerScenario` in the harness config to 200,
  otherwise leave the harness untouched and accept the CFP-S1 partials.
- Do NOT `--resume runs\2026-08-10T20-58-42` — its CFP evidence predates these fixes; a fresh run
  is required.
- When the report lands, read `runs\<ts>\report.json`, compute adjusted scores (CNT: exclude
  CNT-11 w2 from the denominator; partial = half weight), and quality-check the run (coverage,
  judge reasoning depth, screenshot citations, unexplained verdict flips) — James wants each run
  sanity-checked since his token optimisation.
- Success = CFP and CNT ≥ 90% adjusted. If below, list remaining defects with judge quotes and stop
  for James rather than looping again — this is intended as the final wave.
