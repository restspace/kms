# Workspace → Submissions

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below, and [Reviewing and deciding on submissions](reviewing-submissions.md) for the
day-to-day workflow this tab supports.

## List

Default columns: Code, Title, Status (an inline-editable dropdown — changing it here writes
immediately), Rating (click to cycle sort descending → ascending → off; hover a value to see how
many reviews it's based on), Notified (a checkmark once decision emails have gone out), Format,
Track, Submitter, Starts, Ends, Room, Event.

**Starts / Ends / Room** are the session's place on the agenda. An accepted submission *is* the
session — scheduling it on the [Agenda](agenda.md) fills these in on the same row, so you can see
what's placed without leaving the Workspace. Times show in the event's timezone on a 24-hour
clock, and an unscheduled row shows a dash. Starts and Room are sortable; either way round,
unscheduled rows sort last, so sorting by Starts ascending gives you a running order rather than
a wall of blanks. Ends shows the time alone — its date is the one in Starts.

With the schedule columns in play the list is wider than most screens, so it scrolls sideways
rather than squeezing Title down to a few words. On a phone each row's bottom line carries the
whole schedule instead — `11th Aug 15:30 TO 16:30 Hall B`, or `Unscheduled`.

**Filters:**

- A status chip row covering every submission status.
- **Under-reviewed** — a toggle that narrows to submissions with fewer reviews than your
  coverage threshold, functioning as a worklist rather than just a sort.
- A review-coverage bar showing counts for whatever's currently filtered.
- The header search box.

## Bulk actions

This is the one Workspace tab with bulk actions. With nothing checked, a subtle hint near the
bottom of the list reminds you that checking rows unlocks these actions; check one or more rows
and it's replaced by the action bar:

- **→ Accept Queue / → Decline Queue / → Pending** — move every checked row to that status at
  once. The list updates immediately, without needing a manual refresh.
- **Send decision emails** — previews the batch (counts and any warnings) before sending, and
  includes an opt-in checkbox for asking for employer approval on the covered submissions. See
  [Reviewing and deciding on submissions → Making and sending decisions](reviewing-submissions.md#making-and-sending-decisions)
  for what happens next.

The action bar (and any checked rows) is specific to this tab — switching to another Workspace
tab clears the selection rather than leaving the bar floating over unrelated data.

## Toolbar

- **↥ Import** — CSV/XLSX import of sessions or submissions, with column mapping and a dry-run
  preview.
- **↓ Files** — downloads a ZIP of the current-version files for every checked submission;
  disabled until you check at least one.

## Detail

Title, status, and approval chips, plus the mean rating. A set of inline controls that each
autosave independently (with their own Saving/Saved feedback): Status, Approval (Not asked and
onward, with a note field), and a **Visible in public agenda** checkbox controlling whether this
submission can appear on the public agenda. An **Edit submission** button opens the full editor.

Below that: description, format, track, evaluation plan, tags, the raw form answers (with
anything already shown as a canonical field filtered out of the raw list), any unmapped columns
carried over from an import, an internal-notes box (organiser-only, explicit Save), a
participants editor (add/remove), attached files, a content edit history with restore, reviews
grouped by evaluation round with each round's mean score, and a discussion thread of reviewer
rationales and free comments.

## Creating or editing

Both double-clicking a row and **+ New** open a dedicated form (not the generic record form) with
Track, Room, Format, Level, and Language pickers. Level auto-fills from the submitter's original
form answer if it's otherwise blank. Status can only be set at creation — after that, change it
from the grid's inline status dropdown, not the edit form.
