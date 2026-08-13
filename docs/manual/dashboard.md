# Dashboard

**Sidebar:** Dashboard

Your first stop most mornings. Data refreshes itself roughly every 15 seconds — a small "updated
Ns ago" note confirms how fresh what you're looking at is — and pauses while the browser tab is
in the background, catching up the moment you switch back.

A row of pill buttons near the top switches between three boards: **Today**, **Speaker
Tracking**, **Submissions Pipeline**. Switching boards doesn't change the page URL, so a browser
refresh returns you to Today.

> **Note:** if the sidebar's event filter is set to **All events** rather than one specific
> event, these three boards are replaced entirely by an **organisation-wide board** — see
> below.

## Today

- **KPI tiles** — Participants and Submissions are informational counts. The status tiles
  (Accepted / Pending / Declined / Drafts / Withdrawn) are clickable and jump straight to the
  Submissions tab in Workspace, pre-filtered to that status.
- **"Also check" strip** — a row of nudges with counts, each a button that jumps straight to
  what fixes it: unscheduled sessions → Agenda; conflicts → Agenda's Conflicts view; pending
  submissions → Workspace/Submissions filtered to Pending; staged decisions → Workspace/
  Submissions; speakers missing bio/headshot/slides → Workspace/Speakers filtered to those;
  outstanding or overdue tasks → switches you straight to the Speaker Tracking board.
- **Sub-tabs** below the nudges:
  - **Submission Forms** — a pacing chart (cumulative submissions per day), a list of your forms
    with their status and a **Manage** button (jumps to Forms), and a Recent Submissions table
    whose rows open that submission's speaker and tasks in Workspace.
  - **Participants** — a "Participants by role" bar list and a "Submission status" donut split by
    accepted/pending × session/abstract.
  - **Evaluations** — review counts (written, evaluated, in progress, most active plan) and a bar
    list of completed-vs-assigned work per reviewer.
  - **Agenda** — scheduled/unscheduled counts, a **Conflicts** link showing the errors/warnings
    count (jumps to Agenda's Conflicts view), and bar charts of sessions per day and per room.

## Speaker Tracking

The board you'll use to actually chase people, described in detail in
[Emails, reminders and calendar invites](emails-and-reminders.md) and
[The speaker portal](speaker-portal.md):

- A **chase-mode banner** appears when the event's reminder mode is set to automatic rather than
  assisted, with a link straight to the relevant Settings card; dismissing it (×) is remembered
  in your browser.
- The **chase inbox** — when the event is in *assisted* reminder mode, staged reminder drafts sit
  here grouped by speaker, each editable (subject/body), showing which escalation step it's at
  (e.g. tool email → personal email → CC the chair → text → call) and how long it's been staged.
  Per draft: **Save**, **Send**, **Dismiss**, **Escalate** (disabled once already at the top
  rung). A header button, **Send all (N)**, sends every staged draft in one go.
- **Speaker confirmation** donut — confirmed vs. still awaiting confirmation.
- **Top speakers by outstanding tasks** — click a name to open that speaker's Tasks in Workspace.
- **Asset completeness** — speakers missing a bio, headshot, or slides; click one to open their
  record.
- **Approval pending** — accepted speakers still waiting on their employer's sign-off, with a
  countdown of days until the event; click a name to open their record.
- **Overdue tasks** — a table with a per-row **Send reminder** button and a header **Remind all
  outstanding (N)** button. Both queue a background job and show a live status line ("Sending
  reminders…") that updates as it completes, followed by a summary of sent / failed / skipped /
  already-reminded.

## Submissions Pipeline

- KPI tiles: Total Submissions (informational) and **Pending Review**, which is clickable and
  jumps to Workspace/Submissions filtered to Pending.
- A funnel: Received → Reviewed → Decided → Accepted → Scheduled.
- Bar lists of submissions by form and by track (not clickable).

## Organisation board (All events)

Shown instead of the three boards above when the sidebar filter is set to **All events**:

- KPI tiles: total contacts (with new-in-30-days), how many are on an event, how many are on no
  event, returning speakers, and the number of events. The contact tiles are clickable and filter
  the org-wide contact directory.
- **Top companies** — click one to filter contacts by that company.
- An **Events** table listing every event's dates, whether its agenda is published, and its
  submission/accepted/scheduled counts — click a row to open that event's submissions.

## Next step

See [The speaker portal](speaker-portal.md) for the chase workflow behind Speaker Tracking, or
[the Workspace](workspace.md) for where the underlying records live.
