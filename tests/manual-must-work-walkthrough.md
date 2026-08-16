# Manual walkthrough — the Brief's "must work" path

Every step below is a real control in the app as it stands today (labels checked against the
code, not the specs). Follow it top to bottom in one sitting; each part depends on the one
before.

## What this is testing

`Brief.md` has no section called "must work". What carries that force is:

- the organiser's handwritten screenshot annotations — **"make sure this works"** on the
  post-submit success page, **"must have"** on the submitter confirmation email,
  **"update your own bio data"** on the portal profile (transcribed at
  [docs/00-overview.md §3](../docs/00-overview.md));
- the path those screenshots walk in order, written up at
  [docs/00-overview.md §4](../docs/00-overview.md): *public CFP → submit → confirmation email →
  portal login → accept in admin → task assigned → speaker completes it → session scheduled →
  calendar invite in the speaker's calendar.*

Steps carrying one of those annotations are marked **★**.

---

## Setup

Pick one lane. Everything below works in both; where they differ, the step says so.

**Lane A — local** (`http://localhost:8787`)

```sh
npm run migrate:local
npm run seed:local
npm run dev            # builds, then wrangler dev
```

`.dev.vars` must have `DEV_MODE=on`. That gives you two things you'll rely on: sign-in links
render **on the page** instead of being emailed, and every outgoing email is printed to the
wrangler console as `[email:dev] to=… subject=… ics=…`. Keep that terminal visible — it is your
inbox for this run.

**Lane B — deployed demo** (`https://kms.r-s.workers.dev`)

Nothing to set up, but note: only `james@atelyr.com` and `ada@example.com` get an inline sign-in
link there — everyone else needs a real mailbox. Before starting, open `/`, and in the **Demo
data** box put your own address in *"Send all contact email to"* and reset. Every seeded contact
is rewritten to a `you+name@…` variant, so all demo mail lands in one inbox you can actually
open. Don't start a run just before **09:00 UTC** — that's when the nightly reset fires.

**Fixtures you'll use**

| | |
|---|---|
| Event | *AI.Engineer Sandbox Event – NYC*, Oct 12–14 2026, slug `ai-engineer-sandbox-event` |
| CFP form | *Call for Speakers 2026* — `/submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000001` |
| Admin | `james@atelyr.com` / password `demo-admin-pass` |
| Demo speaker | `ada@example.com` / password `demo-speaker-pass` |
| Rooms | Main Stage (600), Hall A, Hall B, Studio, Pavilion, Lounge |
| Your test submitter | invent one, e.g. `mw01-speaker@example.com` |

Prefix everything you create with a run tag (`mw01-`) so repeat runs stay legible.

---

## Part A — Public CFP and submission

**A1. Open the form.**
Go to `/submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000001`.
- Heading *AI.Engineer NYC — Call for Speakers 2026*, welcome text mentioning the tracks.
- The banner reads *"Form submissions will be accepted until …"* (Sept 15 2026) **·
  Submission limit: 3 per user for this form**.
- Step rail down the side: **Account · Submission · Participant · Review**.

**A2. Account step.**
Type `mw01-speaker@example.com`, click **Continue**.
- An unrecognised address is created and signed in immediately — you land straight on
  **Submission**, no link to click. (Type a *seeded* address instead and you get the sign-in-link
  path instead; that's deliberate, it won't bind you to someone else's identity.)

**A3. ★ Conditional logic.** *(Brief feature #1)*
Fill **Title** = `mw01 Agents in Production`, a **Description**, **Tags**, **Track** = `Agents`.
Now set **Format** = `Workshop`.
- **Room Setup Requirements** and **Prerequisites** appear immediately, no reload.
- Switch Format to `Talk` — both disappear again. Switch back to `Workshop` and fill Room Setup
  (it's required).
Click **Next**.

**A4. Participant step.**
You're pre-filled as the speaker (First Name, Last Name, Email). Add a second participant in a
different role with a distinct name and email. **Next**.

**A5. Review step.**
- Every answer is listed read-only, with an **Edit** link per section.
- Click **Submit**.

**A6. ★ The success page** — the *"make sure this works"* screen.
- Heading **Submission received — SESS-nn** (note the code).
- Below it, the form's own message: *"Thanks for your proposal! Our track leads will review it…"*
  — the configured text, not a generic thank-you.
- A line reading **"Taking you to your speaker portal in 10s…"**, counting down, plus a
  **Continue to portal** button.
- **Let the countdown run out.** You must land in the portal without clicking. That automatic
  redirect is the annotated behaviour; the button alone is not a pass.

**A7. ★ The confirmation email** — the *"must have"*.
- Lane A: in the wrangler terminal, a `[email:dev] to=mw01-speaker@example.com subject=…` line
  for the submission confirmation.
- Lane B: the mail arrives in your redirect inbox; its link signs you into the portal.
- Either lane, it's also logged: admin → **Workspace → Messages**, search the address (do this
  after Part C sign-in if you're going in order).

---

## Part B — Speaker portal, first visit

**B1. You're already in** from A6. Otherwise `/portal/ai-engineer-sandbox-event` → enter the
address → follow the link (or use **Or sign in with a password** if you're testing as Ada).
- Nav across the top: **Home · Submissions · Profile · Tasks**.
- Home shows **My Submissions** with your new card — code, title, status **Pending** — plus
  **My Profile** and **Tasks**.

**B2. ★ Self-service profile** — *"update your own bio data"*.
**Profile** → set **Biography** to `mw01 bio text` → **Save profile**.
- Confirmation *"Profile saved."*, and the text survives a reload.
- Add a **Headshot** and save; the image renders on the profile afterwards.

**B3. Narrow window.** Resize to ~375px and visit Home, Profile, Tasks — all usable, no
sideways scrolling.

---

## Part C — Admin: score, decide, notify

**C1. Sign in as admin.**
Open `/` and use **Demo admin login** (one click), or go to `/app` and sign in as
`james@atelyr.com` with `demo-admin-pass`.
- Sidebar: Dashboard · Workspace · Forms · Evaluation · Review · Agenda · Green Room · Pipeline ·
  Embeds · Settings · Help.

**C2. ★ The submission arrived, routed.** *(Brief feature #1: category routing)*
**Workspace → Submissions**, find `mw01 Agents in Production`.
- Status **Pending**.
- Because Format was Workshop, the routing rule fired: the **Workshops** evaluation plan is
  assigned and the **Production** tag is on the row.

**C3. Seat yourself as a reviewer.**
**Evaluation** → the **Workshops** plan card → **Edit reviewers** → add your admin name and
`james@atelyr.com`. Then use the plan's assign controls (**Assignment strategy**, optionally
**Only assign selected submissions**) → **Assign**, targeting your new submission.
*(The three seeded reviewers — `rosalind.franklin@`, `vint.cerf@`, `frances.allen@` — have no
passwords. On Lane A you can sign in as one via the DEV_MODE link; on Lane B you can't, which is
why seating yourself is the reliable route.)*

**C4. Score it.** *(Brief feature #4)*
Sidebar → **Review** → open your assigned submission.
- Score every criterion (Relevance ×2, Speaker credibility, Novelty), write **Your rationale**,
  then **Save & Next**. Leaving a criterion blank shows *"Score every criterion to save."*

**C5. The rating lands.**
Back on **Workspace → Submissions**: the row's **Rating** column now has the weighted value.
Click the **Rating** header — the list re-sorts.

**C6. Accept.**
Tick your row plus one other pending row. The bulk bar appears at the bottom: *"2 selected"*,
**→ Accept Queue · → Decline Queue · Ask to revise · → Pending · Send decision emails · Add to
speaker pipeline**.
Click **→ Accept Queue** — both statuses change.

**C7. Send the decisions.**
With the rows still ticked, click **Send decision emails**.
- A **Review decision emails** dialog opens with the counts, the real rendered accept email
  (subject + body + sample recipient), and any hold question if a speaker has other submissions
  still undecided.
- Click **Send 2 emails**.
- The bulk note reports what was queued, the **Notified** column flips, and the rows land on
  **Accepted**. Lane A: two `[email:dev]` lines in the terminal.

**C8. Idempotency.**
Select the same rows and click **Send decision emails** again.
- The dialog says the rows are skipped as already notified, or the note reports *"No decision
  emails to send"*. Nothing is sent twice.

**C9. Acceptance assigned tasks.** *(Brief feature #2)*
Shift-click one of the newly accepted rows (or right-click → **Add to filter**) to anchor it —
every other tab narrows to that record. Open the **Tasks** tab.
- **Presentation Upload** (file upload, tied to the submission) and **Flight Reimbursement**
  (portal form) are there — both are `on_accept` automatic tasks.
- Check **Messages** while anchored: the acceptance email is logged against the speaker.

---

## Part D — The speaker completes a task

**D1.** Back in the portal as that speaker → **Tasks**.
- **Presentation Upload** is listed, not started, with its due date; overdue ones are badged
  **Overdue**.

**D2.** Choose a PDF and click **Upload & complete**.
- The task flips to complete (*"Completed …"*), the file is listed as a version, and an
  **Upload a new version** control stays available.

---

## Part E — Agenda, conflicts, calendar invite

**E1.** Sidebar → **Agenda**.
- View tabs: **List · Day · Week · Month · Rooms · Conflicts**, a **Draft/Published** chip, and a
  summary of unplaced / pencilled / conflicting counts.
- Toolbar: search, **Auto-place (N)**, **Send confirmations**, **Publish**, **+ Add Session**.
- The **Conflicts** tab already carries a count — Grace Hopper is seeded double-booked on Oct 12.

**E2.** Switch to **Day** (or **Rooms**) and find your accepted session in the **unscheduled
tray** on the right.

**E3. Drag it in.** *(Brief feature #5)*
Drag the card onto **Main Stage, 10:00 on Oct 12**.
- A ghost follows the cursor; the drop snaps to 15 minutes and the block renders in the slot.

**E4.** Reload the page — it's still there. (Not an optimistic-only write.)

**E5. Make a conflict.**
Drag a second session onto the same Main Stage 10:00 slot.
- The ghost turns **red** before you drop; the drop is allowed anyway.
- Both blocks are flagged, and **Conflicts** shows a room double-booking naming both sessions.

**E6. Resolve it.**
Either drag one session to another room, or focus its block and press **M** (or double-click) →
**Move session** dialog → change Room → **Save**.
- The conflict count drops.

**E7. Keyboard path.** While you're in that dialog, note it has Date, Start time, Duration,
Capacity, Room, plus **Unschedule** — the whole schedule can be driven without dragging.

**E8. Resize.** Drag a block's bottom edge — duration changes, snapping to 5 minutes.

**E9. Undo.** Press **Ctrl+Z** — the last change reverts (an auto-place batch undoes as one unit).

**E10. Send the invites.** *(Brief feature #3)*
Toolbar → **Send confirmations (N)**.
- A live progress line ("Queued X of Y…") then a sent/failed summary.
- Lane A: `[email:dev] … ics=REQUEST` lines in the terminal, one per speaker per session.
- **Workspace → Messages**: a `schedule_confirmed` row per recipient.

**E11. ★ The invite is a real invite.**
Open the mail in Gmail / Outlook / Apple Calendar (Lane B, or forward one) and confirm the `.ics`
renders as a native calendar invite you can accept — not an attachment nobody can use. This is
the last link in the Brief's chain and it is a mail-client check, not a browser check.

**E12. Reschedule.**
Move that same session to a different time.
- A dialog appears: *"… has a live calendar invite. Email its speakers an updated invite for the
  new slot?"* with **Send updated invite** / **Skip the email**.
- Choose **Send updated invite**: a `schedule_changed` message is generated, and the new `.ics`
  carries `SEQUENCE:1` against the same UID — so the speaker's existing calendar entry *moves*
  rather than duplicating.

---

## Part F — Dashboard closes the loop

**F1.** Sidebar → **Dashboard** → the **Speaker Tracking** board.
- **Accepted Speakers** and **Outstanding Speaker Tasks** tiles, a top-speakers-by-outstanding
  list, and an **Overdue tasks** table. Write down the Outstanding Speaker Tasks number.

**F2. ★ It moves on its own.** *(Brief feature #6)*
In a second browser (or profile) signed into the portal as another speaker, complete one
outstanding task. Come back to the dashboard tab and **don't reload it** — leave it visible.
- Within ~15 seconds the count drops. The board self-polls; a hidden tab skips its tick and
  refetches the moment you switch back to it.

**F3. Chase someone.**
On an **Overdue tasks** row, click **Send reminder**.
- Lane A: a `[email:dev]` line. Either lane: the message appears in that speaker's **Messages**
  tab in the workspace.

---

## What has to be true to call it a pass

| Step | Non-negotiable | Source |
|---|---|---|
| A3 | Workshop questions reveal and hide live | Brief #1 |
| A6 | Custom success message **and** the automatic redirect to the portal | ★ "make sure this works" |
| A7 | Submitter gets a confirmation email | ★ "must have" |
| B2 | Speaker edits their own bio and headshot | ★ "update your own bio data" |
| C2 | Routing assigned the Workshops plan and the Production tag | Brief #1 |
| C4–C8 | Score → accept → decision email → Notified, and no double-send | Brief #4 |
| C9–D2 | Acceptance auto-assigns a task; the speaker completes it in the portal | Brief #2 |
| E3–E6 | Drag-and-drop scheduling, conflict flagged, conflict resolved | Brief #5 |
| E10–E12 | Invite delivered as a real `.ics`, and updated in place on reschedule | Brief #3 |
| F2 | Outstanding-task count moves without a reload | Brief #6 |

A step you couldn't attempt is **blocked**, not passed — record it as blocked and name the step
it depended on.

---

Broader coverage (closed forms, empty states, role gates, speed budgets, API and exports) lives
in [docs/14-e2e-browser-test.md](../docs/14-e2e-browser-test.md); this file is only the path the
Brief insists on.
