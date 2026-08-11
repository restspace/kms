# Unhappy Paths E2E — run u08102133 (2026-08-10)

Plan: tests/unhappy-paths-e2e.md · base http://localhost:8787 · session `unhappy`
Preconditions: dev server already running, DB seeded (3 named form fixtures verified), DEV_MODE=on.

| Step | Result | Observed |
|---|---|---|
| S0.1 | PASS | /health 200 `{"ok":true,"service":"kms"}` |
| S0.2 | PASS | fetch_source /app/api/me no cookie -> 401 `{"error":"unauthenticated"}` |
| S0.3 | PASS | admin shell reached; sidebar Dashboard/Workspace/Forms/Evaluation/Review/Agenda/Embeds/Settings |
| M1.1 | PASS | Empty Submission step -> `Title is required`, `Description is required`, `Format is required`, `Tags is required`, `Track is required` |
| M1.2 | PASS | 292-char title -> `Title exceeds 255 characters`, counter in over state (292/255) |
| M1.3 | PASS | Format=Workshop shows required `Room Setup Requirements`; Format=Talk removes it from the DOM |
| M1.4 | PASS | Hidden required question neither blocks nor appears in the Review summary |
| M1.5 | PASS* | Blocked correctly, but wording differs from plan: `Please fix the highlighted participant fields.` + inline `First Name is required` (plan expected `Every participant needs a first name, last name and email.`) |
| M1.6 | PASS | Submitted -> `Submission received — SESS-15` |
| M1.7 | PASS | First submission on limit-1 form succeeds -> SESS-16 |
| M1.8 | PASS | `You have reached the limit of 1 submissions for this form.` Only Back offered; steps 3-5 disabled |
| M1.9 | PASS | Close Date 2026-08-01 00:00 saved, header `Saved 21:50:41`, warns `Closed (by date)` |
| M1.9a | PASS | Reads back `2026-08-01T00:00` after full reload — event-local wall clock preserved (NFR-12) |
| M1.10 | PASS | SSR: `This form is closed — submissions ended August 1 at 12:00 AM PDT.` + portal link; bootstrap `closed:true` |
| M1.11 | PASS | Close Date cleared; SSR shows wizard again, `close_at:null`, `closed:false` — fixture restored |
| M1.12 | PASS | Signed out: closed notice renders, `viewer:null`, no sign-in prompt — closed beats unauthenticated |
| M2.1 | PASS | Magic link reused after logout -> HTTP 410 `This link has expired` (single-use) |
| M2.2 | PASS | `/auth/callback?t=not-a-real-token` -> 410 `This link has expired` |
| M2.3 | PASS* | Blocked; wording `Last name is required.` (plan expected `First and last name are required.`). Native `required` also guards |
| M2.4 | PASS* | Enforced client-side by native `<input type="url">` (portal.ts:643): validity.typeMismatch=true, `Please enter a URL.` — no POST is sent. Server branch exists with wording `LinkedIn URL must be a full http:// or https:// address.` Same class as the plan's M6.5 note; NOT a hydration bug |
| M2.5 | PASS | Headshot .txt -> `File type text/plain is not accepted.` |
| M2.6 | PASS | 6.44 MB PNG headshot -> `File is too large (max 5 MB).` |
| M2.7 | PASS | Unticked acknowledge: native `required` blocks; server 400 `Please tick the confirmation first.` |
| M2.8 | PASS | Upload with no file: native `required` blocks; server 400 `Choose a file to upload.` |
| M2.9 | PASS | Task upload .txt -> `File type text/plain is not accepted.` |
| M2.10 | PASS | grace opening ada's SESS-4 -> redirected to own submissions list (SESS-9/11/2); SESS-4 never shown |
| M2.11 | PASS | grace on /app -> 403 `403 — Admin access required` |
| M2.12 | PASS | Signed out /portal -> 401 sign-in card |
| M3.1 | PASS | Reviewer sidebar contains only `Review` — no Dashboard/Workspace/Forms/Evaluation/Agenda/Settings |
| M3.2 | PASS | Reviewer on /app/api/forms -> 403 `{"error":"forbidden"}` |
| M3.3 | PASS | Reviewer on /api/v1/events -> 401 `unauthenticated`, message names Settings -> API tokens |
| M3.4 | PASS | One criterion scored -> both Save buttons disabled, hint `Score every criterion to save.` |
| M3.5 | PASS | Conflict flag ticked -> all score buttons disabled, Save enabled |
| M3.6 | PASS | `Saved — flagged as conflict of interest.`, status chip `skipped`, queue 7 of 8 |
| M3.7 | PASS | (after dev-server restart) SESS-6 detail lists the review as `Conflict of interest`, rating ★ 0 — excluded from the mean |
| M3.8 | PASS* | `No decision emails to send; 2 skipped (not in a queue)` (plan expected the longer `0 accepted, 0 declined, 0 tasks assigned, 2 skipped…` wording) |
| M3.9 | PASS | Only SESS-3 enqueued — bulk_jobs.params_json held 1 id; already-accepted SESS-14 filtered at enqueue. DB: SESS-3 accepted + notified_at set |
| M3.10 | PASS | Second press -> `No decision emails to send; 1 skipped (already notified)`; decision_accepted count stayed 2 |
| M3.11 | PASS | Exactly one decision_accepted message for SESS-3's speaker (alan.turing@example.com) |
| M3.12 | PASS | Decline Queue filter -> count 0, `No records match the current filters.` |
| M4.1 | PASS | SESS-14 at Oct 14 16:00 -> Conflicts shows `OUTSIDE_EVENT_WINDOW` (error): scheduled outside the event dates |
| M4.2 | PASS | Day view block has class `tg-block conflict-error`, ⚠ icon, red bg rgb(251,239,236), red bottom border rgb(220,38,38) |
| M4.3 | PASS | Moved back to Oct 12 10:00 Main Stage -> OUTSIDE_EVENT_WINDOW gone (leaves pre-existing ROOM/SPEAKER double-books) |
| M4.4 | PASS | Mid-drag ghost `tg-ghost bad`: `ROOM_DOUBLE_BOOKED: "Eval-Driven Development…" and "Postmortems…" overlap in Main Stage.` red dashed 2px rgb(220,38,38) |
| M4.5 | PASS | Duration 0 -> clamped to 5 min (block renders 10:15–10:20) |
| M4.6 | PASS | Pending SESS-15/SESS-16 absent from the unscheduled tray; tray holds only accepted SESS-3 |
| M4.7 | PASS | `Send confirmations` -> 6 sessions queued; 6 `schedule_confirmed` rows sent after cron drain |
| M4.8 | PASS | Second press -> button disabled, nothing re-queued; schedule_confirmed stayed 6 |
| M4.9 | PASS | Prompt offered `Skip the email` / `Send updated invite`; skipping still applied the move. schedule_changed 0 before and after |
| M4.10 | PASS (plan now stale) | Lounge (40); rooms Main Stage 600, Hall A/B 250, Studio 80, Pavilion 120. A **Capacity field IS present** in the Move dialog, contrary to the plan's note |
| M4.10a | PASS (added) | Capacity 500 in Lounge (40) -> `ROOM_CAPACITY_EXCEEDED` **does** fire, as a *warning*: `"Postmortems of Production LLM Incidents" expects 500 attendees but Lounge holds 40.` with Move/Change room/Ignore actions |

> **Mid-run reseed.** Between M5.2 and M5.3 the local D1 was fully reseeded (SESS-3 reverted to
> accept_queue, skipped reviews back to 0, SESS-15/16 gone). Cause confirmed by experiment: the
> `scheduled` handler's `0 9 * * *` branch runs `resetDemoData` when `DEMO_RESET=on`
> (wrangler.toml:51, index.ts:14-22). Firing only `* * * * *` is safe. M1–M4 evidence was captured
> before the reset and stands; **M5 was re-run from scratch on the fresh seed** and the results
> below are the clean ones.

| M5.1 | PASS | Overdue card lists 2 rows (Ada, Grace — Speaker Agreement, 5 days overdue). Remind all -> 2 reminders actually sent (DB 0 -> 2) |
| M5.2 | **FAIL** | Second `Remind all` sent 2 MORE reminders (DB 2 -> 4). Ada and Grace each reminded twice the same day. Expected `Already reminded today — 2 skipped.` |
| M5.3 | **FAIL** | Single-row `Send reminder` on an already-reminded row sent again (DB 4 -> 5); UI then reported `1 reminder sent.` |
| M5.4 | **FAIL** (consequence) | Today's task_reminder rows: ada@example.com x3, grace.hopper@example.com x2 — nothing was ever skipped, so there is no skip-leaves-no-row behaviour to confirm |
| M5.5 | PASS | Seeded overdue tasks still present; card row count 2 (the plan's allowed alternative) |
| M6.1 | PASS | Concurrent write then Save -> `This record changed in another session — reload to pick up the latest version before saving again.` (class `builder-error`, 409) |
| M6.2 | PASS | Name reverted to `Call for Speakers 2026` (unsaved edit never persisted); status reopened to Open |
| M6.3 | PASS | Clearing a question Label disables Save (`[disabled]`) |
| M6.4 | PASS | Duplicate email -> `A contact with this email already exists for this event.` plus an `Open existing contact` button |
| M6.5 | PASS | Empty email -> inline `This field is required` (class `record-form-error`); no POST sent — matches the plan's corrected note |
| M6.6 | PASS | Bearer kms_deadbeef… -> 401 `invalid_token` / `Unknown or revoked API token.` |
| M6.7 | PASS | No auth -> 401 `unauthenticated`, message names Settings -> API tokens |
| M6.8 | PASS | Unknown event id -> 404 `event_not_found` / `No event with this id.` |
| M6.9 | PASS | /widgets -> 404 `unknown_resource`, `Available: contacts, submissions, tasks, messages.` |
| M6.10 | PASS | status=banana -> 422 `invalid_status` listing all seven valid statuses |
| M6.11 | PASS | ?status=banana -> 200, filter silently ignored (unknown_filters convention) |
| M6.12 | PASS | /app/api/meta documents the forms_update 409 convention verbatim |

## Summary

| Milestone | Steps | Pass | Fail | Blocked |
|---|---|---|---|---|
| S0 | 3 | 3 | 0 | 0 |
| M1 | 12 | 12 | 0 | 0 |
| M2 | 12 | 12 | 0 | 0 |
| M3 | 12 | 12 | 0 | 0 |
| M4 | 10 (+1 added) | 11 | 0 | 0 |
| M5 | 5 | 2 | 3 | 0 |
| M6 | 12 | 12 | 0 | 0 |
| **Total** | **67** | **64** | **3** | **0** |

### Defect — per-day task-reminder idempotency is defeated by the bulk-job id (NFR-11)

Fails M5.2, M5.3, M5.4. Reproduced twice, the second time on a freshly seeded database.

`POST /app/api/dashboard/remind` (`apps/api/src/routes/dashboard.ts:421-462`) does **no** per-day
dedupe of its own — every press snapshots all currently-overdue assignments into a new `bulk_jobs`
row. Deduplication is delegated entirely to the mailer, which matches on an exact
`message_log.idempotency_key` (`apps/api/src/mailer.ts:251`).

But the expander embeds the **job id** in that key
(`apps/api/src/jobs/bulkJobs.ts:9-16`), producing:

```
task_reminder:<contactId>:<jobId>:<assignmentId>:vmanual-<YYYY-MM-DD>
```

Every press mints a fresh `jobId`, so the key never repeats and the guard never matches — despite
the `vmanual-<date>` suffix that encodes the per-day intent. Observed keys for the same contact,
same assignment, same day, differing only in the job id:

```
task_reminder:con…002:e454a738-…:ta…003:vmanual-2026-08-10
task_reminder:con…002:8d21f775-…:ta…003:vmanual-2026-08-10
```

Result: Ada Lovelace received **3** reminder emails and Grace Hopper **2**, all on 2026-08-10.
The comment at `bulkJobs.ts:9-16` calls the embedding "deliberate" — it makes a job's sends
countable via `idempotency_key LIKE '%:'||jobId||':%'` — so job-progress counting and per-day
idempotency are in direct conflict. Fixing one must preserve the other (e.g. keep the natural key
for dedupe and count job progress from `bulk_jobs.enqueued` instead).

### Plan corrections (behaviour is correct; the plan is stale)

- **M4.10** — the note claims no capacity editor exists so `ROOM_CAPACITY_EXCEEDED` can never fire
  from the browser. A **Capacity field is now present in the Move dialog**, and the added step
  M4.10a fires the rule as a *warning*: `"Postmortems of Production LLM Incidents" expects 500
  attendees but Lounge holds 40.` The note should be replaced by a real assertion.
- **M2.4** — the LinkedIn check is enforced client-side by native `<input type="url">`
  (`portal.ts:643`), so no POST is sent and the server message never appears. Same shape as the
  plan's own M6.5 note; M2.4 should assert the native `Please enter a URL.` instead.
- **Wording drift** (behaviour correct, expected strings stale): M1.5, M2.3, M2.4, M3.8.

### Environment notes for the next run

- **Never fire the `0 9 * * *` cron locally.** `wrangler dev` does not run crons, so bulk jobs
  (decisions, confirmations, reminders) sit `pending` and the UI shows `Sending… 0/N queued`
  forever. Drain with the sweep cron only:
  `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=%2A+%2A+%2A+%2A+%2A"` (twice —
  pass 1 queues, pass 2 sends). The `0 9 * * *` branch runs `resetDemoData` because
  `DEMO_RESET=on` in `wrangler.toml:51`, which wipes the database mid-run.
- Every send step needs a drain before its assertion, and the UI note must be cross-checked
  against `message_log` — the stalled `Sending…` text misreads as "0 sent" when sends did happen.
- Identity switching needs `open http://localhost:8787/auth/logout`; the session cookie is
  HttpOnly and cannot be cleared from JS.
- M2.6 needs a >5 MB **accepted-type** file (a PNG, not a BMP) or the type check fires first.

## Fix — 2026-08-11

Option 1 from the design discussion, plus the event-local day.

- `packages/db/migrations/0014_message_log_bulk_job.sql` — `message_log.bulk_job_id` (indexed) and
  `bulk_jobs.skipped_duplicate`.
- `mailer.ts` — `SendTemplatedArgs.bulkJobId`, written by both `queueTemplated` and
  `prepareTemplated`.
- `jobs/bulkJobs.ts` — all four expanders send the **natural** entity id and name their job via
  `bulkJobId`; `queueSend(db, jobId)` stamps it for the scheduleMail/evaluation callbacks. The
  reminder's day segment is now `eventLocalDay(now, event.timezone)`. `'duplicate'` outcomes are
  counted into `skipped_duplicate`.
- `scheduleMail.ts`, `routes/evaluation.ts` — `entityPrefix` parameter removed.
- `routes/adminApi.ts` — job progress counts by `bulk_job_id = ?` instead of
  `idempotency_key LIKE '%:'||id||':%'`; exposes `skipped_duplicate`.
- `packages/core/src/time.ts` — new `eventLocalDay`.
- `admin/src/dashboard/DashboardSection.tsx` — reports duplicates; the dead pre-job branch removed.

Re-verified live (run u08110836, fresh DB, both presses through the real UI):

| Check | Result |
|---|---|
| Press 1 | 2 reminders sent |
| Press 2 | still 2 total — ada x1, grace x1; job reports `skipped_duplicate: 2` |
| Banner | `Already reminded today — 2 skipped.` — the exact string M5.2 expects |
| Key shape | `task_reminder:<contactId>:<assignmentId>:vmanual-2026-08-11` — no job id |

Tests: 785 pass (was 780). Five added — two reminder regressions in
`bulkjobs-expander-remind.test.ts` and three `eventLocalDay` unit tests. Both regression tests were
confirmed to **fail** against the pre-fix code (`expected 2 to be 1`). Twelve existing tests that
asserted the old `LIKE '%:'||jobId||':%'` contract were migrated to `bulk_job_id`.

M5.2/M5.3/M5.4 now pass, taking the plan to **67/67**.
