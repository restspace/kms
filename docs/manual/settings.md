# Settings

**Sidebar:** Settings

A single scrolling page of cards, each covering one area of event configuration. Every card edits
this **event only** — nothing here is shared across events unless the card says so.

> **Note:** Settings needs a reasonably wide window — on a phone it's replaced with a summary
> (event, timezone, slug) and a link to the speaker portal, since the tables here don't fit a
> narrow screen usefully.

## API tokens

Bearer tokens for the REST API. A token can reach every event in your organisation — the specific
event is chosen in the URL you call, not by the token itself.

- Enter a name and click **Create token** — the secret is shown exactly once, with a **Copy**
  button; there's no way to view it again later, only revoke and create a new one.
- **Revoke** disables a token immediately; requests already using it start failing right away.
  Asks for confirmation first.

## Rooms, tracks & formats

Three columns, each following the same pattern: **+ Add room** / **+ Add track** / **+ Add
format** appends a new row with a placeholder name; edit any field and it saves the moment you
click away (there's no separate Save button). Each row has a **remove** control that asks for
confirmation.

- Changes here appear in the Agenda's Add/Move Session dialogs immediately.
- **Formats** also drive the Format dropdown on the public submission form — put the default
  session length in the name itself (e.g. "Talk (30 min)") so new sessions of that format pick it
  up automatically.
- Deleting a room or track doesn't unschedule sessions already using it — they keep their time
  slot but lose the room/track reference. Deleting a format doesn't change existing submissions'
  recorded format text; it just stops being offered going forward.

## Speaker fields

Custom fields shown on every speaker record for this event — for example a "Travel preferences"
picklist, or a free-text field the built-in profile fields don't cover.

- **+ Add field**, then set its **label** and **type** (Text / Select / Multiline). A Select type
  reveals an **options** box — comma-separated choices.
- **↑ / ↓** reorder fields; the order here is the order they appear on the Speakers record form.
- **Remove** deletes the field *and* any values already recorded against it on speakers — there's
  no way to hide it while keeping the data.
- Renaming a field only changes its label — values recorded under it, and its identity, survive
  the rename.

## Speaker statuses

Prospect, Invited, Awaiting reply, Confirmed, and Declined are always available and aren't listed
here as editable rows. Use **+ Add status** to add this event's own extra statuses (e.g. "On the
fence") — they show up in the Speakers tab's status filter and status control immediately.
**Remove** takes a status out of the picklist; anyone already carrying it keeps the value, they
just can't be newly set to it again.

## Email templates

One row per system email this event can send, each with a built-in default wording so nothing is
blank on day one.

- **Edit** expands the row into a Subject and Body editor. **Save override** stores a
  replacement for this event only; **Reset to default** discards your override and reverts to the
  built-in wording (only enabled once you've actually overridden it).
- The **Source** column shows **customised** or **default** so you can see at a glance which
  templates you've touched.
- A merge-field reference above the table lists what every template can use (e.g.
  `{{submission.title}}`); an individual template's built-in default wording is the best
  reference for what's available specifically to it. A merge field that doesn't resolve renders
  as empty text rather than an error.

## Chase inbox

One control: **Chase mode**, either **Auto** (the default — reminders send themselves on
schedule, with no review step) or **Assisted** (every reminder is staged as an editable draft on
the [Speaker Tracking dashboard](dashboard.md#speaker-tracking) instead, and nothing sends until a
human clicks Send). Switching modes takes effect immediately and shows a short confirmation note.

## Settings history

Every change to this event's own details (name, slug, dates, description, and so on) is recorded
here, each with a **Restore** action that writes the earlier values back — restoring itself
creates a new history entry, so nothing is ever truly lost.

## API docs

Links to the interactive API reference and the raw OpenAPI spec, plus this event's ID and a ready
example `curl` command using your token, for anyone integrating externally.

## Demo data

**Reset demo data** wipes every record for the demo event and replays the seed data from scratch.
This only exists to keep the public demo environment fresh — it's not something you'd normally
click on a real event, and it asks for confirmation because it cannot be undone.
