# Workspace → Reviews

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below. This tab is a read-only record of scoring already entered on the
[Review](review.md) screen — it's where you go to look things up, not to score.

## List

Default columns: Code, Submission, Reviewer, Round (the evaluation plan name), Score (shows "CoI"
if the reviewer flagged a conflict of interest, or a dash if it's not yet scored), Recorded, Event.

There are no filter chips or status tabs on this list. Sortable columns: Code, Reviewer, Score,
Recorded. It defaults to newest-first. There's no bulk action — rows can't be multi-selected here.

## Detail

Read-only: submission code and title, reviewer, round, the score (or "Conflict of interest
declared" in place of a number), a per-criterion breakdown when the plan recorded scores that way,
and the reviewer's free-text comment if they left one. There's no edit or delete here — reviews
are edited from the [Review](review.md) workspace itself, by the reviewer.

Pinning a review as the [global anchor filter](workspace.md#the-global-anchor-filter) anchors on
its reviewer, narrowing other tabs to that person's other records.

## Export

Standard CSV/XLSX export is available.
