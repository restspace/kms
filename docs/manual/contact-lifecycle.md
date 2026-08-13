# Contact lifecycle

A **contact** is a person — a prospect, speaker, submitter, or reviewer. This page traces how one
person moves through the app from a name on a list to an onboarded, scheduled speaker, and points
you to the screen responsible for each stage. It cuts across several sidebar sections; see each
one's own page for the controls in detail.

## One identity across every event

A contact belongs to your **organisation**, not to a single event — the same person is one record
no matter how many of your events they've spoken at. What varies event to event (their bio,
headshot, company/title at the time, and internal notes) is kept separately per event, so a
returning speaker's history doesn't overwrite itself, but a new event does pre-fill their profile
from their most recent one so they're not starting from a blank form.

You can view a person either through a specific event ([Workspace →
Speakers](workspace-speakers.md) with one event selected) or across all of them (the same tab with
**All events** selected in the sidebar).

## 1. Prospect — before they're attached to any event

Someone you're courting but who hasn't submitted or agreed to anything yet lives on the
[Pipeline](pipeline.md) kanban board, moving through **Identified → Researching → Contacted →
Interested**, ending at **Confirmed** or **Declined**. This stage is entirely organisation-level —
it has nothing to do with any one event until you explicitly **Add to event** from their card.

Not every speaker goes through Pipeline — most simply appear the moment they submit a proposal
(step 2 below) or are added directly to an event.

## 2. Attached to an event

A contact becomes attached to a specific event in one of four ways:

- **They submit a proposal themselves** through the public call-for-speakers form — see
  [Building your call for speakers](call-for-speakers.md). A brand-new email creates both the
  contact and their event membership at once.
- **An admin adds them** to the event from [Workspace → Speakers](workspace-speakers.md) — either
  **＋ Existing** (attach someone your organisation already knows) or **＋ New contact**.
- **You enrol them from Pipeline** via **Add to event** on their prospect card.
- **They're imported** from a spreadsheet — a new email creates a contact; a known email merges
  into the existing record, filling in only whatever was previously blank.

## 3. Speaker status, for this event

Once attached, a contact carries an event-specific **speaker status**: the built-in **Prospect →
Invited → Awaiting reply → Confirmed / Declined**, plus any custom statuses your event has added
under [Settings → Speaker statuses](settings.md#speaker-statuses). This is separate from any
*submission's* status (see [Submission lifecycle](submission-lifecycle.md)) — a person can be
"Confirmed" as a speaker while a specific proposal of theirs is still "Pending."

## 4. Portal access and profile completeness

Every contact can sign in to the [speaker portal](speaker-portal.md) with a passwordless magic
link — sent automatically after their first submission, or triggered manually from their record
with **Invite to portal**. From there they fill in their own biography, headshot, and links; a
speaker counts as **profile-complete** once both the biography and the headshot are present. That
completeness is what drives the "missing bio or headshot" nudges on the
[dashboard](dashboard.md).

## 5. Tasks and chasing

Accepted speakers accumulate **tasks** — upload slides, confirm travel, fill in a form — tracked
in [Workspace → Tasks](workspace-tasks.md) and chased automatically or with staged review, per
[Emails, reminders and calendar invites](emails-and-reminders.md) and the
[Speaker Tracking dashboard](dashboard.md#speaker-tracking).

## 6. Day of event

On the day, the [Green Room](greenroom.md) screen tracks whether a speaker has actually
**arrived**, flags anything still missing (slides, headshot, bio), and gives you a one-tap way to
call or nudge them.

## Duplicates and deletion

Because identity is organisation-wide, the same person can accidentally end up as two records
(different capitalisation of an email, a typo, an import mismatch). **⧉ Duplicates** on the
Speakers tab surfaces likely matches for you to merge. **Delete from organisation** removes a
person entirely, across every event they've ever been part of — different from removing them from
just one event, which only detaches that event's membership and leaves the underlying contact
intact.
