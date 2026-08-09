# 07 — Agenda & Scheduling

Covers brief requirement **#5 — "Drag-and-drop schedule and agenda building, with automatic
conflict detection across rooms and tracks, viewable by list, day, week, track, or room."**

Reference screenshot 24 (Agenda with List / Day / Week / Month / Rooms / Conflicts tabs).

---

## 1. Screen (`/app/e/:event/agenda`)

Header: "Agenda — Manage your event agenda and schedule".

**View tabs:** `List · Day · Week · Month · Rooms · Conflicts`
(the brief also names a *track* view — implement it as a grouping option available in Day/Week,
"Group by: Room | Track").

**Toolbar:** Search sessions · layout toggle · **Saved Views ▾** · **Columns** · **Sort** ·
**Filter** · **Drafts** · **⋯ Options** · **+ Add Session**

**Left tray:** *Unscheduled* — accepted submissions with no time or room, searchable and
filterable by track/format. Badge shows the count; this is the source for drag-and-drop.

Empty state: "Nothing here yet — Sessions will appear here in list view."

---

## 2. Views

| View | Layout |
|---|---|
| **List** | Grid of sessions with configurable columns (title, speakers, track, room, start, end, duration, status, capacity, tags). Same column/filter/sort machinery as the Abstracts grid. |
| **Day** | Single-day calendar; columns = rooms (or tracks); rows = time at 15-minute granularity; current-time indicator; day switcher constrained to the event dates. |
| **Week** | Seven-day columns with stacked session blocks; useful for multi-day events. |
| **Month** | Month cells with session counts and a click-through to the day. |
| **Rooms** | Room-major board — one lane per room across the event days; the primary drag surface. |
| **Track (grouping)** | Day/Week grouped by track instead of room, so programme leads can see their own stream. |
| **Conflicts** | List of every detected conflict; see §4. |

All calendar views render in the **event timezone**, with the abbreviation shown in the header
(e.g. "Oct 12, 2026 · PDT").

---

## 3. Drag-and-drop scheduling

| Interaction | Behaviour |
|---|---|
| Drag from the Unscheduled tray onto a slot | Sets `starts_at`, `ends_at` (using the session's default duration, falling back to 30 min), and `room_id` |
| Drag a block within the calendar | Moves time and/or room; snaps to 5-minute increments (configurable) |
| Drag a block edge | Resizes duration; minimum 5 minutes |
| Drag back to the tray | Unschedules (clears time and room) |
| Multi-select + drag | Moves a group, preserving relative offsets |
| Keyboard alternative (a11y) | Focus a session, press `M` → "Move session" dialog with room + date + time inputs |

**Feedback:** the drop target highlights; a live ghost shows the resulting time range; if the
drop would create a conflict the ghost turns red and a tooltip names the clash. Dropping is
still permitted (organisers sometimes need a temporary overlap) but the session is flagged.

**Persistence:** optimistic update, then `PATCH /api/v1/sessions/:id/schedule`. On server
rejection the block animates back and a toast explains why. **Undo** (⌘Z / a toast action)
reverts the last scheduling change.

---

## 4. Conflict detection

Runs on every write and on demand; results cached per event and invalidated by any schedule change.

| Code | Severity | Rule |
|---|---|---|
| `ROOM_DOUBLE_BOOKED` | error | Two scheduled sessions overlap in the same room |
| `SPEAKER_DOUBLE_BOOKED` | error | A participant appears on two overlapping scheduled sessions |
| `OUTSIDE_EVENT_WINDOW` | error | `starts_at` or `ends_at` falls outside the event dates |
| `ROOM_CAPACITY_EXCEEDED` | warning | Session `capacity` > room `capacity` |
| `TRACK_OVERLAP` | warning | Two sessions of the same track overlap (attendees cannot see both) |
| `SPEAKER_TRAVEL_GAP` | warning | Same speaker in different rooms with < 10 minutes between sessions |
| `UNSCHEDULED_ACCEPTED` | info | Accepted session with no time slot — drives the dashboard nudge *"1 accepted session still needs a time slot on the agenda"* |
| `MISSING_ROOM` / `MISSING_TIME` | info | Partially scheduled |

**Overlap definition:** half-open intervals — `a.start < b.end && b.start < a.end`. Sessions
that merely touch (one ends exactly when the next begins) do **not** conflict.

**Algorithm:** sort scheduled sessions by `starts_at`; sweep with an active set keyed by room and
by participant. O(n log n) — comfortably fast for the 500-session target, run in the Worker on
each mutation and cached in KV.

### Conflicts view
Each row: severity icon, code, plain-English description, the records involved (linked), and
**Resolve** actions — *Move session*, *Change room*, *Remove speaker*, *Ignore this conflict*
(ignored conflicts are remembered per conflict signature and shown in a collapsed "Ignored" section).

In the calendar, conflicting blocks get a red left border and a warning icon; hovering lists the
conflicts. A persistent counter chip on the Conflicts tab shows `errors / warnings`.

---

## 5. Session editing

Opening a block (or **+ Add Session**) shows: Title, Description, Starts At, Ends At (with a
duration helper), Room, Track, Format, Capacity, Level, Language, Tags, Participants (with roles),
Files, Status, Client Session ID, and internal notes.

Sessions created directly on the agenda are stored as submissions with `source = manual` and
`status = accepted` so there is one pipeline (see [02 §4](02-domain-model.md)).

---

## 6. Publishing & communications

- **Publish agenda** (header control, Published/Draft chip) sets `events.agenda_published`
  and gates the public agenda feed `GET /e/:slug/agenda.json` (404 while unpublished).
  A public agenda *page* and embeds remain unbuilt.
- Confirming or changing a session's schedule triggers the calendar-invite flow in
  [08 §Calendar invites](08-communications.md): a first schedule sends `METHOD:REQUEST`; a
  time/room change re-sends with `SEQUENCE + 1`; unscheduling sends `METHOD:CANCEL`.
- Bulk action **"Send schedule confirmations"** enqueues a background bulk job (202 +
  `job_id`); the cron sweep fans the sends out and the UI polls job progress. Invites
  therefore appear minutes after the click, not synchronously.
- Invited sessions can never change silently — enforced **server-side**: a schedule
  change on a session with a live `METHOD:REQUEST` invite is refused
  (`409 invite_notify_required`) unless the request carries `notify` (send updates) or
  `notify_ack` (operator explicitly declined). The client's "notify speakers?" prompt is
  a UX layer over that guard, so stale client state cannot bypass it (FR-COMM-6).
- Capacity is editable in the Move/Add Session dialogs and persists to
  `submissions.capacity`, so `ROOM_CAPACITY_EXCEEDED` (FR-AGENDA-6) is live.

---

## 7. Performance notes

- Only the visible date range is fetched; sessions are cached client-side per day.
- Drag interactions are pure client state; the server call is debounced to the drop event.
- The conflict set for the visible range is computed server-side once and streamed with the day's
  sessions, so blocks render already flagged.
- Target: 500 sessions across 3 days renders in < 300 ms and drags at 60 fps.

---

## 8. Acceptance tests

1. Dragging an accepted session from the tray onto Main Stage 10:00–10:30 persists across reload.
2. Dropping a second session into the same room and time raises `ROOM_DOUBLE_BOOKED`, flags both
   blocks, and increments the Conflicts tab counter.
3. Assigning the same speaker to two overlapping sessions in different rooms raises
   `SPEAKER_DOUBLE_BOOKED`.
4. Sessions that touch exactly at a boundary raise no conflict.
5. Resizing a block updates the duration and re-runs conflict detection within 100 ms.
6. Unscheduling returns the session to the tray and clears its conflicts.
7. Day, Week, Rooms and the track grouping all show the same session consistently.
8. The keyboard "Move session" dialog achieves everything drag-and-drop does.
