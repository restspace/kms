# Reviewing and deciding on submissions

Every proposal that comes in lands in [Workspace → Submissions](workspace-submissions.md), where
you can filter, score, and ultimately accept or decline it. This page walks through that workflow
end to end; see [Workspace → Submissions](workspace-submissions.md) for the full control
reference, and [Evaluation](evaluation.md) / [Review](review.md) for the scoring machinery.

## The submissions list

A status chip row filters the list with a live count for each submission status. A search box
and sortable columns sit above the table.

Each row shows status, code, title, rating (once scoring is under way), and whether it's been
notified. Click a row to open its detail as a tab, showing every answer the submitter gave, the
participant list, and a history of what's happened to it.

**Editing status directly:** click a row's status dropdown to change it there and then, without
opening the full record.

**Bulk actions** appear once you check more than one row — **→ Accept Queue**, **→ Decline
Queue**, **→ Pending**, and **Send decision emails** (see below).

## How a submission's status moves

```
draft → pending → accept queue → accepted   (schedulable on the agenda)
              └──→ decline queue → declined
```

A submitter can also **withdraw** their own proposal at any point from the portal. The two
"queue" states exist so you can stage a whole batch of decisions and send every notification
email at once, rather than one at a time — see **Sending decisions**, below.

## Scoring with a review round

If you want more than one person's opinion before deciding, set up an **evaluation plan** under
**Evaluation**. One plan is one review round — you might run several in sequence (a first-pass
filter, then a closer look at the shortlist) or in parallel (one per track).

For each plan you set:

- **Scoring criteria** — one or more, each with its own scale (1–5 by default) and a weight if
  some criteria should count more than others.
- **Reviewers** — the people scoring this round, added directly from the plan itself (see
  [Evaluation → Edit reviewers](evaluation.md#inside-a-plan-card)); adding someone by email both
  creates them as a contact, if they're new, and seats them on the round.
- **Which submissions** — assign by filter (track, format, tag) or hand-pick them; you can also
  have the routing rules on your form auto-assign submissions as they arrive.
- **How submissions are split** — everyone sees everything, a round-robin split across reviewers,
  or manual assignment.
- **Anonymise submitters** — hide the speaker's name and details from reviewers, if you want
  blind review.

### The reviewer's screen

Reviewers work through their queue one submission at a time, with a progress count ("12 of 40
reviewed"), score inputs per criterion, an overall comment box, and **Save & Next**. They can
skip a submission or flag a conflict of interest instead of scoring it. Everything autosaves.

Scores combine into a **rating** you can sort the submissions list by — the weighted average
across all reviewers for that plan, alongside the number of reviews and how much reviewers
disagreed (useful for spotting borderline calls worth a second look).

## Making and sending decisions

A typical flow:

1. Sort or filter by rating.
2. Select your shortlist, then **Change status → Accept Queue** (and the rest to **Decline
   Queue**, or leave them **Pending** for another look).
3. Double-check the **Accept Queue** and **Decline Queue** tabs.
4. Select the batch and choose **Send decision emails**.

If anyone in that batch has *other* submissions still awaiting a decision, you'll be asked how to
handle it: send everyone their decision now (with a note on their still-pending submission), hold
just those speakers back for a later batch, or cancel and adjust first. A speaker with several
decisions in one batch gets a single combined email rather than one per submission.

Sending decisions is safe to click twice — it won't double-send. Once sent, the row's **Notified**
column updates, and accepted submissions immediately become available to schedule on the
[agenda](agenda.md).

## Importing and exporting

- **↥ Import** accepts a CSV or Excel file, walks you through matching your columns to the right
  fields, and shows a preview of what will be created or updated before anything is written —
  nothing changes until you confirm.
- **Export CSV / XLSX** download exactly what's on screen — your current filters and sort.
- **↓ Files** zips up every current-version file for the submissions you've checked (slides,
  documents), organised into one folder per submission.

## Next step

Once someone's accepted, they'll start using the
[speaker portal](speaker-portal.md) — and you'll want to
[set up the emails](emails-and-reminders.md) that guide them through it.
