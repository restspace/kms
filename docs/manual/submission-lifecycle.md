# Submission lifecycle

A **submission** is one proposal — a talk, workshop, or panel — from first draft to (potentially)
a scheduled session on the agenda. This page traces the whole path and points to the screen
responsible for each stage.

## Status states

```
                    ┌── withdrawn (by the submitter, any time before decline) ──┐
                    │                                                          │
draft ──> pending ──┼──> accept queue ──> accepted ──> (schedulable)           │
                    └──> decline queue ──> declined                            │
```

| Status | Meaning |
|---|---|
| **Draft** | Started in the portal, not yet submitted — autosaves every 10 seconds |
| **Pending** | Submitted, awaiting a decision |
| **Accept queue** | Provisionally accepted, decision email not yet sent |
| **Decline queue** | Provisionally declined, decision email not yet sent |
| **Accepted** | Accepted and notified |
| **Declined** | Declined and notified |
| **Withdrawn** | Pulled by the submitter themselves |

## 1. Submitted

A visitor fills out the public call-for-speakers form (see
[Building your call for speakers](call-for-speakers.md)) and lands at **Pending** the moment they
submit — or stays at **Draft** if they save and leave without finishing. Any routing rules on the
form (auto-tagging, auto-assigning to an evaluation plan) run at this moment, and every rule that
fires is recorded — it shows as **Routed by** on the submission's detail view — so you can see
later why a submission landed where it did. The rules run again on any later edit that changes
what they key off, up until the point described in §6.

## 2. Reviewed

While Pending, a submission can be picked up by one or more [evaluation plans](evaluation.md) and
scored by [reviewers](review.md). This is optional — you can also decide straight from Pending
without a formal review round.

## 3. Decided

From [Workspace → Submissions](workspace-submissions.md), you move a batch of submissions into
**Accept queue** or **Decline queue** first, review the queues, then **Send decision emails** —
see [Reviewing and deciding on submissions → Making and sending decisions](reviewing-submissions.md#making-and-sending-decisions)
for how the queue states let you batch this rather than notifying one at a time. Sending stamps
**Notified**, and only then does the status flip to **Accepted** or **Declined**.

Two things can happen alongside a decision:

- **Employer approval** — a submission can separately carry an approval state (not asked through
  approved) if you've opted a batch into requiring it when sending decisions; this is tracked
  independently of the accept/decline status itself.
- **Visible in public agenda** — a per-submission toggle controlling whether it can appear on the
  published agenda once scheduled, separate from its accept/decline status.

## 4. Withdrawn

A submitter can withdraw their own proposal at any point up until it's been declined, from their
[speaker portal](speaker-portal.md). This is the one transition that doesn't originate from the
admin side.

## 5. Scheduled

Only **Accepted** submissions can be placed on the [agenda](agenda.md) — dragged from the
unscheduled tray onto a room and time slot, or auto-placed. Scheduling is what turns a submission
into a **session** in the app's terms; they're the same record, just with a time and room filled
in. From here:

- The [conflict engine](agenda.md#conflicts) checks it against every other scheduled session.
- A first schedule triggers the [calendar invite](emails-and-reminders.md#calendar-invites) email;
  moving it re-sends an updated invite (with your confirmation), and unscheduling cancels it.
- Once the agenda is [published](agenda.md#publishing), accepted and scheduled sessions become
  visible on the public feed and any [embeds](embeds.md) you've built.

## 6. Editing after a decision

A submitter can still edit their own submission's answers from the portal for as long as it isn't
withdrawn or declined — acceptance doesn't lock it. Organisers can edit the operational fields
(track, room, capacity, and so on) at any point from the submission's detail view in
[Workspace → Submissions](workspace-submissions.md), with a full history of changes kept
alongside it.

One narrow exception: the answers your [routing rules](forms.md) key off. Those decide the
evaluation plan, tags and track, so while a submission is still Draft or Pending they stay
editable and the rules re-run on every change. From the moment it enters an accept or decline
queue they're frozen — shown with a padlock and a reason, on the speaker's edit page and on your
own — because a proposal already out for a decision shouldn't be re-routed underneath it. The
rest of the submission carries on being editable as before.
