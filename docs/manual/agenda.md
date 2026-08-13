# Agenda

**Sidebar:** Agenda

Where accepted sessions become an actual schedule. The header shows a **Draft / Published**
status chip and a running summary — unplaced, pencilled, and conflicting session counts.

## Views

Tabs across the top: **List, Day, Week, Month, Rooms, Conflicts**. The **Conflicts** tab carries
a live error/warning count chip whenever problems exist. **Day** adds a day switcher (‹ previous
/ date / next ›) when your event spans more than one day.

**Group by** — a dropdown on Day view, letting you group the grid by **Room** or **Track**
instead (Week always groups by room).

> **Note:** on a narrow window, Day/Week/Month/Rooms show a "needs a wider window" notice; List
> and Conflicts stay usable on any size.

## Toolbar

- **Search sessions** — filters every view by code, title, or speaker name.
- **Manage rooms & tracks** — a link out to Settings; rooms and tracks aren't edited from here.
- **Auto-place (N)** — automatically drops every unscheduled session into a free slot. This is
  provisional: results are *pencilled in*, not finalised, until you confirm them.
- **Confirm placements (N)** — shown only once there are pencilled sessions; accepts every
  auto-placed slot into the real schedule at once.
- **Send confirmations (N)** — emails the calendar-invite confirmation to every scheduled session
  that doesn't have one yet (pencilled sessions are excluded from the count). This runs as a
  background job with a live progress line ("Queued X of Y…", then a sent/failed summary).
- **Publish / Unpublish** — toggles whether the public agenda feed is live. Unpublishing asks for
  confirmation. Publishing warns you if any accepted sessions are still unscheduled (listing up to
  six of them) and lets you publish anyway or stay in draft.
- **+ Add Session** — opens the Add Session dialog (see below).
- **Undo** — ⌘Z / Ctrl+Z reverts the last schedule change; an auto-place batch undoes as one unit,
  not session by session. A toast also offers an **Undo** link at the moment of the change.

## The unscheduled tray

Shown on Day, Week, and Rooms. Lists every accepted session with no time slot, with its own
**Search**, **All tracks**, and **All formats** filters. Each card shows code, format, title, any
preset track/room, the speakers, and an **↗ Open submission in Workspace** link. Dropping a
scheduled block back onto the tray unschedules it.

## Scheduling

- **Drag** a session from the tray onto a slot, or drag an existing block to move it — drops snap
  to 15-minute increments; dragging a block's bottom edge resizes it, snapping to 5 minutes.
- While dragging, a live ghost preview follows the cursor and turns **red** if the drop would
  create a conflict — the drop is still allowed, just clearly flagged.
- Dropping on a column *header* rather than a time slot sets only the day, clearing any room.
- A session with a preset room/track but no time renders as a dashed "no room assigned" band.
- **Keyboard/non-drag alternative** — press `M`, or double-click any card, to open **Move
  session**: Date, Start time, Duration (minimum 5 minutes), Capacity (optional, blank = no
  limit), and Room (shown with its capacity). An **Unschedule** button appears if it's currently
  scheduled, alongside **Cancel** and **Save**, plus an **Open submission ↗** link.
- If the session already has a live calendar invite out, saving a change prompts you to send an
  updated invite (or a cancellation, if unscheduling) — declining still applies the change, but
  the choice is recorded either way.

## Conflicts

Errors: **room double-booked**, **speaker double-booked**, **outside the event's dates**.
Warnings: **speaker likely double-booked**, **room capacity exceeded**, **same-track overlap**,
**speaker travel gap** (under 10 minutes between rooms).

The Conflicts tab groups everything into Errors / Warnings / Info sections. Each row lists the
sessions involved (click to open Move) and offers **Move session**, **Change room** (opens Move
on the other session in the clash), **Remove speaker** (only for a speaker-identity conflict, asks
for confirmation), and **Ignore** — ignored conflicts collapse into a separate "Ignored (N)"
section with a **Restore** option. Outside the Conflicts tab, a banner shows your top three live
conflicts with a **Review conflicts** button.

## Adding or editing a session

**+ Add Session**: Title (required), Track, Format (choosing one fills in a default duration
unless you've already changed it yourself), Room, Date (defaults to Unscheduled), Start,
Duration, Capacity. A session created this way is stored as already accepted.

## Next step

Keep an eye on how things are progressing with the [dashboard](dashboard.md).
