# Evaluation

**Sidebar:** Evaluation

Where you set up review rounds — an **evaluation plan** is one round of scoring, and you can run
several at once or in sequence.

## Creating a plan

Type a name in the box at the top and click **+ Create plan**. Plans appear as cards in a grid;
there are no tabs or bulk actions here — every plan is self-contained on its own card, with a set
of collapsible editors (the pencil icons) inside it.

## Inside a plan card

- **Name** — click the title to edit it inline; saves when you click away.
- **Status** — Draft / Active / Closed.
- **Hide submitter identities from reviewers** — a checkbox that turns on blind (anonymised)
  review.
- **Timing** (pencil icon) — optional "Reviews open" / "Reviews close" dates; leave both blank
  for a round that's open indefinitely.
- **Scale** (pencil icon) — the Min/Max numbers reviewers score against.

  > **Note:** once any review has actually been completed against this plan, the scale locks —
  > you'll see a note explaining it can no longer be changed, to protect scores already recorded.

- **Criteria** (pencil icon) — the things reviewers actually score:
  - Existing criteria list with a remove (✕) button (confirms first) and, for numeric-scale
    criteria, an inline weight you can adjust directly.
  - To add one: give it a name, choose its type — **scale** (a number with a weight), **dropdown**
    (pick one of a list you type in, comma-separated, minimum two options), or **long text** (a
    free-text comment, unweighted) — then **+ Add criterion**.
- **Choose submissions** (toggle) — decide which submissions this plan covers:
  - Filter selects for Track / Format / Status, with **Add matching (N)** and **Remove
    matching** buttons to bulk-adjust membership by filter.
  - Or work directly from the full scrollable list, where each submission has its own membership
    checkbox — plus a second checkbox used to narrow which of those you want the *next* reviewer
    assignment run to apply to (see below).
- **Edit reviewers** (pencil icon):
  - The reviewer table: a checkbox to add/remove someone from this round's pool, a **Send
    sign-in link** button (opens a copyable link panel — handy for a reviewer who hasn't got
    their invite email yet), progress columns showing how much of this round (and of all their
    rounds) they've completed, a **Remind** button that appears once they have outstanding work,
    and — while editing — a cap on how many submissions they can be assigned (leave blank for no
    cap).
  - **+ Add reviewer** — add someone by name and email; this both creates them as a contact (if
    new) and seats them on this round.
  - **Assignment strategy** — **all reviewers see all** submissions, or **round-robin** (choose 1
    to 3 reviewers per submission).
  - **Only selected submissions (N)** — a checkbox that, when ticked, scopes the assignment run to
    just the submissions you flagged in the submission picker above, instead of everything in the
    plan.
  - **Assign** — runs the assignment; reports how many new assignments were created and flags any
    submission that came up short of reviewers because of someone's assignment cap.
  - **Remind all lagging** — sends a reminder to every reviewer who's behind, and reports how many
    reminders went out.

## Next step

Reviewers do their actual scoring on the [Review](review.md) screen.
