# Workspace → Events

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below, and [Getting started](getting-started.md#events) for what an event is. This tab lists
**every** event your organisation runs, regardless of which one is currently selected in the
sidebar — it's the way you jump between events, not a view scoped to just one.

## List

Columns: Name, Dates, Agenda (a **Published** or **Draft** chip), Speakers (count), Submissions
(count), Your role. Sortable columns are Name and Dates. There are no filter chips or bulk
actions.

## Switching events

> **This is the one tab where clicking a row doesn't open a detail tab.** Clicking anywhere on an
> event's row immediately switches your whole admin session to that event — the same as picking
> it from the sidebar's event switcher.

If you reach a row's detail tab some other way (for example, keyboard navigation), it shows the
same Agenda status, Speakers count, Submissions count, and Your role, plus an explicit **Switch to
this event** button that does the same thing the row-click normally does.

## Creating an event

**+ New event** doesn't open an inline tab — it immediately opens the **Create Event** dialog,
with:

- Name, and a Slug that's auto-suggested from it (editable — lowercase letters, numbers and
  hyphens only) and drives the event's public URLs.
- Type (Conference / Workshop / Summit / Meetup / Other), Website, Location, Timezone (a
  searchable list, defaulting to your current event's), Start and End dates (validated so end
  isn't before start), and a Description (up to 1000 characters).
- Repeatable **Rooms** and **Tracks** groups — add or remove as many rows as you need to seed the
  new event with its starting rooms and tracks, rather than adding them one at a time afterwards
  in Settings.

## Export

There are no export buttons on this tab.
