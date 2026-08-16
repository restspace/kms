# Workspace → Submissions

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below, and [Reviewing and deciding on submissions](reviewing-submissions.md) for the
day-to-day workflow this tab supports.

## List

Default columns: Code, Title, Status (an inline-editable dropdown — changing it here writes
immediately), Rating (click to cycle sort descending → ascending → off; hover a value to see how
many reviews it's based on), Notified (a checkmark once decision emails have gone out), Format,
Track, Tags, Submitter, Starts, Ends, Room, Event.

**Tags** is a read-only comma-separated list in name order, a dash when the submission has none;
hover to see the full list if the cell runs out of room. Tags are attached and removed from the
[detail panel](#tags), not from the grid.

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
- **Tag** — narrows to submissions carrying one tag. It only appears once the event has at least
  one tag (see [Settings → Tags](settings.md#tags)); one tag at a time, and "All tags" clears it.
- A review-coverage bar showing counts for whatever's currently filtered.
- The header search box.

## Bulk actions

This is the one Workspace tab with bulk actions. With nothing checked, a subtle hint near the
bottom of the list reminds you that checking rows unlocks these actions; check one or more rows
and it's replaced by the action bar:

- **→ Accept Queue / → Decline Queue / → Pending** — move every checked row to that status at
  once. The list updates immediately, without needing a manual refresh, and the rows you moved
  stay checked afterward — handy when the next step is acting on the same rows again, like
  sending their decision emails.
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

Below that: an editable row of **tags** (see below), then description, format, track, evaluation
plan, **Routed by** (the [routing rules](forms.md) that put it there, if any fired), the raw form
answers (with
anything already shown as a canonical field filtered out of the raw list), any unmapped columns
carried over from an import, an internal-notes box (organiser-only, explicit Save), a
participants editor (add/remove), attached files, a content edit history with restore, reviews
grouped by evaluation round with each round's mean score, and a discussion thread of reviewer
rationales and free comments.

### Tags

The detail panel's tag row is editable, not just a readout — this is where a submission gets
labelled after it arrives (the public form and imports are the only other things that tag one).

- Each tag is a chip in its own colour; its **×** takes it off.
- **+ Add tag…** lists this event's tags that aren't already on this submission. Picking one
  attaches it immediately.
- **New tag…** in that same dropdown opens a name box: Enter creates the tag for the whole event
  *and* attaches it here in one step. Typing a name the event already has attaches that existing
  tag rather than complaining about the duplicate.

Every change saves straight away; the tags come back in name order.

## Creating or editing

Both double-clicking a row and **+ New** open a dedicated form (not the generic record form) with
Track, Room, Format, Level, and Language pickers. Level auto-fills from the submitter's original
form answer if it's otherwise blank. Status can only be set at creation — after that, change it
from the grid's inline status dropdown, not the edit form.

Changing **Track** does more than move the label: it also updates the submitter's own Track
answer, so the record and the answer it came from can't disagree. If your form
[routes on the track](forms.md), the rules re-run and the evaluation plan and tags follow the new
one. That also means the Track picker locks once the submission has reached an accept or decline
queue and a rule keys off it — it shows the reason under the field.
