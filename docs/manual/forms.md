# Forms

**Sidebar:** Forms

This is where you build and publish your call-for-speakers form. There's a single list screen
and a six-step builder — no separate areas for "portal forms" or "file requests" here (those
live under [Settings → Portals](speaker-portal.md) once built).

## The forms list

**+ Create Form** starts a brand-new, untitled form and drops you straight into the builder.

Each form appears as a card with:

- **View** — opens the live public submission page in a new tab, exactly as a speaker sees it.
- **Copy link** — copies the public submission URL to your clipboard.
- **Duplicate** — makes a full copy of the form, including every question and setting, as a new
  form. The copy keeps the original's name until you rename it.
- **Close / Reopen** — a single button that toggles the form's availability. Reopening a form
  always clears any close date that had already passed, so a reopened form doesn't immediately
  close itself again.
- **Delete** — removes the form only; any submissions already collected through it are kept.

The status chip reads **Open** or **Closed**, but watch for a subtlety: if the status says Open
while the close date has already passed, the chip shows a tooltip explaining that the public form
is treating it as closed regardless of the status setting — the close date always wins on the
public side.

> **Note:** there's no search, sort, or bulk action on this list — it's a simple list of cards,
> one action per row.

## The form builder

Six steps, listed down the left rail; clicking a different step saves your current one first.
The header bar has **← Forms** (saves any changes before leaving), **View Form**, **Copy Link**,
and **Save** (shows a "Saved HH:MM:SS" timestamp once it lands).

### 1. Submission Setup

Choose **Abstracts** or **Sessions** — this and the setting below can be changed later without
losing existing answers. A **Participants** toggle adds a step to the public form for collecting
speaker/participant contact details.

### 2. Welcome Screen

Internal Form Name (your own reference), External Form Title and Page Heading (what visitors
see — the heading has a hard 15-character limit), a **Show welcome message** toggle, and the
welcome message itself as rich text (headings, paragraphs, links, lists, bold/italic, images).

### 3. Abstract Information

The question list for the talk/session itself, plus a **Routing** panel:

- **+ Add rule** — build a rule: *when* a chosen question's answer matches a condition, *then*
  assign an evaluation plan, add tags, and/or set the track. Rules run in the order listed, and a
  later rule can overwrite what an earlier one set.
- **Fallback plan** — the evaluation plan assigned when no rule matches.
- Every rule's application is recorded on the submission, so you can always see later why a
  particular proposal ended up where it did — it shows as **Routed by** on the submission's
  detail view.

Rules don't only run once at submission. If the answer a rule keys off later changes — the
speaker edits it from their portal, or you change the track from the Workspace — the rules run
again and the evaluation plan, tags and track follow. Two things limit that, so re-routing can
never surprise you:

- **Your own changes win.** Re-routing only moves values the rules themselves set. An evaluation
  plan you reassigned by hand, or a tag you attached yourself, stays put.
- **It stops at a decision.** Once a submission reaches an accept or decline queue, the answers
  the rules key off are locked — for the speaker and for you — so a proposal already out for a
  decision can't be reshuffled underneath it. Everything else about the submission stays
  editable.

Re-routing never changes a submission's status, even if a rule has a *set status* action. That
one applies at submission only; after that the accept/decline workflow owns the status.

### 4. Participant Information

A **Participant roles** panel lets you tick which roles submitters can add (Speaker is always on)
and set a Min/Max count per role (leave Max blank for unlimited), followed by the question list
for participant details.

### The question list (used by both step 3 and step 4)

- **Drag the handle** to reorder questions — this saves immediately.
- **Required** checkbox per question (locked/system questions can't be made optional).
- **Edit** (on a question's menu) — change its label, help text, character limit, and its list of
  options. One exception: the system **Track** question's options aren't editable here — they
  come from your event's Tracks list under Settings.
- **Logic** — set up a show/hide rule: an enable toggle, Show or Hide, match **All** or **Any** of
  the listed conditions (question / operator / value). Only questions that come *earlier* in the
  same section can be referenced, which is what prevents a question from depending on its own
  answer.
- **Remove** — not offered for locked/system questions; asks for confirmation on everything else.
- **+ Add Field** — opens a picker with two paths: **Create Field** (a brand-new custom question:
  label, type, options if it's a choice type, character limit, required) or choosing an existing
  question from your field library (searchable; a "system" chip marks built-in fields; fields
  already on this form are excluded from the list).

### 5. Form Settings

- **Status** (Open/Closed) is a separate control from the close date below — if they disagree
  (e.g. status is Open but the close date has passed), a note explains that the close date wins
  on the public form, and saving a reopen clears any past close date.
- **Close Date & Time** — the submission deadline, shown in the event's timezone; a "Clear close
  date" link removes it.
- **Set Submission Limit** — caps how many sessions one person can have on this form (drafts
  count toward the limit); off by default (limit is 3), turning it on seeds 3 as a starting value.
- **Allow multiple draft submissions**.
- **Auto-redirect to speaker portal** — sends the submitter to their portal automatically 10
  seconds after the confirmation page; off means they use a manual "Continue" button instead.
- **Success page message** — the rich-text confirmation copy shown after submitting.

### 6. Notifications

Currently one live control: the **Submission Confirmation** toggle, which turns the confirmation
email to submitters on or off. (Admin alert routing and per-template customisation from this
screen are not built yet.)

## Next step

Once submissions start arriving, head to
[Reviewing and deciding on submissions](reviewing-submissions.md).
