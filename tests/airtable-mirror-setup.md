# Airtable mirror — setup instructions

Companion to [workplan-9-airtable-mirror.md](workplan-9-airtable-mirror.md), which is now
built. The mirror is one-way (D1 → Airtable), off by default, and mirrors into **one global
base** — a single-tenant-deployment feature (workplan-9 §5 option (b)).

## 0. The short version — Settings page

An organiser sets this up themselves, in **Settings → Airtable mirror**, in four numbered
steps: paste a personal access token, pick the base (**Find my bases**), press **Create the
tables in Airtable**, tick **Mirror to Airtable** and Save. Nothing below is needed unless
something goes wrong or you are configuring a deployment from the command line.

Setup runs `ensureBaseSchema` (`packages/airtable/src/schema.ts`) against the metadata API:
additive and idempotent — it creates missing tables, appends missing columns, and never
renames, retypes or deletes anything. Pressing the button again after a failure, or after an
upgrade adds columns, is the intended recovery path. A column that already exists with an
incompatible type is reported for a human to fix, not altered.

The token needs **four** scopes, not two: `data.records:read`, `data.records:write` (the
mirror) plus `schema.bases:read`, `schema.bases:write` (base listing and table creation). A
token with only the data scopes still mirrors — it just cannot run setup, and the page says so
in those terms.

## 1. The base schema

The sync itself does not create tables or columns — they must exist before the first sweep,
with these exact names (they are the keys in `packages/airtable/src/mapping.ts`, mirrored in
`BASE_SCHEMA` in `schema.ts`; `schema.test.ts` fails if the two drift). `typecast: true` is
sent on every write, so single-select options (Status, Kind, …) are created automatically as
values arrive — but tables and fields are not.

Step 3 on the Settings page builds all of this for you; the table below is the reference for
checking or hand-building a base.

Field types: single line text unless noted. Long text where marked ¶. ISO-8601 timestamp
strings are sent as strings — Airtable's typecast will coerce them into Date fields if you
prefer those; plain text also works.

| Table | Fields |
| --- | --- |
| `Events` | Name, Slug, Type, Location, Timezone, Starts At, Ends At, Website, Agenda Published (checkbox) |
| `Submissions` | Code, Title, Kind, Status, Description ¶, Format, Level, Language, Track, Room, Starts At, Ends At, Capacity (number), Speaker, Speaker Email, Rating (number, 2 dp), Notes ¶, Event |
| `Contacts` | Email, First Name, Last Name, Salutation, Honorific, Pronouns, Mobile Phone, LinkedIn, Twitter, Website |
| `Tasks` | Title, Description ¶, Target, Action, Due At, Required (checkbox), Event |
| `Reviews` | Submission, Submission Title, Reviewer, Reviewer Email, Total (number), Comment ¶, Conflict Of Interest (checkbox), Event |
| `Tracks` | Name, Color, Event |
| `Rooms` | Name, Capacity (number), Notes ¶, Event |
| `Tags` | Name, Color, Event |
| `Event Contacts` | Name, Email, Event, Company, Job Title, Biography ¶, Notes ¶, Speaker Status, Arrived At, Source, Added At, Prior Rating (number, 2 dp), Prior Rating Note |
| `Messages` | To, Subject, Template, Status, Error ¶, Contact, Event, Created At, Sent At |
| `Comments` | Submission, Submission Title, Author, Role, Kind, Body ¶, Event, Created At |
| `Pipeline` | Contact, Email, Stage, Score (number), Rationale ¶, Created At, Updated At |
| `Pipeline Activity` | Contact, Email, Kind, From Stage, To Stage, Body ¶, Author, Created At |
| `Files` | Filename, Content Type, Size KB (number, 1 dp), Uploaded By, Request, Event, Created At |
| `File Requests` | Title, Type, Instructions ¶, Due At, Max Size MB (number), Event |
| `Portal Responses` | Form, Contact, Email, Submission, Answers ¶, Submitted At, Event |

The last eight arrived after the first release (migration 0045). **An existing base gains them
by pressing "Create the tables in Airtable" again** — setup is additive, so the eight original
tables keep their data untouched. Until you do, Test connection reports them as missing.

There is deliberately **no `Forms` table** (form and question config is meaningless in a
spreadsheet — `File Requests` is mirrored because chasing one is real work, unlike editing a
form definition) and **no `Sessions` table** — a session is a scheduled submission
(workplan-9 §3). To get the "Sessions" view the domain model describes, create a filtered view
on `Submissions` once, in the base UI: *Starts At is not empty*.

Every row carries an `Event` field (the event's name), since all events on the deployment
mirror into this one base — filter or group by it as needed. The one exception is `Pipeline` /
`Pipeline Activity`: speaker sourcing is org-wide, and a prospect is enrolled long before
anyone knows which event they will speak at.

`Messages` is the one table that can get large — one row per email ever sent, growing without
bound, where every other table is bounded by the size of the conference. Watch the base's
record count if you run high-volume campaigns; Airtable's per-base record cap applies.

## 2. Personal access token

Create a PAT at <https://airtable.com/create/tokens> with:

- scopes: `data.records:read`, `data.records:write` — and `schema.bases:read`,
  `schema.bases:write` if you want the Settings page to list bases and build the tables
- access: just the base you created (or its workspace, if the base doesn't exist yet)

The base id is the `appXXXXXXXXXXXXXX` segment of the base's URL — or let **Find my bases** on
the Settings page fill it in.

## 3. Configure the deployment

```sh
# one-time, both pending as of 2026-08-11: 0016 (bulk-job claim) and 0017 (mirror schema)
npm run migrate:remote

wrangler secret put AIRTABLE_API_KEY   # the PAT
wrangler secret put AIRTABLE_BASE_ID   # appXXXXXXXXXXXXXX
```

Then flip the flag in `wrangler.toml` and deploy:

```toml
AIRTABLE_SYNC = "on"
```

With the flag on but either secret missing, the sweep logs a warning and no-ops — it never
throws, so the rest of the cron tick (email, reminders, bulk jobs) is unaffected.

## 4. First sync = backfill

There is no separate backfill step. The first sweep for each table finds no watermark row and
sweeps from epoch, so **every existing row mirrors on the first cron tick** after the flag
goes on. Writes are throttled to ~4 req/s (under Airtable's 5 req/s per-base cap) at 10
records per request, so a large event takes a while — progress is logged per table
(`[airtable] submissions: 214 created, 0 updated`) rather than running silently. Watch with:

```sh
wrangler tail --format pretty | grep airtable
```

Steady state after that is one cron tick (~1 minute) of latency per change.

## 5. Local development

`wrangler dev` never fires cron triggers on its own, so the sweep won't run locally unless you
kick it:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*+*+*+*+*"
```

(Older wrangler used `--test-scheduled` and `/__scheduled?cron=…`; that path 404s on the
current version. Wrangler prints the correct URL for your version at startup.)

Progress goes to the `wrangler dev` console. A table is logged only when it has rows to push,
so a sweep with nothing to do is **silent** — that is the steady state, not a failure.

Local secrets go in `.dev.vars` (see `.dev.vars.example`), paired with `AIRTABLE_SYNC = "on"`
there. Note the local D1 also needs `npm run migrate` for 0017. Don't point local dev at the
same base as production — every environment that can see the base will happily overwrite it.

## 6. Operational notes

- **Airtable edits don't survive.** The mirror is one-way overwrite: any cell edited in
  Airtable reverts the next time that row changes in D1. Treat the base as read-only.
- **Deletes propagate.** Hard-deleting a submission/contact/task/track/room in the app stages
  its Airtable record for deletion, along with the rows that cascade with it (a submission
  takes its reviews, comments and portal responses; a contact takes their roster rows,
  pipeline card and its activity); the next sweep removes them. Undoing an import stages the
  rows it created. Rows deleted directly in Airtable just get re-created on that row's next
  D1 edit.
- **A failing table doesn't stop the sweep.** Each table's pass is isolated: if one 422s
  (typically because it isn't in the base yet, the normal state between an upgrade and the
  next press of "Create the tables"), it is logged, its watermark stays put so its rows retry,
  and the remaining tables sync as usual.
- **updated_at maintenance differs by table.** The eight original tables rely on their routes
  keeping `updated_at` current; the eight added in 0045 have SQL triggers that do it for them,
  so a route that has never heard of the mirror still feeds it. The triggers deliberately skip
  writes that only set `airtable_record_id`, which is the sweep's own write-back.
- **Force a full re-push** (e.g. after wiping the base): `DELETE FROM airtable_sync_state;`
  re-runs the epoch backfill. If the base was wiped, also
  `UPDATE <table> SET airtable_record_id = NULL` for each mirrored table first — otherwise the
  sweep issues updates against rec ids that no longer exist.
- **Demo deployments:** the nightly `DEMO_RESET` seed replay deletes the demo event with raw
  SQL — that path does **not** stage Airtable deletes (only the app's delete routes do) — and
  re-inserts fresh rows with new ids. With the mirror on, the base would gain a full duplicate
  set of demo rows every night while the old ones orphan. Leave `AIRTABLE_SYNC = "off"` on the
  public demo.
