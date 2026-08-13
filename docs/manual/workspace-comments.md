# Workspace → Comments

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below. This tab is a read-only, org-wide log of every comment left on a submission — both
reviewer rationales and general discussion.

## List

Default columns: Code, Comment (the body text), Author (name with their role in parentheses, e.g.
"(speaker)"), Kind ("Review comment" for a reviewer's scoring rationale, "Discussion" for
everything else), Posted, Event.

There are no filter chips or status tabs. Sortable columns: Code, Author, Kind, Posted, defaulting
to newest-first. There's no bulk action here.

## Detail

Read-only: submission code and title, the author's name and role (with a "· Review comment" tag
where relevant), the posted date, and the full comment body with line breaks preserved. There's no
reply, edit, or delete control on this tab — post a reply from the submission's own discussion
thread (in [Workspace → Submissions](workspace-submissions.md)) or, for a reviewer's own comment,
from the [Review](review.md) workspace.

Pinning a comment as the [global anchor filter](workspace.md#the-global-anchor-filter) anchors on
its author.

## Export

Standard CSV/XLSX export is available.
