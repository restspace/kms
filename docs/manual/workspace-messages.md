# Workspace → Messages

See [Workspace](workspace.md) for the tab mechanics and global filtering shared by every entity
tab below. This is the log of every automatic and manual email the app has sent — the place to
answer "did they actually get it?" — and also where you compose one-off, manually-sent emails.

## List

Default columns: Queued (date and time), Template, To (recipient email), Subject, Status (a
coloured chip — pending, queued, sent, failed, and so on), Event.

There are no built-in filter chips; sortable columns are Queued, Template, To, Status, defaulting
to newest-first. There's no bulk action here.

## Detail

Shows the recipient's name and email, when it was queued, when it was sent (if it was), and the
error text if it failed.

- **Retry send** — appears only on a **failed** message; re-attempts delivery in place and updates
  the status, error, and sent time once it resolves, with a short result note ("Delivered.",
  "Re-queued — delivery will be retried shortly.", or the error itself).
- **Message body** — shows the actual text sent to that recipient, with an expandable "HTML
  source" panel. Messages sent before this app started logging bodies show a note that none was
  recorded rather than a blank space.

## Composing a message

**+ New** opens a compose form:

- **Recipients** — a dropdown of named audiences with live headcounts (e.g. "Everyone on this
  event — 214," "Accepted speakers — 38"), or choose **Choose recipients…** to pick specific
  people from a multi-select contact picker (Ctrl/Cmd-click for several).
- A hint under the body box lists the merge fields available (e.g. `{{first_name}}`) — hover one
  for what it means. The body isn't interpreted as HTML; line breaks are preserved as typed.
- **Preview as** — pick a sample recipient and render the actual subject/body for them before
  sending, with the same HTML-source disclosure as the detail view.
- Sending shows live progress in the dialog; it's safe to close the dialog mid-send, since the
  job keeps running on the server. Every recipient ends up with their own row in this list, each
  with its own delivery status.

## Export

Standard CSV/XLSX export is available; there's no import.
