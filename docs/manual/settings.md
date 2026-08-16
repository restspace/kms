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

## Tags

Free-form labels that cut across tracks — "keynote material", "needs AV", "first-time speaker".
One flat list, name-ordered, each row a **name** and a **colour**.

- **+ Add tag** opens an inline name box; the tag is only created when you press Enter on a
  non-empty name, so a stray click leaves nothing behind. Escape cancels.
- Editing a name or colour saves the moment you click away. Names must be unique within the event
  (case doesn't count as a difference) — a clash is refused and the stored name comes back.
- **Remove** (×) asks first, and tells you how many submissions and contacts will lose the tag.
  After deleting, an **Undo** appears for 15 seconds; it puts the tag back *with* everything it
  was on. Once that window passes there's no way back.

Where tags are used: attach them to a submission from its detail panel in
[Workspace → Submissions](workspace-submissions.md#tags), filter the Submissions list by one, add
them automatically with a form's [routing rules](forms.md), and offer them to submitters through a
form's Tags question. An [import](workspace-submissions.md) creates any tag name it meets that
isn't here yet, so the list can grow without you adding rows by hand.

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

## Submission notifications

One row per form, showing how many people are set to be alerted on new and on updated
submissions.

- **Edit** expands the row into two checkbox lists — **new submissions** and **updated
  submissions** — of this event's staff (owners, admins and reviewers). Tick who should be
  emailed, then **Save recipients**. Leave both empty and nobody gets an admin alert for that
  form.
- Only staff with an owner, admin or reviewer role on the event can be picked; if someone's
  missing, add them to the event's team first.
- This picks *who* gets the alert. The wording of the alert emails themselves —
  `submission_received_admin` and `submission_updated_admin` — is edited above, under **Email
  templates**, same as every other system email.

## Automatic tasks

A rule assigns itself when its trigger fires, rather than waiting for an organiser to hand it to
someone — today that means the **On accept** trigger only, which fires when a submission's
acceptance is actually *sent* (queuing an accept isn't enough by itself; Send Decisions is what
sets it off). This is a different thing from the Workspace → Tasks tab, which lists individual
assignments, one row per assignee — a rule with nobody matched yet has no assignment rows to show
there, so it lives here instead, visible whether or not it's fired for anyone yet.

- Each row is one rule: its title, trigger, target (contacts or submissions), action, and how many
  assignments it's produced so far.
- **+ Add automatic task** and **Edit** both open the rule in the Workspace Tasks tab's task
  form — the same form **+ New task** uses there, minus the assignee/audience pickers (editing a
  rule never hands it to anyone directly; only its trigger does that). Save or Cancel brings you
  straight back here.
- Editing a rule never touches assignments already made — raising a due date, say, doesn't change
  anyone already assigned under the old one.

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

The spec is written for automated callers as much as human ones: every endpoint names the exact
fields it returns, the filter vocabulary matches the one the workspace lists use, and the
introduction spells out what the API deliberately *won't* do — most importantly, that changing a
submission's status through the API never emails the speaker.

If you're pointing an AI assistant or agent at the API rather than writing the integration
yourself, give it **`/llms.txt`** instead. That's a short plain-text briefing at the site root, in
the format agents are built to look for: the API's base address, how to authenticate, where to
start, the handful of conventions that trip callers up, and links on to the full spec. One URL and
the assistant has its bearings.

## Demo data

**Reset demo data** wipes every record for the demo event and replays the seed data from scratch.
This only exists to keep the public demo environment fresh — it's not something you'd normally
click on a real event, and it asks for confirmation because it cannot be undone.

**Send all contact email to** is an optional address for anyone testing the demo. Fill it in and
every seeded contact is rewritten to a distinct variant of it when you reset: Ada Lovelace becomes
`you+ada@…`, Grace Hopper `you+grace@…`, and so on. Mail providers deliver all of those to the
plain address, so every decision email, reminder and portal invite the demo sends lands in one
mailbox you can actually open — while the **To:** line still tells you which speaker each message
was meant for.

- Organiser accounts (owners and admins) keep their real address, so you don't lock yourself out
  of the demo you're testing.
- The address is saved when you reset, and reapplied by the nightly reset — you don't have to
  retype it every day.
- The same field is on the public front-door page's **Reset demo data** button too, for anyone
  testing the demo who isn't signed in — it shares the saved address with this screen, so setting
  it here means it's already filled in there, and vice versa.
- Clear the field and reset to put the seeded `@example.com` addresses back.
