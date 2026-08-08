# E2E High Level Strategy

The driver for a long, unattended test-and-fix run. The orchestrator (main agent) never drives
the browser itself — it runs the loop below, delegating each run and each fix to a subagent, and
keeping its own context small so the run can last hours.

Use **browser-pilot** for preference. If a step breaks repeatedly in a way that looks like the
tool rather than the app (agent stalls, daemon wedged, selector never resolvable), fall back to
**agent-browser** for that step and note the fallback in the journal.

---

## 0. Ground rules that make the run unattended

These are the difference between a loop that runs for hours and one that hangs at 03:00.

**Sequential only.** One dev server, one D1 database, one browser profile. Never run two test
subagents, or a test and a fix subagent, at the same time. Fan-out corrupts shared state and
produces failures that cannot be reproduced.

**Every iteration starts from a clean baseline.** The test plans mutate data (bulk accept,
scheduling, profile edits), so a second pass over a dirty database produces false failures.
Before each test subagent launches, the orchestrator runs:

```sh
npm run migrate:local
npm run seed:local          # idempotent: deletes the demo org/event, reinserts fixed uuids
npm run build               # includes tsc --noEmit on the admin SPA
# restart wrangler dev, then wait for /health to return 200
browser-pilot stop --all    # no stale daemon, no logged-in profile carried over
```

The rebuild is not optional: `npm run dev` builds the SPA and public bundles once and then
serves them as static assets. A fix subagent's edit to `apps/admin` or `apps/public` is invisible
to the browser until the build re-runs, so skipping it makes the next iteration re-find the bug
that was just fixed — the classic infinite loop.

**Each iteration gets a fresh run id.** `RUNID = <phase>-<iteration>` (e.g. `p-03`). The test
subagent passes it to `browser-pilot note` and prefixes every record it creates, per
[docs/14 §S0](../docs/14-e2e-browser-test.md). Records from earlier iterations are then never
mistaken for this one's.

**The journal is the memory, not the context window.** Every subagent appends to
`tests/e2e-journal.md`; the orchestrator reads only the tail. A run that is interrupted resumes
by reading the journal — see §5.

---

## 1. Phases

Run in order. Each phase is the same loop (§2) over a different test plan.

| Phase | Plan | Build the plan first? |
|---|---|---|
| **P — Primary** | [`docs/14-e2e-browser-test.md`](../docs/14-e2e-browser-test.md) | No, it exists |
| **S — Secondary** | `tests/secondary-flow-e2e.md` | Yes — §4 |
| **U — Unhappy paths** | `tests/unhappy-paths-e2e.md` | Yes — §4 |
| **R — Regression** | Primary plan, once, no fixing | No |

Phase R exists because fixes made in S and U can break what P proved. It runs the primary plan
one final time end-to-end; any failure it finds is reported, not auto-fixed (the run is over —
a fix at that point deserves a human).

Phases advance only on the exit conditions in §2. A phase is never skipped because it looks
slow; it is skipped only if its predecessor ended in `HALTED`, in which case the whole run stops.

---

## 2. The loop (identical in every phase)

```
iteration = 0
while true:
    iteration += 1
    if iteration > MAX_ITERATIONS: record HALTED(iteration cap); stop phase
    if elapsed > PHASE_TIME_BUDGET: record HALTED(time); stop phase

    reset baseline (§0)
    findings = run test subagent (§2a)

    if findings is empty and the plan ran to completion:
        record PHASE PASSED; advance to next phase
    if findings is empty and the plan did not complete:
        record HALTED(runner could not proceed); stop phase

    run fix subagent (§2b) on the findings
    # loop back — the next iteration re-runs from the top of the plan and
    # re-proves the fixed steps as a side effect
```

**Budgets** — the orchestrator holds these; they are what bound an unattended run:

| Knob | Default | Meaning |
|---|---|---|
| `MAX_ITERATIONS` | 8 per phase | Hard stop on the test/fix cycle |
| `PHASE_TIME_BUDGET` | 90 min | Wall clock per phase |
| `RUN_TIME_BUDGET` | 6 h | Wall clock for all phases; on breach, finish the current iteration and stop |
| `ERROR_BATCH` | 5 | Confirmed defects a test subagent collects before returning |

Overrunning a budget is a normal, recorded outcome — `HALTED` with the reason — not a failure to
retry. The run then moves to the final report (§6).

### 2a. Test subagent

> Run the test plan `<plan>` starting at `<resume point>`. Stop and return when you have
> collected **5 confirmed defects** or the plan is complete, whichever comes first.

Rules it must follow:

- Execute steps **in plan order**. The plans are cumulative and gated: if a gate step fails
  (S0.3 admin login, M1.3 conditionals, M1.8 routing), stop immediately and return — everything
  after it is blocked, and reporting fifty blocked steps as defects wastes the fix budget.
- Classify every failure before counting it:
  - **DEFECT** — the app contradicted the expectation. Counts toward the batch of 5.
  - **TEST-PLAN BUG** — the app is right and the plan's expectation, selector or fixture is
    wrong. Does *not* count toward the batch; record it and continue.
  - **ENVIRONMENT** — server down, seed missing, browser-pilot infra error (exit code 2).
    Return immediately with this classification; the fix subagent must not be run.
  - **FLAKE** — retry the step once, from a fresh `browser-pilot open`. If it passes, record it
    as a flake and continue. If it fails identically, it is a DEFECT.
- One assertion per `do`. Screenshot on every failure before moving on.
- Never edit application or test-plan files. Reporting only.
- Return: the ordered findings, each with plan step id, classification, expected, observed,
  the browser-pilot report text, screenshot path — plus the last step reached, so the next
  iteration can resume.

### 2b. Fix subagent

> Fix these findings. Do not touch anything else.

Rules it must follow:

- **Minimal diff.** Fix the named defect at its cause. No refactors, no drive-by improvements,
  no reformatting.
- **Never edit a test plan to make a test pass** — except for a finding classified TEST-PLAN
  BUG, where correcting the plan *is* the fix. Say so explicitly in the journal entry.
- **Verify before returning:** `npm run typecheck`, `npm run build`, then re-drive the specific
  failing steps with browser-pilot to prove the fix. A fix that was not re-driven is reported as
  `unverified`, and the orchestrator treats it as unfixed.
- **One commit per finding**, message referencing the plan step id (`fix(M4.5): …`). Discrete
  commits are what make a bad fix revertable at 3am without unpicking four others.
- If a finding cannot be fixed within a reasonable attempt, return it as `deferred` with the
  reason rather than half-fixing it.

### 2c. Circuit breaker — the thing that stops infinite loops

The orchestrator keeps a **quarantine list**, in the journal, keyed by plan step id.

- A step that produces a DEFECT in **two consecutive iterations** goes into quarantine: it is
  reported as an unresolved defect, excluded from the batch count, and skipped by later test
  subagents in this run.
- A step whose fix was applied and which then fails **differently** is not quarantined — that is
  progress — but the third distinct failure at one step quarantines it regardless.
- If quarantine reaches **5 steps**, the phase ends as `HALTED(quarantine)`. Five stuck steps
  means something systemic, and burning three more hours on it helps nobody.

Without this rule the loop as originally written can cycle forever on a single unfixable step.

---

## 3. What counts as done

| Phase outcome | Meaning |
|---|---|
| `PASSED` | The plan ran to completion with zero DEFECTs, on a clean baseline |
| `PASSED WITH QUARANTINE` | Ran to completion; some steps quarantined and reported |
| `HALTED(reason)` | Iteration cap, time budget, quarantine cap, environment failure, or a gate that never cleared |

A phase is **not** done because "five errors were fixed". It is done when a full pass finds
nothing new. That is why the loop re-runs the whole plan each iteration rather than only the
failed steps — cheap insurance that a fix did not break an earlier step.

**Stage P (Speed)** in the primary plan is measurement, not pass/fail. Budget misses are
recorded as findings in the report and never enter the fix loop — a perf regression fixed blind
by a subagent at 4am is worse than a documented number.

---

## 4. Building the Secondary and Unhappy-path plans

Both are written **before** their phase begins, by a single subagent, in the shape of
`docs/14-e2e-browser-test.md`: milestone sections (M1…M6), one numbered step per row, one
assertion per `do`, an explicit expectation, and the requirement id it covers.

- `tests/secondary-flow-e2e.md` — the main *feature* behaviour per milestone that the primary
  plan's demo path does not touch: form builder editing (drag reorder, required toggles, locked
  fields, field library), draft save/resume, portal forms and file requests, evaluation plan and
  criteria configuration, multi-round scoring, agenda Week/Month/Rooms views and filtering,
  publish/unpublish, dashboard tabs, settings and library CRUD.
- `tests/unhappy-paths-e2e.md` — the important error cases per milestone: expired and reused
  magic links, submission over the per-user limit, submitting after close date, validation
  failures on every required field type, conditional logic hiding a required field, upload of a
  rejected file type or oversize file, concurrent edit conflict (`expected_updated_at` → 409),
  scheduling outside event dates, capacity over room capacity, reviewer conflict-of-interest
  skip, permission denials across roles, and duplicate-send idempotency.

Both must reuse the §S0 fixtures and the `RUNID` convention rather than inventing new ones, and
must state the same reporting contract (pass / fail / **blocked** / N-A) as the primary plan.

---

## 5. Journal & resume

`tests/e2e-journal.md` is append-only. Every entry:

```
## <ISO timestamp> · phase <P|S|U|R> · iteration <n> · <runner|fixer>
- baseline: reset ok | build ok | health 200
- outcome: <findings count> defects, <n> test-plan bugs, <n> flakes
- steps: last step reached = <id>
- quarantine: <ids>
- notes: <one or two lines>
```

To **resume** an interrupted run: read the journal tail, take the last phase, iteration and
quarantine list, reset the baseline, and re-enter the loop at §2. Never resume mid-iteration
against a dirty database — always reset first.

---

## 6. Final report

When the run ends (all phases complete, or a budget breach), produce:

1. Phase-by-phase outcome table with iteration counts and wall clock.
2. Every defect fixed, with its plan step id and commit sha.
3. Every quarantined and deferred defect — the human's to-do list.
4. Every TEST-PLAN BUG corrected, so the plans' drift is visible.
5. Stage P speed numbers as measured, with origin and build mode named.
6. Flake list — steps that needed a retry, as a stability signal.

Report faithfully. A run that halted in phase U with three quarantined steps is a useful result;
a run reported as green when a gate never cleared is worse than no run at all.
