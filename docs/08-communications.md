# 08 — Communications: Templates, Reminders & Calendar Invites

Covers brief requirement **#3 — "Automated, templated speaker communications, including
reminders and calendar invites delivered directly to each speaker's own calendar
(Gmail, Outlook, iCal)."**

Reference screenshots: 2 (Settings → Email Templates / Email Themes), 15 (form notifications,
**"must have"** on the submitter confirmation), 29 (portal form confirmation email).

---

## 1. Email templates (`/app/e/:event/settings/email-templates`)

Every outbound message is a template: `key`, name, subject, rich-text body, enabled flag, theme.
Admins may edit any of them; the system seeds sensible defaults so nothing is blank on day one.

| Key | Trigger | Priority |
|---|---|---|
| `magic_link` | Sign-in requested | **must** |
| `submission_confirmation` | Public submission completed | **must** ("must have" on the screenshot) |
| `submission_updated` | Submitter edits an existing submission | should |
| `admin_new_submission` | New submission received | nice to have |
| `admin_submission_updated` | Submission updated | nice to have |
| `decision_accepted` | Status → accepted, decision emails sent | **must** |
| `decision_declined` | Status → declined | **must** |
| `task_assigned` | Task assigned to a speaker | **must** |
| `task_reminder` | N days before a task due date | **must** |
| `draft_reminder` | Before a form's close date, to submitters with drafts | should (enabled by setting a close date) |
| `schedule_confirmed` | Session first scheduled | **must** (carries the `.ics`) |
| `schedule_changed` | Scheduled session moved | **must** (carries the updated `.ics`) |
| `schedule_cancelled` | Session unscheduled or withdrawn | should (carries `METHOD:CANCEL`) |
| `portal_form_confirmation` | Portal form submitted, when enabled | should |
| `event_reminder` | N days before the event | could |

### Template editor
Subject line + rich-text body with a merge-variable inserter, a **Preview** pane (rendered with
sample data), **Send test to me**, and per-template enable/disable. Editing is per event, so two
events can have different voices.

### Merge variables
```
{{event.name}} {{event.dates}} {{event.location}} {{event.timezone}} {{event.website_url}}
{{speaker.first_name}} {{speaker.last_name}} {{speaker.full_name}} {{speaker.email}}
{{submission.code}} {{submission.title}} {{submission.status}} {{submission.format}} {{submission.track}}
{{session.starts_at}} {{session.ends_at}} {{session.room}} {{session.duration}}
{{task.title}} {{task.description}} {{task.due_date}} {{task.url}}
{{form.name}} {{form.close_at}}
{{portal_url}} {{magic_link}} {{submission_url}} {{unsubscribe_url}}
```
Unknown variables render as empty strings and are reported in the preview as warnings. Dates
render in the event timezone with the zone abbreviation.

---

## 2. Email themes (`/app/e/:event/settings/email-themes`)

Branding applied to every message: logo, primary colour, background colour, font stack, header
and footer HTML, social links. One theme is the event default; a template may override it.
All emails are sent as **multipart HTML + plain text**, tested against Gmail, Outlook (Windows +
web) and Apple Mail; table-based layout, inline CSS, max width 600 px, dark-mode-safe colours.

---

## 3. Sending pipeline

```
trigger → render(template, context) → enqueue(Queue) → provider send → MessageLog
```

- **Queue-backed** so the request path never waits on the provider.
- **Idempotency:** every send carries `idempotency_key = sha256(template_key|contact_id|entity_id|version)`
  with a unique index on `MessageLog`. Re-running a bulk action is safe.
- **Retries:** exponential backoff, 5 attempts, then `failed` with the provider error stored.
- **Rate limiting:** per-event send rate cap to protect domain reputation.
- **Message log** UI: filter by template, recipient, status; visible on the contact and submission
  detail pages so an organiser can answer "did they get it?".
- **Suppression:** hard bounces and unsubscribes are suppressed for non-transactional mail.
  Transactional messages (magic link, decision, schedule) ignore marketing unsubscribes.

---

## 4. Scheduled reminders (cron)

A Cloudflare Cron Trigger runs every 15 minutes and sweeps:

| Sweep | Rule |
|---|---|
| Task reminders | For each incomplete `TaskAssignment` whose task has `reminder_offsets_days` matching today relative to `due_at`, send `task_reminder`. Also an overdue sweep (daily, until complete or a cap of N). |
| Draft reminders | For forms with a `close_at`, remind submitters holding drafts at T-7d, T-2d, T-12h. |
| Schedule reminders | 7 days and 1 day before an accepted speaker's session, send a recap with the `.ics` re-attached. |
| Aggregate refresh | Recompute cached dashboard aggregates. |

Each sweep writes an idempotency key including the offset so a retry cannot double-send.
All reminder cadences are configurable per event; defaults above.

---

## 5. Calendar invites — the brief's explicit requirement

> *"calendar invites delivered directly to each speaker's own calendar (Gmail, Outlook, iCal)"*

### Approach
Standards-based, no OAuth required — an **RFC 5545 `.ics` attachment with `METHOD:REQUEST`**,
which Gmail, Outlook and Apple Mail all render as an actionable invite ("Add to calendar" /
RSVP buttons) directly in the message. Alongside it, the email body carries explicit
**Add to Google Calendar** and **Add to Outlook** links for anyone whose client does not
auto-detect the attachment.

### The `.ics` payload
```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//<product>//Event Program//EN
METHOD:REQUEST
CALSCALE:GREGORIAN
BEGIN:VTIMEZONE
TZID:America/Los_Angeles
...
END:VTIMEZONE
BEGIN:VEVENT
UID:<session_id>@<event-slug>.<domain>
SEQUENCE:0
DTSTAMP:20260808T170000Z
DTSTART;TZID=America/Los_Angeles:20261012T090000
DTEND;TZID=America/Los_Angeles:20261012T093000
SUMMARY:<session title> — <event name>
LOCATION:<room name>, <event location>
DESCRIPTION:<plain-text abstract + portal link>
ORGANIZER;CN=<event name>:mailto:<event from address>
ATTENDEE;CN=<speaker name>;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:<speaker email>
STATUS:CONFIRMED
BEGIN:VALARM
TRIGGER:-PT30M
ACTION:DISPLAY
DESCRIPTION:Reminder
END:VALARM
END:VEVENT
END:VCALENDAR
```

**Rules**
- `UID` is **stable per session** so updates replace rather than duplicate the calendar entry.
- Each re-send increments `SEQUENCE`; `DTSTAMP` is refreshed.
- Unschedule / withdraw sends the same `UID` with `METHOD:CANCEL` and `STATUS:CANCELLED`.
- MIME: `text/calendar; method=REQUEST; charset=UTF-8` as an alternative part **and** as a
  `.ics` file attachment — Outlook prefers the part, Gmail handles either.
- Timezone: emit a `VTIMEZONE` block for the event timezone rather than converting to UTC, so the
  invite is correct across DST.
- One invite per **speaker per session**; a speaker with three sessions gets three entries.

### Fallback links
```
Google:  https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=YYYYMMDDTHHMMSSZ/…&details=…&location=…
Outlook: https://outlook.live.com/calendar/0/deeplink/compose?subject=…&startdt=…&enddt=…&body=…&location=…
iCal:    a direct link to the hosted .ics (also served at /api/v1/sessions/:id/calendar.ics)
```

### Subscribable feed (stretch)
`webcal://<host>/api/v1/portal/:token/calendar.ics` — a per-speaker feed of all their sessions
that stays live as the schedule changes. This is strictly better than one-shot invites for
schedules that move, and is cheap to add once the ICS builder exists.

---

## 6. Notification matrix

| Event | Speaker | Admin | Reviewer |
|---|---|---|---|
| Submission created | `submission_confirmation` | `admin_new_submission` (if configured) | — |
| Submission updated | `submission_updated` | `admin_submission_updated` | — |
| Assigned to an evaluation plan | — | — | `review_assigned` (could) |
| Decision sent — accepted | `decision_accepted` (+ auto-assigned tasks) | — | — |
| Decision sent — declined | `decision_declined` | — | — |
| Task assigned | `task_assigned` | — | — |
| Task due soon / overdue | `task_reminder` | digest of outstanding tasks (could) | — |
| Session scheduled | `schedule_confirmed` + `.ics` | — | — |
| Session moved | `schedule_changed` + updated `.ics` | — | — |
| Session cancelled | `schedule_cancelled` + `.ics` CANCEL | — | — |
| Form closing with a draft open | `draft_reminder` | — | — |

---

## 7. Acceptance tests

1. Submitting the public form delivers the confirmation email within 30 s, containing a working
   magic link that lands on the portal home already authenticated.
2. Accepting a submission and sending decisions delivers the acceptance email once, even when the
   bulk action is clicked twice.
3. Scheduling a session delivers an email whose `.ics` opens as an invite in Gmail, Outlook web
   and Apple Calendar, showing the correct local time.
4. Moving the session re-sends and the existing calendar entry **updates in place** (no duplicate).
5. Unscheduling removes the entry from the speaker's calendar.
6. A task with reminder offsets `[7,2,0]` produces exactly three reminders, none after completion.
7. Every template renders correctly with an empty optional variable and in plain text.
