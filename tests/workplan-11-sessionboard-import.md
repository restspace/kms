# Workplan 11 — Import from Sessionboard

Status: **not started.** Scoping document, not a change log. The generic
spreadsheet importer this builds on is live; nothing Sessionboard-specific
exists in code today.

## 1. Where it actually stands

Checked, not assumed:

- A working generic importer already exists — FR-REV-8, docs/06 §6:
  - `apps/api/src/importer.ts` — RFC-4180 CSV + regex-based XLSX parsing,
    fuzzy header auto-mapping (`autoMap`), a server-side dry-run plan
    (`planSessions` / `planContacts`), and `commitStatements` applied as one
    `db.batch()` transaction.
  - `apps/api/src/routes/importExport.ts` — `/app/api/import/preview` +
    `/commit`, stateless between preview and commit (commit re-plans
    server-side; the browser's plan is never trusted). Caps: 5,000 rows,
    10 MB.
  - `apps/admin/src/workspace/ImportWizard.tsx` — upload → mapping →
    preview → commit UI.
- Upsert keys already match Sessionboard's dedupe keys:
  `submissions.client_session_id` (their "Session ID") and org-scoped
  lower-cased email for contacts (`UNIQUE (org_id, lower(email))`, 0015).
  This is not a coincidence — docs/15 §4 notes their conventions were used
  as the free spec.
- docs/15-winning-moves.md §4 contains **verified** research (their KB and
  public API docs, checked Aug 2026) on what Sessionboard exports and how
  values are formatted. §5 sets the design bar: never lose data, never
  half-apply. This workplan does not re-derive any of that; it cites it.
- Nothing in the code mentions Sessionboard: no field aliases for their
  header spellings, no status translation, no speaker↔session linking on
  import, no multi-select handling, no batch undo, no unmapped-column
  preservation. Those gaps are the work.

## 2. What "import from Sessionboard" concretely means

Their export path that needs no one's permission is per-module CSV/XLSX
(`Options → Export`) for **Sessions**, **People/Contacts**, **Sponsors**,
**Exhibitors**, plus a Reports module that emits Evaluation Plan reports
(where scoring lives). Two verified properties shape everything below
(docs/15 §4):

1. **No fixed header set.** Columns are whatever the exporting user had in
   their table view. Auto-mapping plus manual override is mandatory — which
   the existing wizard already provides. The Sessionboard work is enriching
   the field catalogue, not building a mapper.
2. **Attachments export as hosted URLs** that may expire, not files.
   Headshots/slides are a second-pass fetch, best-effort.

Value formats (their own documented import conventions, which their exports
obey): multi-select is pipe-separated (`A | B`), session datetimes are
`YYYY-MM-DD HH:mm`, contacts require First/Last name, sessions require
Status/Title.

Known gaps to state honestly rather than paper over: **no separate
submissions export** (abstracts are sessions in a composition status, so
they arrive via the Sessions export) and **nothing exports onboarding
tasks** (rebuild-from-scratch, not import).

## 3. Scope decision — CSV/XLSX first, API later

Two possible sources; they are not equal:

- **(v1, this plan)** CSV/XLSX files. Works with zero cooperation from
  Sessionboard, demos offline, and rides the existing wizard end to end.
- **(explicitly deferred)** The public API
  (`https://public-api.sessionboard.com`, token auth, OpenAPI published,
  25/page default, 429 + backoff). Richer — `list-fields` returns custom
  field definitions — but requires a customer token, so it can never be the
  only path. If built later it should feed the *same* staging/plan/commit
  pipeline as files, just with a different ingest step. Nothing in v1 may
  assume "the source is a file" anywhere below the parse layer (it already
  doesn't: `planImport` takes `(headers, rows, mapping)`).

## 4. Gap analysis — existing importer vs a real Sessionboard export

Each row here is verified against `importer.ts` as of today.

| # | Gap | Evidence | Size |
| --- | --- | --- | --- |
| G1 | No Sessionboard header aliases. Their exports use spellings like "Session Name", "Speaker Email", "Session Start Time" that `autoMap` may miss | `SESSION_FIELDS` / `CONTACT_IMPORT_FIELDS` aliases are generic (`importer.ts:189-220`) | S |
| G2 | No speaker↔session linking. Their Sessions export carries speaker names/emails per session; ours imports sessions and contacts as unrelated rows | `planSessions` never touches `submission_participants` | M |
| G3 | Statuses don't translate. Sessionboard statuses ("Accepted", "Confirmed", "Under Review", composition states…) are not in our vocabulary, so every row errors | `SUBMISSION_STATUSES` set (`importer.ts:368`) rejects unknown statuses as row errors | S |
| G4 | No multi-select handling. Pipe-separated values (`Track A \| Track B`, tag lists) would be treated as one literal string | `applyMapping` passes raw cell text; track match is whole-string | S |
| G5 | `YYYY-MM-DD HH:mm` datetimes are timezone-naive. `new Date('2026-08-11 09:00')` parses, but as UTC inside Workers — sessions land shifted unless the event timezone is applied | `isoOrNull` (`importer.ts:372`) | S |
| G6 | Excel serial dates come out as numbers and error | documented gap in `parseXlsx` doc comment (`importer.ts:109-114`) | S–M |
| G7 | Unmapped columns are silently dropped | `applyMapping` ignores them; plan reports them in `unmapped` but commit discards | M |
| G8 | No import batch / undo. docs/15 §5 calls one-click undo the thing that makes someone press the button on real data | no `import_batch` anywhere in `apps/api/src` (grepped) | M |
| G9 | No tags import | no `tags` field in `SESSION_FIELDS`; `submission_tags` table exists | S |
| G10 | No headshot/attachment URL fetch | nothing reads URL-valued columns | M (defer-able) |
| G11 | No evaluation/scores import | Reports-module CSV; `reviews` table exists | M (defer-able) |

Deliberately **not** gaps: staging-table ingest ("ingest raw, promote
strictly", docs/15 §5) is a bigger architectural change than v1 needs —
the stateless preview/commit design already achieves "never half-apply"
via single-batch commit and per-row error reporting, and G7's `extra` blob
covers "never lose data". Revisit staging only if the API source (§3)
lands, where ingest is no longer a single request.

## 5. Design

### 5.1 A source *profile*, not a fork of the importer

One new concept: an import **source** (`generic | sessionboard`), chosen in
the wizard's first step ("Import from Sessionboard" as a named option is
itself the demo moment — docs/15 §2 move 1). A source profile bundles:

- extra header aliases merged into the field catalogue (G1),
- value normalisers run inside `applyMapping` (G3 status map, G4 pipe
  split, G5 datetime parse with the event's timezone, G6 serial dates),
- link-column semantics (G2's "Speakers" column).

`planSessions`/`planContacts` stay single implementations; the profile is
data plus a few pure functions in a new `apps/api/src/sourceProfiles.ts`
(or a section of `importer.ts` if it stays small). No second wizard, no
second commit path — the existing "commit re-plans server-side" property
must survive untouched, so the profile id travels with `(headers, rows,
mapping)` in both preview and commit payloads.

### 5.2 Speaker↔session linking (G2) — the one real design problem

A Sessionboard Sessions export row can carry its speakers (name and/or
email columns, possibly pipe-separated for multi-speaker sessions). Options:

Researched (Aug 2026): the API's session object carries participants as
`speakers` / `moderators` / `chairpersons` arrays (legacy) or a flat
`participants` array with a `participant_role`, and participant profiles
carry names/company/photo — **emails are not confirmed to appear** in the
session-side data. Their import docs document no speaker-linking column at
all. So a Sessions export's speaker column is most likely *names*, with
emails only if the exporting user added such a column to the view.

Decision (best guess, revisit against a real export):

- A `speakers` import field on the sessions target accepting **emails or
  names**, pipe-separated (their multi-select convention; also accept `;`,
  and `,` only when every fragment is an email — comma-splitting names
  breaks on "Last, First"). Per value:
  - looks like an email → resolve against the org contact pool (same
    lookup `planContacts` uses);
  - otherwise → **exact case-insensitive full-name match** against the org
    pool, accepted only when it matches exactly one contact. No fuzzy
    matching — a false link is worse than a missing one.
  - anything unresolved or ambiguous → the session imports **unlinked**
    with a per-row warning naming the value; the report (§5.5) lists every
    skipped link.
- Commit inserts `submission_participants` rows, `ON CONFLICT` on the
  existing `UNIQUE (submission_id, contact_id, role)` for idempotency.
  Role mapping: speaker→`speaker`, moderator→`moderator`,
  chairperson→`moderator` (closest we have; message says so), when the
  column conveys roles at all — a bare "Speakers" column maps to `speaker`.

Import order in the UI copy: **People first, then Sessions** — name/email
matching then runs against a populated pool. The linker must not *require*
it (unresolved values degrade to a warning either way).

### 5.3 Status translation (G3)

A literal map in the sessionboard profile, e.g. Accepted/Confirmed →
`accepted`, Declined/Rejected → `declined`, everything review-ish →
`pending`, draft/composition states → `draft`. Unknown statuses fall back
to `pending` **with a per-row message**, not an error — degrade-to-draft
per docs/15 §5. Researched: the API session object exposes `status` plus
`custom_status`, `composition_status` and `is_abstract` — so **custom
statuses are a first-class feature** and the fallback path is the common
case, not the edge case; the message must carry the original value (which
also lands in `extra`, §5.4). The exact built-in vocabulary still needs a
real export or their `list-session-statuses` output; pin it in a fixture
(§7), and keep the map exported so a test asserts every entry lands in
`SUBMISSION_STATUSES`.

### 5.4 Unmapped columns → `extra` JSON (G7)

Schema: one new nullable TEXT column on `submissions` and `event_contacts`
(migration 0020) holding a JSON object of `{original header: value}` for
columns the user left unmapped, written on create/update when the profile
is sessionboard (or a wizard checkbox for generic imports). Surface it
read-only on the record detail as "Imported fields". This is the cheap 80%
of "never discard data"; a queryable custom-fields system is explicitly
out of scope (the `contact_field_definitions` machinery exists for
contacts but adopting it here is a separate decision — see §9.3).

### 5.5 Batch id + undo (G8)

- Migration 0020 (renumbered: upstream took 0019 for green-room check-in)
  also adds `import_batches (id, event_id, target, source,
  filename, created_by, created_at, summary_json)` and an
  `import_batch_id TEXT` column on `submissions`, `event_contacts`, and
  `submission_participants`.
- Commit stamps every **created** row with the batch id. Undo deletes
  created rows only — updated/merged rows are *not* reverted in v1
  (storing per-column before-values is a much bigger change; the fill-
  blanks-only merge policy already bounds the damage to "a blank became a
  value"). The undo confirmation must say exactly that.
- Undo endpoint guards: writer role on the event, batch belongs to the
  event, and deletes cascade the way normal deletes already do. Emit the
  applied/undone counts back into `summary_json`.
- The downloadable **report artifact** (docs/15 §5) falls out of the same
  table: a `GET .../import/batches/:id/report.csv` listing every row's
  action/message from the stored plan summary.

### 5.6 What stays deferred inside this feature

- **G10 attachments/headshots:** URL columns are preserved in `extra`
  (§5.4) from day one; actually fetching them (expiring URLs, R2 writes,
  size caps) is a follow-up step, listed in §8 but skippable for a working
  v1.
- **G11 evaluation reports:** a third import target with its own shape;
  defer until someone produces a real Evaluation Plan report file.
- **Sponsors/Exhibitors exports:** no domain tables for them (out of
  scope per docs/00); refuse the file kind with a clear message rather
  than mis-importing into contacts.

## 6. Scope of the promise (README / UI copy)

Per docs/15 §5, claim exactly: *people and sessions import cleanly,
including speaker↔session links when the export has email columns;
schedule and files are best-effort; statuses are translated; everything
unmapped is preserved on the record and reviewable; every import can be
undone in one click.* Do not imply tasks or evaluations import.

## 7. Fixtures — the actual first work item

Everything in §5.2/5.3 has a dependency: **a real (sanitised) Sessionboard
export**. docs/15 §5 says ask in Discord; do that now, in parallel with
everything else. Until one arrives, build fixtures from the documented
conventions (docs/15 §4 table) and mark assumptions in the fixture file
header. Fixture set, in `apps/api/src/__fixtures__/sessionboard/` (or
alongside the existing test data — match wherever `importer.test.ts`
keeps fixtures today):

- sessions.csv — realistic headers, pipe multi-select, `YYYY-MM-DD HH:mm`,
  a names-only speakers column plus an emails variant (§9.1), mixed
  built-in and custom statuses
- contacts.csv — First/Last required convention, phone format, a headshot
  URL column
- sessions.xlsx — same data via the XLSX path incl. a serial-date cell
- the horrors file: UTF-8 BOM, CRLF, smart quotes, emoji, duplicate
  emails, blank required fields, quoted commas, an unknown status,
  a speaker email that matches nobody, a speaker name matching two
  contacts (must warn, not guess), a "Last, First" name in a speakers cell

## 8. Sequencing

| Step | Work | Size |
| --- | --- | --- |
| 1 | Ask for a sanitised real export (Discord); build assumption-marked fixtures (§7) meanwhile | S |
| 2 | Migration 0019: `import_batches`, `import_batch_id` ×3 tables, `extra` JSON columns (§5.4, §5.5) | S |
| 3 | Source profile plumbing: `source` through preview/commit payloads + wizard step; sessionboard aliases (G1) | S–M |
| 4 | Value normalisers: status map (G3), pipe split (G4), tz-aware datetime (G5), serial dates (G6) — all pure, all unit-tested | M |
| 5 | Speaker linking on the sessions target (G2, §5.2) | M |
| 6 | `extra` capture + "Imported fields" read-only display (G7) | M |
| 7 | Batch stamping, undo endpoint + wizard affordance, report.csv (G8, §5.5) | M |
| 8 | Tags on sessions (G9) | S |
| 9 | README + wizard copy per §6; demo path against the clean fixture, horrors file as the follow-up beat | S |
| 10 | *(stretch)* headshot/attachment fetch pass (G10) | M |

Steps 2–4 are safe regardless of what the real export reveals; step 5's
column semantics and step 4's status map are where a real file might force
rework — which is why step 1 starts immediately but blocks nothing.

## 9. Open questions — resolved (researched Aug 2026 + best guesses)

Formerly open; each now carries a decision so implementation is unblocked.
Sources: learn.sessionboard.com "Exporting data" / "Importing data" /
"Module Table Views" articles and the public API docs
(sessionboard.mintlify.app). Decisions marked *(guess)* were not
answerable from public docs and should be re-checked against the first
real export — none of them is expensive to reverse.

1. **Speaker columns: names likely, emails not guaranteed.** The API's
   participant data is name/role/company-shaped with no confirmed email on
   the session side, and the import docs document no linking column at
   all. **Decided:** accept emails *or* exact-unique full-name matches,
   everything else unlinked-with-warning — full design now in §5.2
   *(match rules are a guess; splitting convention is documented)*.
2. **Session ID column presence.** Confirmed: export columns are whatever
   the table view showed, and their docs say Session IDs are assigned by
   their system and used as the update key — so the column exists but may
   be absent from an export. The API also exposes both `id` and
   `friendly_id`; alias **both** headers onto `client_session_id`, prefer
   "Session ID" when both are mapped *(alias set is a guess)*.
   **Decided:** when no ID column is mapped, the import is **create-only
   with a loud preview warning** ("re-running this import will
   duplicate"). No title matching — it silently merges distinct talks
   with the same name.
3. **`extra` vs `contact_field_definitions`.** **Decided: `extra` blob in
   v1.** Research strengthened this: Sessionboard has first-class custom
   fields on both sessions (`custom_fields` in the API) and contacts
   (Speaker CRM contact fields), so unmapped custom columns will be
   *common* — auto-promoting each one into `contact_field_definitions`
   would turn every import into a schema-mutating operation. A "promote
   imported field to custom field" tool is a clean later step because the
   original header names are preserved in the blob.
4. **Round-trip export.** **Decided: not this workplan.** Their import
   conventions are documented (dedupe keys, `Update record if already
   exists` column, 1,000-row files), so a Sessionboard-shaped exporter is
   a well-specified ~1h follow-up — its column names must come from the
   same profile module (§5.1) so the two never drift.
5. **Export size/chunking.** Their docs put the 1,000-record cap on
   *imports only*; no export chunking is documented. **Decided:** keep the
   wizard's existing 5,000-row/10 MB caps and add one line of copy —
   importing several files into the same event is safe *when a Session ID
   column is present* (upsert keys make re-runs idempotent; see #2). No
   multi-file batch UI in v1.
