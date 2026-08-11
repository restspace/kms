# Workplan 9 — Airtable mirror (one-way, D1 → Airtable)

Status: **not started.** Scoping document, not a change log. Nothing beyond a
logging stub exists in code today.

## 1. Where it actually stands

Checked, not assumed:

- `packages/airtable` does not exist. No adapter, no client, no field mapping.
- The only code touching this is `apps/api/src/jobs/outbox.ts:37-40` — the
  `airtable_sync` case in the outbox switch logs `"mirror not built yet (M6),
  marking done"` and acks the job so it doesn't retry forever. Nothing ever
  enqueues an `airtable_sync` job, so this case is presently dead code.
- `wrangler.toml:48` sets `AIRTABLE_SYNC = "off"`. `env.ts:8` declares
  `AIRTABLE_SYNC: string` but **not** `AIRTABLE_API_KEY` / `AIRTABLE_BASE_ID` —
  the two secrets docs/03-architecture.md:206-207 says the feature needs
  aren't wired into `Env` yet.
- It is on the explicit cut list (docs/12-build-plan.md §"Cut list, in
  order" — dropped before the Files tab) and README.md lists it under
  "Deliberately out of scope." This workplan does not relitigate that call;
  it exists so the feature can be picked up in one piece if/when it is.

## 2. Decisions already taken (docs/03-architecture.md §2)

| # | Decision | Consequence |
| --- | --- | --- |
| D1 | One-way, D1 → Airtable only | No conflict resolution, no pull-back. Airtable edits are simply overwritten on the next sync. |
| D2 | D1 stays system of record | Airtable's 5 req/s per base, 100-records/page, no-joins, no-transactions rule it out as primary at this scale (NFR-2). `PERSISTENCE=airtable` mode was scoped and explicitly cut — do not resurrect it here. |
| D3 | Delivery rides the existing outbox, not Queues | Same `outbox` table and cron sweep as email (docs/03 §2a) — no new infra. |
| D4 | Idempotent via a stored Airtable record id | Each mirrored D1 row gets an `airtable_record_id` column so re-sync updates the same Airtable row instead of duplicating it. |
| D5 | Base schema mirrors the domain model | `Events, Forms, Submissions, Contacts, Sessions, Tasks, Reviews, Tracks, Rooms, Tags` (docs/03:63-64) — see §3 for a correction to this list. |
| D6 | Bidirectional sync is explicitly a stretch, post-deadline | Deletes/schema-drift/conflict handling on the Airtable→D1 direction is out of scope here. |

## 3. Correction to the D5 table list: "Sessions" is not a table

`docs/02-domain-model.md` "Session" section: *"A scheduled submission. Modelled
as the **same row** as `Submission`... rather than a separate table... this
avoids sync bugs."* There is no `sessions` table (confirmed: no `CREATE TABLE
sessions` anywhere in `packages/db/migrations/`). `is_scheduled` is the
derived predicate `starts_at IS NOT NULL AND room_id IS NOT NULL` on
`submissions`.

So mirroring "Sessions" as its own Airtable table means either:

- **(recommended)** one `Submissions` Airtable table carrying the schedule
  columns (`starts_at`, `ends_at`, `room_id`), and a filtered Airtable view
  named "Sessions" (`starts_at IS NOT NULL`) built once in the base UI — no
  sync-side special-casing.
- or a second sync pass that writes the same source rows into a second table
  under different field names, which reintroduces exactly the duplicate-source
  sync-bug risk the domain model quotes above as the reason D1 doesn't do
  this internally. Don't.

## 4. Sync strategy — the real design problem

### 4.1 Why per-write `outbox.enqueue()` calls don't fit this codebase

The email precedent (`mailer.ts:145`) enqueues from one call site because
outbound email has one call site. The five mirror-target tables do not:
`INSERT`/`UPDATE` on `submissions`, `contacts`, `sessions`(n/a, see §3),
`tasks` is spread across at least **8 files** —
`adminApi.ts`, `evaluation.ts`, `submit.tsx`, `restApi.ts`, `importer.ts`,
`agenda.ts`, `bulkJobs.ts`, `portal.ts` — confirmed by grepping for
`INSERT INTO`/`UPDATE ... SET` on those table names. Instrumenting every
mutating call site with an `outbox.enqueue({kind:'airtable_sync', ...})` call
means ~20+ edit sites (for comparison, `bumpEventRevision` alone is called
from 20 sites in `adminApi.ts`) and a permanent tax on every future PR that
adds a ninth write site and forgets the enqueue call. That failure mode is
silent — a row just never mirrors — which is worse than a visible bug.

### 4.2 Recommended: watermark sweep, not per-write enqueue

`apps/api/src/revision.ts` already solves an adjacent problem the same way:
every mutating route bumps a per-event KV marker instead of each route
knowing about every downstream cache. Reuse the shape, not the mechanism:

- A new cron-driven job (`apps/api/src/jobs/airtableSync.ts`, alongside
  `outbox.ts`, `reminders.ts`, `bulkJobs.ts`) queries each mirrored table for
  rows where `updated_at > last_synced_at` (per event, per table), pushes
  them to Airtable, and advances a watermark.
- One new small table, `airtable_sync_state (event_id, table_name,
  last_synced_at)`, tracks the watermark — no per-row outbox job needed, no
  call-site instrumentation anywhere else in the codebase.
- The outbox `airtable_sync` kind and its stub in `outbox.ts` should then be
  **removed**, not implemented — it's the wrong mechanism for this shape of
  work (see D3 revision below). Keep `outbox` for genuinely per-event actions
  (email) only.

This trades "seconds" latency (docs/03:52 says "within seconds") for
"one cron tick" latency (existing cron granularity — check current schedule
in `wrangler.toml`, likely minutes). That is very likely an acceptable trade
for a spreadsheet mirror and removes the entire class of "forgot to
instrument a write site" bugs. If sub-minute latency turns out to matter,
revisit — but D3 above should be read as superseded by this section, not as
a constraint to preserve.

### 4.3 Blocker: `updated_at` doesn't exist on every mirrored table

Confirmed by grep across `0001_init.sql`: `events`, `contacts`, `submissions`
have `updated_at`. `tasks` and `reviews` have only `created_at`. `tracks`,
`rooms`, `tags` have neither (they're small reference tables, rarely edited
after creation, but "rarely" isn't "never" — a track rename must mirror).

A watermark sweep is dead on arrival without `updated_at` everywhere it
reads. This is the actual first work item, not a footnote:

```sql
ALTER TABLE tasks   ADD COLUMN updated_at TEXT;
ALTER TABLE reviews ADD COLUMN updated_at TEXT;
ALTER TABLE tracks  ADD COLUMN updated_at TEXT;
ALTER TABLE rooms   ADD COLUMN updated_at TEXT;
ALTER TABLE tags    ADD COLUMN updated_at TEXT;
-- backfill = created_at, then every UPDATE site for these tables must start
-- setting it. That touches the same ~8 files as §4.1, but as a mechanical
-- "add updated_at = ? to existing UPDATE statements" pass rather than a
-- judgment-laden "remember to enqueue" pass — much lower risk of silent
-- omission because a missed site just means one row lags until its next
-- edit, not "never syncs."
```

### 4.4 `airtable_record_id` columns (D4)

Same five/eight tables need `airtable_record_id TEXT` added, nullable,
unindexed (looked up by D1 row id, not the reverse). Bundle into the same
migration as §4.3.

## 5. Multi-tenancy gap (not addressed in docs/03 at all)

The app is **multi-tenant** (docs/00-overview.md:39 — "organisers publish...")
but the architecture doc's env table (docs/03:206-207) defines exactly one
`AIRTABLE_BASE_ID` / `AIRTABLE_API_KEY` pair — worker-global secrets, not
per-organisation or per-event. As specced, every event on a shared
deployment would mirror into the **same** Airtable base, with no table-level
separation beyond an `event_id` column on each mirrored row.

This needs an explicit decision before schema work starts:

- **(a)** Airtable credentials become per-organisation config (a new
  `organisations` column or a settings table), each org points at its own
  base. Matches the multi-tenant model but means the sync job now fans out
  per-org instead of being one global job — bigger scope.
- **(b)** Stay single-base/global as specced, document it as a
  single-tenant-deployment feature (fine for the demo/one-org-per-deploy
  reality this app currently runs as — see memory: demo lives at
  `kms.r-s.workers.dev`, one org). Cheapest, but silently wrong the day a
  second paying org is onboarded onto the same Workers deployment.
- **(c)** Off by default per-org via a per-org toggle layered on top of (b)'s
  single global base — an org opts in, all its events land in the one base,
  keyed by `event_id`/org name as an Airtable field for filtering.

No recommendation forced here — it depends on whether multi-org-per-deployment
is a near-term reality or a someday concern. (b)+(c) is the pragmatic default
if the current single-org demo deployment is the actual target; flag (a) as
the correct fix if a second org is imminent.

## 6. New package: `packages/airtable`

Mirrors the shape of `packages/email` (client + render/mapping split,
own test file per concern):

```
/packages/airtable
  src/
    client.ts       Airtable REST client: PAT auth, batched upsert (10
                     records/request per Airtable's API limit), 429 backoff
    mapping.ts       D1 row → Airtable fields per table (5-8 pure functions)
    sync.ts          orchestration: per-table watermark read → query → map →
                     client.upsert → watermark write
    client.test.ts
    mapping.test.ts
```

Rate limiting (5 req/s per base) is the one non-obvious implementation
constraint: batch upserts at 10 records/call (Airtable's cap) and throttle
calls, don't rely on retry-after alone — a full-table backfill (§8) at
initial sync will otherwise blow through the limit immediately on any event
with more than a handful of submissions.

## 7. Field mapping — needs a judgment pass per table, not just a schema mirror

D5's "base schema mirrors the domain model" is the right starting point but
undersells the work. Each table needs an explicit answer to: which D1 columns
are useful in a spreadsheet a human reads (name, status, email) versus
internal-only (JSON blobs like `submissions.answers`, foreign-key ids that
mean nothing without a join)? Recommend a literal mapping table per entity in
`mapping.ts`'s tests before writing the mapper, the same way workplan-7 §4
pinned down a schema before writing migration SQL. Don't guess this inline
during implementation — get sign-off on the field list per table first,
since re-mapping after the base UI is built by hand means renaming
Airtable columns that a human may have already started using.

## 8. Initial backfill vs steady-state sync

Same mechanism, different starting watermark: first sync for an event uses
`last_synced_at = '1970-01-01'` so every existing row mirrors once flipping
`AIRTABLE_SYNC=on`. Enabling the flag for an event with years of accumulated
submissions is the rate-limit stress case from §6 — batch it, and log
progress (row counts per table) rather than doing it silently, so a slow
first sync is visible rather than looking hung.

## 9. Tests

Workers project (`vitest --project workers`):

- mapping: each entity mapper produces the expected Airtable field object
  from a representative D1 row, including null/empty-string edge cases
- watermark advance: sweep only picks up rows with `updated_at >
  last_synced_at`; a row touched mid-sweep is picked up on the *next* sweep,
  not dropped
- idempotency: re-running a sync with an already-set `airtable_record_id`
  issues an update, not a create (mock the Airtable client, assert the verb)
- event scoping: event A's sweep never reads or writes event B's rows
- rate limiting: batching stays at ≤10 records/call; a mocked 429 triggers
  backoff and retry, not job death
- flag off: `AIRTABLE_SYNC=off` means the cron job is a no-op (cheap to
  assert, easy to regress)

No UI tests — this is a backend-only mirror; nothing in the admin SPA reads
`airtable_record_id` or exposes the mirror's status. (A "Sync: Airtable —
last synced 2m ago" line in Settings would be a reasonable stretch, not
required for a working mirror.)

## 10. Open questions

1. **Multi-tenancy** (§5) — needs a decision before schema work, not during.
2. **Deletes.** D6 puts bidirectional sync out of scope, but doesn't address
   the simpler one-way case: a D1 row gets deleted (e.g. a withdrawn
   submission, per existing cascade deletes) — does the mirrored Airtable
   record get deleted too, or orphaned? Recommend deleting it (a
   `DELETE FROM submissions WHERE id=?` cascade could carry the
   `airtable_record_id` to a small "pending Airtable deletes" queue read by
   the same sweep), otherwise the mirror silently accumulates stale rows a
   human has no way to distinguish from live ones.
3. **Which entities actually matter to a program committee reading a
   spreadsheet.** D5's ten-table list is comprehensive but `Forms` and
   `Tracks`/`Rooms`/`Tags` are configuration, not day-to-day content — a
   smaller v1 (`Submissions` incl. schedule fields per §3, `Contacts`,
   `Tasks`, `Reviews`) may be the better cut if this is picked up
   incrementally, deferring the reference tables.
4. **Cron frequency.** §4.2's "one cron tick" latency depends on whatever the
   existing cron schedule is — check `wrangler.toml`'s `[triggers]` block
   before promising a latency number to anyone.

## 11. Sequencing

| Step | Work | Rough size |
| --- | --- | --- |
| 1 | Decide multi-tenancy model (§5) | — (decision, not code) |
| 2 | Migration: `updated_at` backfill (§4.3) + `airtable_record_id` columns (§4.4) + `airtable_sync_state` table | S |
| 3 | Wire `AIRTABLE_API_KEY`/`AIRTABLE_BASE_ID` into `Env` + `.dev.vars.example` | S |
| 4 | `packages/airtable` client + rate limiting (§6) | M |
| 5 | Field mapping sign-off + `mapping.ts` (§7) | M |
| 6 | Sync orchestration + cron wiring; remove the dead `airtable_sync` outbox case | M |
| 7 | Backfill path + progress logging (§8) | S |
| 8 | Delete propagation (§10.2) | S |
| 9 | Tests (§9) | M |

Steps 2-3 are safe prerequisite plumbing regardless of how §5 and §10.3 are
decided. Step 4 can be built and unit-tested against a mocked Airtable API
before step 1's decision is final. Steps 6-8 are where the multi-tenancy and
delete-semantics decisions actually bite — don't start them until §5 and
§10.2 are answered.
