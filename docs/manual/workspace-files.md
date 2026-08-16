# Workspace → Files

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below.

## List

Default columns: File (the filename, with a small **↗** link that opens the raw file directly in
a new tab — separate from clicking the row itself), Uploaded by, For (the submission code, or the
speaker's name for uploads that aren't tied to a submission, like a headshot), **Session**, Size,
Versions (how many versions exist), Uploaded, Event.

**Session** is worked out for you: from the session the upload task named, or — when the task was
addressed to the speaker rather than to one of their sessions — from the speaker's own accepted
session in this event. If a speaker has two accepted sessions there is no safe answer, so the
column stays empty until you say which one it is (see **Detail** below). The search box matches
session codes and titles as well as filenames, so it doubles as a session filter.

> **Note:** one row here represents a whole **version history**, not a single upload — re-uploading
> the same file (a revised deck, say) adds a version to the same row rather than creating a new
> one.

There are no filter chips, status tabs, or bulk actions on this tab, and it has no export buttons.

## Detail

Shows the uploader, what it's for (only shown if different from the uploader — e.g. someone else
uploaded on a speaker's behalf), the **Session** the file belongs to, size, content type, and the
latest upload date and version count, all reflecting the current version even if the list row
hasn't refreshed yet.

Next to Session is **Link to session** (or **Change**): pick any of the event's sessions, or
"— Not linked —" to detach it. Linking moves the whole version history, not just the current file,
and the file then appears on that session's Files panel in
[Workspace → Submissions](workspace-submissions.md) — the same place its speaker would look for it.

Below that, the full **version list**: every version with its own download link, a "Current" tag
on the live one, and its own size/date/uploader. Below the version list is a **comment thread**
tied to this file — each comment shows the author's name and role (Speaker vs. Organiser) and,
once there's more than one version, which version it was about ("on v2"). You can post a reply
from here.

> **Note:** uploading a new version or replacing the file isn't available from this detail panel —
> that happens from the submission's own files panel in
> [Workspace → Submissions](workspace-submissions.md).
