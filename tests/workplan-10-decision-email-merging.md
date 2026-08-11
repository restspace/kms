# Workplan 10 — Per-speaker decision email merging

Status: **not started.** Scoping document, not a change log.

Today `expandSendDecisions` emails **per submission**: a speaker with three
submissions and mixed outcomes gets three separate emails — one accept, two
declines — in arbitrary order, potentially in the same minute. This is the
documented PaperCall/pretalx embarrassment (mixed-outcome speakers getting
contradictory-feeling mail). This plan makes the decision flush
**speaker-shaped**: one email per speaker per batch, accepts listed first, with
an honest "still under review" line for their undecided submissions and an
organiser-facing pre-flight that surfaces incompleteness before send.

**Timing principle (decided in discussion, 2026-08-11):** no scheduler, no
debounce window. The existing queue-then-flush design — decisions accumulate in
`accept_queue`/`decline_queue` until the organiser clicks *Send decisions* — is
already the timing mechanism. Merging happens at flush time over whatever is
queued. Late decisions are just a later batch.

## 1. Decisions already taken

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | Group at flush time by `submitter_contact_id`; one email per speaker per batch, accepts before declines | No new state machine; a speaker in two separate flushes still gets two emails (correct — they are separate batches) |
| D2 | No debounce / settling window / "wait until all decided" automation | Avoids cron-dependent latency (`wrangler dev` never fires crons — see memory note), unpredictable send timing, and the stalled-submission-blocks-everything failure mode |
| D3 | Pre-flight, not silent resolution: if a speaker in the batch has *other* undecided submissions, tell the organiser before the job is created and let them choose send-now vs hold | Send-now is the default; the email carries a "still under review" line. Hold simply excludes that speaker's ids from this send — their rows stay in the queue states, visible as "staged" on the dashboard (`dashboard.ts:278`), so held state can't be silently forgotten |
| D4 | `notified_at` stays per-submission; the status flip (`accept_queue → accepted`) stays the primary idempotency gate | The merged email stamps `notified_at` on every submission it covers. A re-run finds no queue-state rows and is a no-op, exactly as today |
| D5 | One `message_log` row per merged email (it *is* one email), keyed on the sorted covered-submission ids — not one row per submission | Keying on the set is safe **because** flips are conditional and precede queueing: a retry never rebuilds the same group differently, it finds the rows already flipped and skips (parity with today's per-submission crash window at `bulkJobs.ts:190-196`) |
| D6 | Speakers with exactly **one** decision in the batch keep the existing `decision_accepted` / `decision_declined` templates untouched | The common case has zero copy or snapshot churn; only multi-decision speakers get the new template |
| D7 | Recipients stay **submitter-only** this wave; co-speakers in `submission_participants` remain un-notified | Deliberate, recorded — not an oversight. Portal access is submitter-keyed, and adding co-speaker recipients interacts with grouping (a co-speaker on two different submitters' talks). Log as an open question in `docs/13-open-questions.md` |

## 2. Current mechanics (what the change hangs off)

- **Expander:** `expandSendDecisions`, `apps/api/src/jobs/bulkJobs.ts:143-261`.
  Per submission: conditional status flip → optional reviewer-feedback gather →
  `queueTemplated` (`decision_accepted`/`decision_declined`, `entityId = s.id`)
  → `notified_at = COALESCE(notified_at, ts)` on `queued|duplicate` →
  `deliverNow` inline (the CFP defect fix — keep this).
- **Route:** `POST /submissions/send-decisions`,
  `apps/api/src/routes/evaluation.ts:239-`: validates ids, computes
  `accepted/declined/skipped/skipped_notified/skipped_no_submitter` counts,
  inserts the `bulk_jobs` row, returns counts + `job_id`.
- **Admin UI:** `runBulk('send_decisions')`, `apps/admin/src/App.tsx:1846-1928`:
  fires the POST, builds the skipped-note copy, polls via `pollDecisionJob`,
  handles timeout/stuck-job.
- **Templates:** `packages/email/src/render.ts:135-147`; `{{reviewer_feedback}}`
  is the precedent for a prerendered multi-line block variable ("unknown/absent
  variables render as ''").
- **Dedupe key:** `message_log` key `<template>:<contact>:<entity>:v<version>`
  (`bulkJobs.ts` header comment, `mailer.ts`).
- **Accept side-effect:** `autoAssignAcceptTasksCore` runs per accepted
  submission (`bulkJobs.ts:243`) — unchanged; it is per-submission by nature.

## 3. Expander changes (`bulkJobs.ts`)

New shape of `expandSendDecisions`:

1. **Select with grouping order.** `ORDER BY s.submitter_contact_id, s.id`
   instead of `ORDER BY s.id`.
2. **Tick-boundary rule.** The per-tick `LIMIT` can split a speaker's group
   across ticks, which would silently produce two emails — the exact bug this
   plan exists to kill. Rule: after applying the limit, **drop the trailing
   incomplete group** (its rows stay queued; the next tick picks the whole
   group up), *unless* the group alone is ≥ the limit, in which case process it
   whole (a speaker with 50 submissions must not deadlock the job). Detect
   "incomplete" by over-fetching `LIMIT ?+1` and checking whether row `limit+1`
   shares the last row's contact id.
3. **Per group:** conditionally flip every row (as today, per row); collect the
   flipped subset. If empty, continue.
4. **Null-contact fallback.** `submitter_contact_id IS NULL` (admin-created
   rows) or `submitter_email IS NULL`: keep today's behaviour exactly — flip,
   no email, no `notified_at` (CFP-14 rule). Never group NULL contacts together.
5. **One email per group:**
   - **1 flipped row** → existing template + context, byte-for-byte today's
     email (D6). Same `entityId = s.id`, same log key → `duplicate` handling
     unchanged.
   - **≥2 flipped rows** → new `decision_summary` template (§5) with a
     prerendered `{{decisions_block}}` (accepts first, then declines; title +
     code + outcome per line; per-submission reviewer feedback nested under its
     submission when `include_feedback`), and `{{pending_note}}` when the job
     params say so (§4). `entityId` = `batch:` + sorted flipped ids joined —
     the D5 key. Contact id in the key gives per-speaker dedupe as before.
6. **Stamp `notified_at`** on every flipped-and-covered submission on
   `queued|duplicate`, unchanged semantics.
7. **`deliverNow`** per queued payload, as today.
8. Progress counting (`enqueued` = flipped submissions, not emails) unchanged —
   the UI copy already speaks in submissions processed.

`include_feedback` handling moves inside the group loop (one query per
submission as today is fine at these volumes).

## 4. Route changes (`evaluation.ts`)

`POST /submissions/send-decisions` gains two request fields:

- `preflight: true` — compute and return, **without creating a job**:
  the existing counts *plus* `speakers_with_pending`: for each distinct
  submitter among the queued selection, the count and titles (max 3, then "+N")
  of their *other* submissions in undecided states — status **not in**
  (`accepted`, `declined`, `withdrawn`) and **not** part of the current queued
  selection. `draft` counts as pending (an unsubmitted draft is still "under
  review" from the speaker's POV is arguable — decide: **exclude `draft`**;
  a never-submitted draft shouldn't hold a decision email).
- `hold_contact_ids: string[]` (optional) — the expander's select adds
  `AND (s.submitter_contact_id IS NULL OR s.submitter_contact_id NOT IN (…))`;
  route response reports `held` count so the toast can say so. Held rows stay
  in queue states — no new status, no new table.
- `pending_note: boolean` (default `true`) — stored in `params_json`, controls
  `{{pending_note}}`.

The pending-note text needs the pending submissions **at send time**, not
pre-flight time — the expander re-queries the speaker's pending titles when
building the context (they may have changed between click and tick).

## 5. Template (`packages/email/src/render.ts` + seed)

New key `decision_summary`, same variable style as the rest:

- Subject: `Your {{event.name}} submissions — decisions`
- Body: greeting, `{{decisions_block}}` (prerendered HTML, accepts first),
  `{{pending_note}}` (prerendered, e.g. `<p>Your submission
  <strong>Title</strong> (CODE) is still under review — we'll be in touch.</p>`,
  or '' when off/none), portal-URL button (any accept in the batch ⇒ show the
  onboarding-tasks line from `decision_accepted`; declines-only ⇒ the softer
  `decision_declined` sign-off).
- Register wherever templates are enumerated for the organiser-editable
  `email_templates` surface (check `EmailTemplatesCard.tsx` + seed row pattern
  at `packages/db/seed/seed.sql:636`) so the disable-toggle and copy-editing
  behave like the other decision templates. `template_disabled` for
  `decision_summary` must skip the email but **not** stamp `notified_at`
  (same rule as today, `bulkJobs.ts:222-227`).

Nice-to-have (small, do last): a `{{followup_note}}` — "Following our earlier
decisions on your other submissions…" — rendered when any of the speaker's
*other* submissions already has `notified_at` set. One query per group, one
template line.

## 6. Admin UI (`App.tsx`)

`runBulk('send_decisions')` becomes two-step:

1. POST with `preflight: true`. If `speakers_with_pending` is empty → POST for
   real immediately (no extra click; today's flow, today's toasts).
2. Otherwise show a confirm dialog (follow the existing dialog pattern used by
   the agenda Move dialog rather than inventing one): "N speaker(s) in this
   batch have other submissions still under review", listing speaker name +
   pending count, with three actions:
   - **Send all now** — emails carry the still-under-review line (default,
     primary button);
   - **Hold those speakers** — resend POST with `hold_contact_ids`; toast
     appends "; N speaker(s) held — their decisions stay staged";
   - **Cancel.**
3. Toast copy: extend `skippedNote` with the held count; the existing
   skipped/no-submitter/poll/timeout handling is untouched.

## 7. Tests

Unit (`apps/api/test/decision-email-merging.test.ts`, follow the style of the
existing bulk-job tests):

1. Speaker with 2 accepts + 1 decline queued → **one** email; body lists
   accepts before the decline; `notified_at` stamped on all three; one
   `message_log` row with the batch key.
2. Speaker with exactly one queued decision → `decision_accepted` template,
   `entityId = s.id`, key identical to pre-change (regression pin).
3. Re-run of the same job / re-POST of the same ids → 0 emails, statuses
   already flipped, `notified_at` unchanged (idempotency).
4. `hold_contact_ids` excludes that speaker's rows: statuses remain
   `accept_queue`/`decline_queue`, no email, response `held` count correct.
5. Preflight: returns `speakers_with_pending` correctly; drafts and withdrawn
   excluded from "pending"; creates **no** `bulk_jobs` row.
6. `pending_note: true` + speaker has one pending submission → note rendered
   with that title; `pending_note: false` → ''.
7. Null submitter contact / null email inside a batch: flipped, skipped, no
   `notified_at`, and does **not** poison the grouping of real contacts.
8. Tick-boundary: limit splits a 3-submission speaker → trailing incomplete
   group deferred whole to the next tick; exactly one email total across ticks.
9. `include_feedback` on a merged email nests each submission's non-CoI
   comments under the right submission.
10. `decision_summary` disabled in `email_templates` → no email, no
    `notified_at`, statuses still flip (parity with existing rule).
11. Accept-side task auto-assign still fires once per accepted submission in a
    merged group.

Manual/E2E (append a scenario to `tests/unhappy-paths-e2e.md` when run):
mixed-outcome speaker + pending third submission, exercise both dialog paths,
verify the held speaker's rows show as staged and a later send releases them
in one email.

## 8. Sequencing

1. **Wave A — expander grouping + templates + tests 1-3, 7-11.** Ships the
   core fix; the route/UI still send everything (no preflight yet), which is
   already strictly better than today.
2. **Wave B — preflight + hold + dialog + tests 4-6.** UI-visible; do after
   Wave A settles so the dialog is testable against real grouping.
3. **Wave C (optional) — `{{followup_note}}`, docs/08 + docs/06 updates,
   `docs/13-open-questions.md` entry for co-speaker notification (D7).**

## 9. Out of scope

- Any scheduler, debounce, or "auto-send when a speaker's set completes" (D2).
- Notifying `submission_participants` co-speakers (D7 — open question).
- Per-speaker (rather than per-batch) hold UI granularity — batch-level
  hold-them-all is enough for v1; the dialog lists names so the organiser can
  instead uncheck rows in the grid if they want finer control.
- AI-drafted personalised feedback (separate feature; see the slop-triage
  discussion — it would slot into `{{reviewer_feedback}}` later without
  touching this grouping work).
