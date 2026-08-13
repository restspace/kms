# Workspace

**Sidebar:** Workspace (with Speakers, Submissions, Tasks, Reviews, Comments, Messages, Files,
and Events listed underneath)

The Workspace is where every record lives — speakers, submissions, tasks, and more — as a set of
list **tabs** you keep open side by side, with records opening as **detail tabs** right next to
whichever list you opened them from. This page covers what's common to every tab. For what's
specific to a particular kind of record, see its own page:

- [Speakers](workspace-speakers.md)
- [Submissions](workspace-submissions.md)
- [Tasks](workspace-tasks.md)
- [Reviews](workspace-reviews.md)
- [Comments](workspace-comments.md)
- [Messages](workspace-messages.md)
- [Files](workspace-files.md)
- [Events](workspace-events.md)

## How tabs work

Clicking an entry under **Workspace** in the sidebar opens that entity's list as a tab. Opening a
record from a list (double-click, or the row's own controls) opens it as a **detail tab** right
beside its parent list, rather than replacing the list — so you can keep both in view and switch
between them. Detail, create, and edit tabs can be closed; list tabs are permanent fixtures and
stay open.

## Controls common to every list tab

- **Sortable columns** — click a column header to sort by it; click again to reverse, and again
  to clear back to the default order.
- **Infinite scroll** — lists load more rows as you scroll; there's no page-number pagination.
- **Search box** — filters the active tab's list; it combines with whatever filter chips or
  dropdowns that tab has set (see each entity's own page for what's on offer there).
- **Export** — where available (not every tab has this), CSV and XLSX export buttons sit at the
  bottom-left of the list and respect your current filters and sort — you get exactly what's on
  screen, not everything.

## The global anchor filter

This is the Workspace's signature trick: pick a record in one tab, and every other open tab
narrows down to only what's related to it. Selecting a speaker, for instance, filters the
Submissions and Tasks tabs down to just theirs.

**To set it:**

- Click the small dot on a list tab's label to make that tab's currently selected row the global
  anchor.
- Or **shift-click** a row directly to anchor on it.
- **Ctrl/Cmd-click** (either method) adds the row as an *additional* anchor alongside any existing
  one, rather than replacing it — so you can filter by two related records at once.
- Right-clicking a tab label or a row opens a context menu with the same options, for keyboard or
  touch use.

**While it's active:**

- A small pushpin icon appears on any tab whose list is currently narrowed by the anchor.
- A **"Filtered by: `<tab>` — `<row>`"** chip appears near the header, with a **✕** to clear it.

## Next step

Once you've got a feel for the Workspace, [Reviewing and deciding on submissions](reviewing-submissions.md)
walks through the day-to-day flow of working the Submissions tab.
