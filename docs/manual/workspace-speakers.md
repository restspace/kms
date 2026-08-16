# Workspace → Speakers

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below.

## List

Default columns: First name, Last name, Email, Company, Job title. Viewing a single event adds
Status (a coloured chip — Confirmed, Declined, or whatever this event's own status labels say —
see [Settings](settings.md#speaker-statuses)) and Event. Viewing **All events** instead shows an
Events count chip per person (hover it to see which events).

**Filters:**

- A status chip row — **All / Prospect / Invited / Awaiting reply / Confirmed / Declined** plus
  any custom statuses this event has added (single-event view only).
- Debounced **Company** and **Job title** text filters (both views).
- In the **All events** view, the status chips are replaced by an **Events** filter: Any / On some
  event / On no event / a specific event.
- The header search box combines with all of the above.

There are no bulk actions on this tab — no row checkboxes.

## Toolbar

- **＋ Existing** (single-event view) — attach a person already known to your organisation to the
  current event.
- **＋ New contact** (All-events view) — create a brand-new person record with no event attached
  yet.
- **⧉ Duplicates** — review and merge possible duplicate people across the organisation.
- **☆ Save segment** (single-event view) — freeze either the rows you've checked or your current
  filters as a named, reusable segment.
- **☰ Segments** (single-event view) — browse, open, or delete your saved segments.
- **↥ Import** — bring in speakers from a CSV or Excel file, with column mapping and a dry-run
  preview before anything's written. Requires a single event selected in the sidebar — it can't
  target "All events."
- Standard CSV/XLSX export.

## Creating a speaker

The **＋ New** dialog in the single-event view includes full profile fields and warns you if
another contact with the same name already exists, offering a **Merge instead?** link straight
into Duplicates. If you try to save with an email that's already in use, you get an **Open
existing contact** link rather than a bare error — so you can go finish what you meant to do.

## Detail

Shows a headshot (uploadable, single-event view only), the speaker-status control (single-event
view only), contact details, any custom fields your event has added, biography, internal notes,
social links, their submissions, cross-event history, and — in single-event view — a history of
profile edits with the ability to restore an earlier version.

In the **All events** view, a person's company, job title, status, biography and custom fields are
one event's answer about them — profile details live per event, not per person. A **Profile from**
line names which event that is, and an edit made here writes back to that same event.

- **Edit** — edit the record.
- **Invite to portal** — sends (or re-sends) their portal sign-in link. Works even if you don't
  otherwise have edit rights.
- **Delete from organisation** — removes the person entirely, across every event. This is
  different from removing them from just the current event via the row's own delete, which only
  detaches them from this event and leaves the underlying contact intact.
