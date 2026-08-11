# Replies to Fabian — the series (revised per Gene; STE100-inspired clear pass)

> Fabian, 12:53 PM: "Interesting insights! I think your long experience with these
> tools and actually organising conferences is really valuable. Are there any
> other major pain points or big wishes you would like to share?"

Four posts. Post one per day through Wednesday, in order.

---

## #1 — Review is a conversation, not a process

Fabian — happy to. Here is the biggest one: a small committee experiences review
as **conversation**. Every tool we paid for modeled it as **process**.

Our committee is nine trusted peers. All of them read everything. The tools gave
us evaluation plans, assignment matrices, review rounds, and blind scoring —
machinery for fairness at scale, a problem we never had. The tool we loved most
(BusyConf, RIP) did something simpler: it emailed every full proposal to every
committee member and gave each proposal one comment thread. Review happened over
coffee.

Three concrete lessons:

- **The permalink is the atomic unit of committee discourse.** One incumbent had
  no per-submission links. The official workaround: "refer to them by Google
  Sheets row." The committee moved to Trello within months.
- **Two sorts are the whole review UI.** Sort by fewest ratings first: that is
  the coverage worklist ("every talk gets two reads," with a progress bar). Sort
  by average score descending: that is the agenda for the decision meeting. We
  ran ten years of program committees on those two sorts.
- **Deciding and telling are different acts.** Statuses change freely all
  season. The letters go out once, in a deliberate batch. A tool that sends
  email on every status change gets abandoned — or worse, trusted, and then a
  talk gets un-accepted *after* the congratulations email.

---

## #2 — A confession about scheduling (the spreadsheet always wins)

More for Fabian's question. This one is a confession, and a warning about where
not to spend your weekend hours.

In 12 years and ~24 events, we never once scheduled a conference inside a CFP
tool. Every schedule was built in a Google Sheet. Ours was named "Schedule
Blocking." It outlived four commercial tools across ten straight years. Slot
arithmetic happened live in Slack during the weekly call.

Why does the spreadsheet win? The schedule is the most fluid artifact of the
event. Talks get accepted before rooms exist. The keynote is "Tuesday morning,
somewhere" for six weeks. Two sessions want the same speaker; you know it, and
you will fix it Thursday. A spreadsheet never says no. It has no required
fields. It saves every half-decision. A tool that adds any friction to that
fluidity loses immediately, no matter how good its drag-and-drop is.

So I am dubious of schedule builders — including the one we are building. The
only credible path I see: **first match the spreadsheet's fluidity** — "TBD" is
a real value, partial states always save — **then add the one thing a
spreadsheet cannot do: surface constraints without enforcing them.** Live slot
math ("3 unplaced · 1 conflict"). A double-booked speaker shown as a named chip
with a one-click fix — never a modal that blocks the save.

Is that enough to beat the Sheet? After 12 years, honestly: still an open
question. Curious what others here are doing with their agenda builders.

---

## #3 — The data grave (what happens after the show)

Continuing Fabian's thread. My biggest *wish* is not a feature. It is that the
committee's work product would **survive the conference**.

We have run ~26 conferences over 15 years. Ask three of our live systems how
many talks one long-time speaker has given, and you get three answers: 6, 9,
and 12. No CFP tool ever emitted a stable speaker id, talk id, or event id, so
every downstream join is a fuzzy string match. Our 26 conferences appear in our
own records as 51 event rows.

When we migrated from Sessionize to Sched, exactly six speaker fields survived
the handoff. Everything the committee produced — scores, comments, decisions,
reasoning — has never left a CFP tool. Not once, on any platform, in 15 years.

The absurd part: the most valuable longitudinal dataset we own is the career
progression of our speakers across a decade — IC to director to VP, visible
talk by talk. It exists only because people typed their job titles into a
throwaway display field each year.

The wish, for everyone building this weekend: **stable ids on everything;
`title_at_time` and `org_at_time` frozen at submission; exports as a
first-class surface** — sessions.json, speakers.json, an .ics whose UIDs do not
churn, and the decisions themselves. Your weekend build is the system of record
for a community's institutional memory. Act like it.

---

## #4 — The chase (the pain no tool models)

Last one for Fabian, and the deepest: **the real work starts after acceptance.**

Yesterday I had Claude read the Slack channel where our event coordinator has
run speaker logistics for years — 13,488 messages. What consumes her life is
the chase. Slides are chased hardest: the median ask lands 8 days before the
event. Co-presenter details are the worst per-field offender: roughly 90% of
mentions needed a human follow-up, often to a person who is not in any system
yet ("accepted *if* you bring your ops counterpart").

Two findings for every builder here:

1. **Escalation runs by medium, not by attempt count**: tool email → her
   personal email → cc me → she texts → I call. Each step up is a deliberate
   signal: "this is getting serious."
2. **In 13 years of archive, there is zero evidence of a tool successfully
   sending a reminder on our behalf.** The identical "got stuck in spam, I'm
   sending a personal email" incident appears in 2023 *and* 2025. A feature
   that auto-emails speakers will be switched off within one event cycle.
   Build **assisted chasing** — drafts a human reviews and sends from their own
   address. Not autonomous sending.

Bonus pain: **employer approval** is the #1 cause of speaker withdrawal in ten
years of our records, and it arrives late. The speaker said yes; their
PR/legal/finance chain had not. Approval chatter peaks about a month out.
Withdrawals cluster 29 days out, with a tail to 5 days — sometimes *after* the
speaker was announced. No tool models "accepted, employer approval pending" as
a state. Ours will.
