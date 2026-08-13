# Green Room

**Sidebar:** Green Room

A mobile-first, day-of screen for running the show: who's on now, who's up next in each room, and
whether they've actually arrived — the thing you keep open on your phone during the event itself.

## Layout

If your event spans more than one day, day tabs appear at the top. Below that, one column per
room, each showing an **On now** card, an **Up next** card, and a collapsible **"N more later
today"** section for everything further out. A room with nothing scheduled that day collapses to
a single muted chip at the bottom rather than taking up a full column.

The page quietly refreshes itself roughly every 15 seconds.

## Per-speaker controls

- **Arrived** — a large tap target that checks a speaker in on the spot. It updates instantly and
  confirms with the server in the background. It's disabled for anyone who isn't actually on that
  event's roster.
- **Readiness chips** — automatic warning tags next to a speaker's name: "slides missing," "no
  headshot," "no bio," or "not on the event roster."
- **Nudge** — appears only when a speaker is missing something or has outstanding items; sends
  them a reminder on the spot and reports back whether it actually sent, or that they'd already
  been nudged today.
- **Call** — a tap-to-call link when a mobile number is on file; shows as disabled with "no
  number" otherwise.

## Other controls

- **See [next day]** — appears once every session for the current day has finished.
- **Open the agenda** — shown when nothing at all is scheduled, and links out to
  [Agenda](agenda.md).
