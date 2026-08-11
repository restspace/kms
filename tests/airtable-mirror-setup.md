# Airtable mirror — setup instructions

Companion to [workplan-9-airtable-mirror.md](workplan-9-airtable-mirror.md), which is now
built. The mirror is one-way (D1 → Airtable), off by default, and mirrors into **one global
base** — a single-tenant-deployment feature (workplan-9 §5 option (b)).

## 1. Create the Airtable base

The sync does not create tables or columns — they must exist before the first sweep, with
these exact names (they are the keys in `packages/airtable/src/mapping.ts`; renaming one there
means renaming the Airtable column too). `typecast: true` is sent on every write, so
single-select options (Status, Kind, …) are created automatically as values arrive — but
tables and fields are not.

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

There is deliberately **no `Forms` table** (form config is meaningless in a spreadsheet) and
**no `Sessions` table** — a session is a scheduled submission (workplan-9 §3). To get the
"Sessions" view the domain model describes, create a filtered view on `Submissions` once, in
the base UI: *Starts At is not empty*.

Every row carries an `Event` field (the event's name), since all events on the deployment
mirror into this one base — filter or group by it as needed.

## 2. Personal access token

Create a PAT at <https://airtable.com/create/tokens> with:

- scopes: `data.records:read`, `data.records:write`
- access: just the base you created

The base id is the `appXXXXXXXXXXXXXX` segment of the base's URL.

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
wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

Local secrets go in `.dev.vars` (see `.dev.vars.example`), paired with `AIRTABLE_SYNC = "on"`
there. Note the local D1 also needs `npm run migrate` for 0017. Don't point local dev at the
same base as production — every environment that can see the base will happily overwrite it.

## 6. Operational notes

- **Airtable edits don't survive.** The mirror is one-way overwrite: any cell edited in
  Airtable reverts the next time that row changes in D1. Treat the base as read-only.
- **Deletes propagate.** Hard-deleting a submission/contact/task/track/room in the app stages
  its Airtable record (and cascaded reviews) for deletion; the next sweep removes it. Rows
  deleted directly in Airtable just get re-created on that row's next D1 edit.
- **Force a full re-push** (e.g. after wiping the base): `DELETE FROM airtable_sync_state;`
  re-runs the epoch backfill. If the base was wiped, also
  `UPDATE <table> SET airtable_record_id = NULL` for each mirrored table first — otherwise the
  sweep issues updates against rec ids that no longer exist.
- **Demo deployments:** the nightly `DEMO_RESET` seed replay deletes the demo event with raw
  SQL — that path does **not** stage Airtable deletes (only the app's delete routes do) — and
  re-inserts fresh rows with new ids. With the mirror on, the base would gain a full duplicate
  set of demo rows every night while the old ones orphan. Leave `AIRTABLE_SYNC = "off"` on the
  public demo.
