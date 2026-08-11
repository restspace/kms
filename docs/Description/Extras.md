# Extras — what workplan 13 gives the people using this

Source: [tests/features/GeneKim.md](../../tests/features/GeneKim.md), four posts from a program
chair with ~26 conferences over 15 years, written as advice to people building this exact tool.
Plan: [tests/workplan-13-genekimpains.md](../../tests/workplan-13-genekimpains.md).

None of it is in the brief. All of it comes from someone describing what they have actually lived
through with four commercial CFP tools. This document is the user-facing half: not how the waves
are built, but what changes for the person at the keyboard.

---

## The five things a user can do afterwards

| For | Today | After |
|---|---|---|
| Committee member | Can sort by score, cannot find what nobody has read | Sorts by fewest reads, sees `n of m have ≥2 reads`, works the tail |
| Organiser | Exports speakers and sessions; the committee's scores, comments and decisions stay locked in | Exports all of it — CSV, XLSX or JSON — plus each speaker's job title *as it read the year they submitted* |
| Organiser | A speaker is accepted, full stop | A speaker is accepted **and** awaiting employer sign-off, visible a month out, when the withdrawals actually happen |
| Event coordinator | The tool emails speakers on a schedule she did not approve | Nothing reaches a speaker unless she read the draft, edited it, and clicked Send |
| Whoever owns the schedule | A talk is placed or it is not | A talk can be "Tuesday morning, somewhere" for six weeks, and the header keeps count |

---

## 1. The coverage worklist (review)

> *"Two sorts are the whole review UI. Sort by fewest ratings first: that is the coverage worklist.
> Sort by average score descending: that is the agenda for the decision meeting. We ran ten years of
> program committees on those two sorts."*

We shipped one of the two. Sort-by-score gives you the decision meeting; nothing gives you the
Tuesday-night question, which is *what has nobody read yet*. Both sorts, and the filter behind
them, become available on the submissions grid:

- **Sort by fewest reads.** Second click on the Ratings column header. Zero-review submissions sort
  first, not last.
- **Filter `fewer than N reads`.** The sort shows you the tail; the filter *is* the worklist. Set
  it to 2 and the grid holds exactly the talks that still need a second opinion.
- **A coverage bar on the tab header.** `31 of 44 have ≥2 reads`, reading the same filter as the
  grid, so the number and the list can never disagree.

The permalink and the per-submission comment thread — the other two things the doc asks for under
this pain — are already there. Every record has a copyable URL (`?tab=submissions&rec=…`), and each
submission has one append-only thread that reviewers and organisers both write into. This wave
completes the set.

## 2. The work product leaves with you (exports)

> *"Everything the committee produced — scores, comments, decisions, reasoning — has never left a
> CFP tool. Not once, on any platform, in 15 years."*

This is currently true of us too, and it is the single most valuable thing this plan changes.

- **Reviews become a first-class thing you can list, filter, sort and export.** Every score, its
  per-criterion breakdown, the reviewer, the round, the conflict-of-interest flag, the rationale.
  New tab in the workspace, new endpoint under `/api/v1`, CSV and XLSX buttons in the same place as
  every other export.
- **Comment threads too.** The committee's actual reasoning, exportable as rows.
- **Decisions**, which are not a separate entity but a column combination nobody could export
  before: outcome, when the letter went out, final score, read count.
- **Job title and employer, frozen at submission.** The doc's most surprising line is that its
  author's most valuable longitudinal dataset — a decade of speakers going IC → director → VP —
  survives only because people re-typed their job titles into a throwaway field each year. We
  already store company and title per event; after this wave the participation row keeps the values
  *as they were when that talk was submitted*, so editing a profile no longer quietly rewrites ten
  years of history.

One deliberate limitation, stated rather than hidden: we cannot export **who** flipped a decision.
There is no actor recorded on a status change today, and inventing that audit trail is its own
piece of work. It is logged as an open question rather than quietly omitted.

Two things this wave *does not* need to fix, because they already hold: every record carries a
stable UUID, and the published `.ics` feed uses the session id as its UID, so a re-publish does not
churn anybody's calendar. Migration 0015 already gave one speaker identity a single id across every
event in the organisation — the direct answer to the doc's "ask three of our live systems how many
talks she has given and you get 6, 9, and 12."

## 3. "Accepted, employer approval pending"

> *"Employer approval is the #1 cause of speaker withdrawal in ten years of our records, and it
> arrives late… No tool models 'accepted, employer approval pending' as a state."*

A speaker can now be accepted *and* carry an approval state — pending, granted, or refused — plus a
free-text note for the thing that actually gets chased ("legal says end of month"). It is a second
axis, not a different status, so nothing about the accept queue, the decision batch or the notify
flow changes.

Where it shows up:

- A chip on the submission, editable inline next to the status.
- **An Approval pending panel on the Speaker Tracking board**, sorted by days-until-event. The doc
  says approval chatter peaks about a month out and withdrawals cluster 29 days out — that is only
  actionable if it is on screen a month out.
- An optional line in the acceptance email that asks the question and sets the state, opt-in per
  batch.

`Refused` does not auto-withdraw anybody. It raises a flag for a human.

## 4. Drafts she sends, not mail we send

> *"In 13 years of archive, there is zero evidence of a tool successfully sending a reminder on our
> behalf… A feature that auto-emails speakers will be switched off within one event cycle. Build
> assisted chasing — drafts a human reviews and sends from their own address."*

We currently do the thing the doc says gets switched off: a nightly sweep emails speakers at T-7
days, T-2 days and T-12 hours, plus up to three overdue nudges, from the system address, with
nobody in the loop. This wave makes the assisted version available as an opt-in per event.
Automated reminders stay the default — they are a hard requirement of the brief ("Automated,
templated speaker communications, including reminders") — but the pipeline underneath changes so
both modes share one staging step and one idempotency story.

- **The sweep becomes a detector.** Same schedule, same rules, same wording — but it *stages a
  draft* instead of sending an email.
- **A chase inbox on the Speaker Tracking board.** Drafts grouped by speaker, each editable in
  place. Send, Dismiss, or Send all. Nothing leaves without a click.
- **Replies come back to her.** Sent drafts carry the organiser's address in Reply-To. We
  deliberately do *not* forge her address in the From line: that fails SPF/DKIM and lands in spam,
  which is the exact failure the doc records happening in both 2023 and 2025.
- **The escalation ladder is recorded, never automated.** Tool email → her personal email → cc the
  chair → she texts → someone calls. The doc is explicit that each rung is a deliberate human
  signal, so the tool's job is to show which rung a chase is on and how long it has sat there —
  not to climb it.
- **A per-event switch.** `chase_mode` defaults to `'auto'` for every event, so nothing stops
  sending unless an organiser chooses assisted mode; the tracking board points at the setting once
  so she knows the choice exists.

What stays out of scope: sending genuinely from her own mailbox (that needs per-user mail-provider
OAuth), and any SMS or call integration. The ladder above the first rung is recorded, not driven.

## 5. "Tuesday morning, somewhere"

> *"The schedule is the most fluid artifact of the event… The keynote is 'Tuesday morning,
> somewhere' for six weeks… A spreadsheet never says no. It has no required fields. It saves every
> half-decision."*

Our agenda already gets the hard half right: conflicts are surfaced and never enforced. Nothing
blocks a save, a double-booking is a chip you can ignore, and the ignore list persists. What it
does not have is the spreadsheet's tolerance for a half-decision — a talk is either fully placed
(day, time and room) or sitting in the unscheduled tray.

A third state closes that gap:

- **Pencilled** — a time with no room yet, or a room with no time. Renders as a dashed block across
  the day rather than disappearing from every view, which is what happens today.
- **Drop onto a day header** to say "Tuesday, some time" without committing to a slot.
- **Live slot math in the header**, in the doc's own phrasing: `3 unplaced · 2 pencilled ·
  1 conflict`.
- Pencilled talks are exempt from room clashes (there is no room yet) but still raise **speaker**
  double-bookings — a named chip with a one-click fix, never a modal that refuses the save.

Whether this beats the Google Sheet the doc's author has used for ten straight years is, in their
words, still an open question after twelve years. It is at least the first version where the answer
could be yes.

---

## Why these five

They are the only feature requests we have from someone who has run the job for fifteen years,
across four tools they eventually abandoned. Three of the five (exports, assisted chasing, approval
state) are things the doc says **no tool has ever done**, which makes them worth more than a
seventh variation on something every competitor ships. The other two are completions of work
already sitting in the codebase, at a few hours each.
