# Extras — things to try that the brief never asked for

The brief asks for six things: custom CFP submission forms with conditional logic and routing, a
self-service speaker portal, automated templated speaker communications with calendar invites,
submission evaluation and scoring, drag-and-drop schedule building with conflict detection, and a
real-time dashboard of outstanding onboarding tasks. Those are covered in the
[user manual](manual/README.md) and are not repeated here.

This page is for anyone testing the system who wants to find the parts that go beyond that list.
Each entry says what it does and where to click. Roughly ordered by how much difference it makes
to someone actually running an event, so working from the top is a reasonable test route.

---

### 1. Pick one record, and every other list follows it

Open **Workspace** and shift-click any row — a speaker, say. Every other open tab narrows to just
what relates to that person: their submissions, their tasks, their reviews, comments, messages and
files. A pushpin appears on each tab that's been narrowed, and a **Filtered by** chip near the
header clears it again.

Worth trying: Ctrl/Cmd-click a second row to hold *two* anchors at once (one speaker and one
submission, for instance) rather than replacing the first. Clicking the small dot on a tab's label
does the same job as shift-clicking, and right-clicking either a row or a tab label gives you the
same options as a menu.

### 2. Use the whole thing on your phone

The brief mentions mobile exactly once, in a struck-through line, and only about embeddable
widgets. Everything else here is unrequested: open the deployed URL on a phone and the public CFP
wizard, the magic-link pages, the speaker portal, the public event pages, the Dashboard, the
Agenda and all eight Workspace tabs are laid out for a 390px screen, not shrunk down to one.

Things to look for: list rows become cards; the Workspace tab strip becomes a dropdown selector
with its own close controls; the admin sidebar and header compact rather than squeezing the content
into a sliver. Rotating to tablet width (768px) is a distinct layout again, and nothing about the
desktop view changes.

### 3. Screens that say "not on a phone" instead of breaking

Where a screen's job is arranging many records against each other rather than acting on one, it
doesn't hide itself and doesn't squash — it shows a short panel explaining why, a read-only summary
of what's on the screen, and the one action still worth taking at that size. Try the bulk-action
bar and the anchor chip on a narrow window: they step aside deliberately, and the list and detail
views keep working.

### 4. Green Room — the day of the event

**Green Room** in the sidebar. A phone-shaped run-of-show screen: who's on stage now and next in
each room, a check-in toggle as speakers arrive, readiness flags (bio done, headshot in, slides
received) and tap-to-call contact actions. Nothing in the brief covers the last 48 hours of an
event.

### 5. Import a spreadsheet, then undo the whole thing

**Workspace → Speakers → ↥ Import**, or the same button on **Submissions**. Upload a CSV or Excel
file, map the columns, dry-run it, then commit. There's a named Sessionboard mode for their export
format, speakers get linked to their sessions automatically, and any column you didn't map is kept
on the record rather than dropped.

The part worth testing: every import is recorded as a batch with a per-row report, and one click
undoes it completely. Import a messy file on purpose and roll it back.

### 6. Take the committee's work with you

**Workspace → Reviews** and **Workspace → Comments** are full tabs, not a hidden sub-view — every
score with its per-criterion breakdown, the reviewer, the round, the conflict-of-interest flag and
the written rationale, all sortable and filterable, with the same CSV and XLSX export buttons as
every other tab. The exports respect whatever filter and anchor you've currently got set, so you
get what's on screen rather than everything.

### 7. Drive it entirely over the API — or hand it to an agent

**Settings → API tokens**, create a token, then hit `/api/v1/events` with
`Authorization: Bearer kms_…`. Rendered documentation is at `/docs` and the raw spec at
`/api/v1/openapi.json`. Both are generated from the same definitions the admin screens query, so
anything you can filter, sort or export in the UI works identically over HTTP — including the
XLSX exports.

The part nobody asked for: that spec is written for an AI agent as much as for a person. There's
an **`/llms.txt`** at the root — the file agents are built to look for — with the base URL, how to
authenticate and where to start. The OpenAPI document names every field it returns *and* the
things that trip callers up (JSON columns come back as strings, booleans as `0`/`1`, scheduled
times are in the event's timezone, and the approval/conditional/revise flags are separate columns
from the status rather than values inside it). Every endpoint has a stable id, so tooling can turn
the document straight into callable functions, and the accepted values come from the same code
that enforces them, so a published list can't quietly drift from what the server will take.

It's equally explicit about what it *won't* do — no webhooks, no bulk endpoints, and above all no
email: changing a submission's status over the API never writes to a speaker, because decision
batches are sent from the app on purpose. An agent given a token can't accidentally notify two
hundred people.

Worth testing: give an AI assistant the URL `<host>/llms.txt` and a token, then ask it something
real — "which accepted speakers still owe us a headshot?", or "how many pending submissions have
fewer than two reviews?" It should get there without you explaining the API. Also it can write updates, for instance scanning submissions for spam and setting tags so you can deal with them.

### 8. Embed the schedule and the speaker gallery on another site

**Embeds** in the sidebar. Sessions, speakers, an agenda grid, a schedule and a speaker gallery,
each available as a styled `<script>` snippet, an iframe, or a raw feed — including
`/e/<slug>/agenda.xml`. Configurations can be saved and named, so the screen also answers "what
have we embedded, and where?" (The brief struck this one out.)

### 9. The manual is inside the app

**Help** in the sidebar. Twenty-five plain-language pages covering every screen, written for
organisers rather than developers, searchable and served from the app itself — with a master/detail
layout when you're on a narrow screen. If anything below is unclear, its manual page is the place
to look.

### 10. Track speakers before they're speakers

**Pipeline** in the sidebar. An organisation-wide prospecting board — prospect, invited, awaiting
reply, confirmed, declined — with notes and a full stage history per card. **+ Enroll New** puts a
prospect straight onto an event's roster without retyping them, and highlights the card it came
from.

### 11. Find what nobody has reviewed yet

**Workspace → Submissions**. Alongside sorting by score, you can filter to submissions with fewer
than N recorded reads — the tail of the review process, which is the thing that actually holds up a
decision meeting. A coverage bar above the list counts against the same filter, so the number and
the list can't disagree.

> **Note:** there's a filter and a bar, but no "sort by fewest reads" — that sort was tried and
> removed because it made the Rating column look shuffled. The filter does the same job better.

### 12. "Accepted — pending their employer's sign-off"

Open any accepted submission's detail. Next to Status there's an independent **Approval** control:
not asked, pending, granted, or refused, plus a free-text note for what's actually being chased
("legal says end of month"). It's a second axis, not a status, so it doesn't disturb the accept
queue or the decision emails.

Then check **Dashboard → Speaker Tracking**: an **Approval pending** panel lists those speakers
with a countdown of days until the event. The acceptance email can optionally ask the question for
you, opt-in per batch.

### 13. See automatic reminders before sending

By default the system chases speakers automatically. Switch the event to assisted mode in
**Settings → Chase inbox**, and the same nightly sweep stages an editable draft instead of sending
anything. The drafts appear in a **chase inbox** on **Dashboard → Speaker Tracking**, grouped by
speaker, each with Save, Send, Dismiss and Escalate, plus a **Send all** button. Nothing reaches a
speaker without a click, and replies come back to the organiser rather than the system address.

The escalation ladder — tool email, personal email, CC the chair, text, call — is recorded and
shown per draft, but never climbed automatically.

### 14. Pencil a talk in without committing

On **Agenda**, drag a session onto a day header rather than into a slot. It holds the day (or a
time without a room) and renders on the board as a provisional block instead of vanishing back into
the unscheduled tray. Pencilled sessions stay out of the public feeds and the invite send until
someone confirms them, and the header keeps a live count: `N unplaced · N pencilled · N conflicts`.

### 15. Argue about a submission in one place

Every submission has a single append-only comment thread that reviewers and organisers both write
into — open any submission's detail, or browse them all on **Workspace → Comments**.

### 16. Count slots against a target during the decision meeting

Give tracks a target number of slots, and a chip strip appears above the submissions grid showing
where each track stands. Going over target colours the chip rather than blocking anything — the
counts use the same query as the list, so they move as you accept and decline.

### 17. One decision letter per speaker

Accept two of someone's three talks and decline the third: they receive one merged email covering
all three, not three separate letters.

### 18. Chase slides through their own states

Once a deck lands against the event's slides request, the submission's materials state flips to
*received* on its own. From there an organiser moves it through reviewed, revision requested and
final. **Dashboard** surfaces what's outstanding.

### 19. "In, provided X happens"

Alongside the approval flag, a submission can carry a conditional-accept marker for an acceptance
that depends on something else landing — again independent of the acceptance status itself.

### 20. One person, one record, across every event

A speaker is a single record for the whole organisation, not one per event. A returning speaker's
details seed forward instead of being retyped, and their history is one list rather than several.
Try creating a speaker on a second event with an email that already exists.

### 21. Merge the duplicates you'll inevitably create

**Workspace → Speakers → ⧉ Duplicates** reviews likely duplicate people across the organisation and
merges them. Adding a speaker whose name already exists also offers a **Merge instead?** link at
the point of creation.

### 22. Save a filter as a list you can come back to

On **Speakers**, **☆ Save segment** freezes either your current filters or the specific rows you've
ticked as a named segment; **☰ Segments** browses, opens and deletes them.

### 23. Give speakers a workflow status of your own

**Settings → Speaker statuses**. Beyond the built-in values you can define your own per event, and
they become filter chips on the Speakers tab.

### 24. Add fields the app doesn't ship with

**Settings → Speaker fields**. Add "dietary needs", "travel preferences" or anything else to the
speaker record without touching the schema — they appear on the record and travel through exports.

### 25. Assign a task to a whole audience

When creating a task, pick a named audience (all accepted speakers, say) instead of ticking people
one at a time. The picker shows a live count for each audience before you commit.

### 26. Score with more than numbers

**Evaluation** → build a scorecard. A criterion can be a weighted numeric scale, a dropdown of
options you type in, or an unweighted long-text comment field. Only the numeric ones feed the
weighted average.

### 27. Cap how much you give each reviewer

While editing a reviewer on an evaluation plan, set a maximum number of submissions they can be
assigned. Round-robin assignment respects it, and the screen tells you which submissions came up
short of reviewers because of a cap.

### 28. Manage formats like tracks

**Settings → Rooms, tracks & formats**. Session formats are a managed per-event list that drives
the form dropdown when the form is rendered — renaming one no longer means editing every form that
offers it.

### 29. Keep internal fields off the public form

Fields declare whether they're speaker-facing or organiser-only, so operational things like a
client session ID or CEU credits stay out of the public CFP wizard while remaining available in the
admin and in imports. Compare a form in the builder with the same form on its public URL.

### 30. Unpublish a session without declining it

An accepted, scheduled session can be pulled out of every public feed — agenda, speaker list, ICS,
embeds — without changing its decision or kicking it off the schedule.

### 31. Job titles frozen at the moment of submission

Editing a speaker's current profile doesn't rewrite what their title and employer said on last
year's talk. The submission keeps the values as they read when it was submitted, which is what
makes a multi-year export worth anything.

### 32. See what a submission used to say

Every edit to a title or description — from the admin side or by the speaker in the portal — keeps
a snapshot of the previous version, retrievable through the API.

### 33. Export across events, not one at a time

With an anchor set, the export honours it, so you can pull one speaker's entire history across
every event in the organisation rather than exporting each event separately.

### 34. Sign in with a password, not just a magic link

Magic links work throughout, but an account can also carry a password. Repeated failed attempts are
throttled.

### 35. A theme whose contrast is actually checked

The Editorial Broadsheet look is built from a shared token layer with automated contrast tests, so
the palette is verified rather than asserted. Worth a look in both the admin and the public pages.

### 36. Reset the demo whenever you've made a mess

**Settings → Demo data**. A one-click reset restores the seeded event, and the deployment also
resets nightly. On a demo instance the sign-in magic link is shown on screen rather than emailed,
and anything sent to an `@example.com` address counts as delivered — so you can test the whole
email pipeline without an inbox.

---

## Don't go looking for these

To save you hunting: AI-assisted review, a ⌘K command palette, cloning last year's event, and a
full export/re-import archive were all considered and are **not** built. Neither is the
Accelevents integration or the wiki/resource pages in the speaker portal — both struck through in
the brief.
