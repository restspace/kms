# Emails, reminders and calendar invites

Every automatic email the app sends is a **template** you can read, edit, and switch on or off,
under **Settings → Email Templates**.

## What gets sent, and when

| It sends this email... | ...when this happens |
|---|---|
| Sign-in link | Someone requests one, on the public form or portal |
| Submission confirmation | A proposal is submitted |
| Submission updated | A submitter edits their own proposal after submitting |
| New/updated submission alert | To admins you've chosen, on new or edited submissions |
| Accepted / Declined | You send decisions on a submission |
| Combined decision summary | You send decisions and the speaker has more than one in the batch |
| Task assigned | You (or an automatic rule) assign a task to a speaker |
| Task reminder | Automatically, a set number of days before a task is due |
| Draft reminder | Automatically, before a form's close date, to anyone who's left a draft |
| Session scheduled / moved / cancelled | You schedule, reschedule, or unschedule a session |
| Portal form submitted | A speaker completes a form you've assigned them |
| Event reminder | Automatically, a set number of days before the event |

Everything marked **must have** in the reference product ships turned on with sensible default
wording — you don't have to write anything before your form goes live. Edit any of them whenever
you like; each event can have its own wording, so two events run by the same team can sound
different if you want.

## Editing a template

Open a template to edit its subject line and body (rich text, same toolbar as everywhere else in
the app). Insert **merge variables** — placeholders like the speaker's name, the submission's
title, or the session's room — that get filled in automatically for each recipient. Use
**Preview** to see it rendered with sample data, and **Send test to me** before trusting it with
real speakers.

Branding (logo, colours, header/footer) lives separately under **Settings → Email Themes** and
applies across every template, so you only set it up once.

## Reminders that send themselves

You don't need to trigger these — a background check runs regularly and sends them automatically:

- **Task reminders** — a speaker with an incomplete task gets nudged on the schedule you set for
  that task (e.g. 7 days, then 2 days before it's due), and again if it goes overdue.
- **Draft reminders** — anyone who started a submission but never finished gets reminded as the
  form's close date approaches.
- **Schedule reminders** — accepted speakers get a recap a week and a day before their session,
  with their calendar invite attached again.

Every reminder is sent at most once per speaker per trigger — re-checking or re-running things on
your end never results in a duplicate.

## Calendar invites

When you schedule an accepted speaker's session, they automatically get an email with a real
calendar invite attached — the kind their email client renders as "Add to calendar" / accept- or
decline-style buttons, working with Gmail, Outlook, and Apple Mail without the speaker needing to
do anything special. The email also includes direct "Add to Google Calendar" and "Add to Outlook"
links as a backup.

- **Move the session?** The speaker's calendar entry updates in place — they don't end up with
  two events.
- **Unschedule or the speaker withdraws?** Their calendar entry is removed.
- Times are shown correctly in the event's own timezone, including across daylight-saving changes.

> **Note:** if you change a session's time or room after its invite has already gone out, you'll
> be asked to confirm you want speakers notified of the change — this is deliberate, so a
> schedule never shifts under a speaker silently.

## Checking whether something actually sent

Every submission and speaker's detail view includes a **message log** — a record of what was sent
to them, when, and whether it succeeded — so you can always answer "did they get it?" without
digging through your own inbox.

## Next step

See [The speaker portal](speaker-portal.md) for what speakers do with the tasks and invites you
send them.
