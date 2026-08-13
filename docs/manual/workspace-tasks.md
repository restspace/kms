# Workspace → Tasks

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below, and [The speaker portal](speaker-portal.md) for what a task looks like from the
speaker's side.

## List

Default columns: Task, Assignee (falls back to email if there's no name on file), For (the
submission code it's tied to, if any), Status, Due (shown in red and bold if overdue and not yet
complete), Completed, Event.

Each row here is one **assignment** of a task to a person — not the task definition itself (see
below).

**Filters:** a single state chip row — **All / Open / Complete / Overdue** — plus the header
search box. There are no bulk actions on this tab.

## Detail

Title with a status chip, its action type and whether it's required, the assignee, the linked
submission (if any), and its due/completed dates. An **Edit task** control lets you change the
title, due date, and required flag — but deliberately not the description, so a quick edit here
can't accidentally blank it out. A files panel shows anything the task produced (e.g. an uploaded
file).

## Creating a task

Rows in this tab are assignments, but **+ New** creates the underlying **task definition** — there
is no separate edit form for that shape, only this create form. Fields worth knowing:

- **Target** — Contacts or Submissions.
- **Assignment mode** — Manual or Automatic.
- **Trigger** (automatic mode) — None, On accept, or On schedule.
- **Action type** — Acknowledge, File upload, Portal form, or External link.
- **Assign to** (contact target) — either search and pick specific people, or choose a named
  audience (e.g. "Accepted speakers"), which shows a live headcount as you select it — a faster
  path than picking people one by one when you mean "everyone in this group."

## Export

Standard CSV/XLSX export is available; there's no import for this tab.
