# 12 — Build Plan, Seed Data & Demo Script

Deadline: **Wednesday 12 August, 10:00 PM PT.** The plan below assumes work starts Saturday
8 August and treats Tuesday evening as the real finish line, leaving Wednesday for buffer,
deployment and the write-up.

---

## 1. Milestones

### M0 — Foundations (Sat AM, ~3 h)
- Repo, licence (MIT), README skeleton, CI.
- Cloudflare Worker + Hono + Vite scaffold; D1, R2, KV, Queue bindings.
- Schema and migrations for the entities in [02](02-domain-model.md).
- Auth: magic link, signed cookie, role guard, `Scope` plumbing.
- **Exit:** a seeded event renders behind login.

### M1 — Forms & public submission (Sat PM, ~6 h) — *brief #1*
- Form builder wizard: Submission Setup, Welcome, Abstract, Participant, Settings, Notifications.
- Question list with drag order, required toggles, locked system fields, field library + create field.
- Conditional-logic editor and evaluator (client + server).
- Routing-rule engine.
- Public wizard: Welcome → Account → Submission → Participant → Review, autosave drafts,
  close date, submission limits, success page, 10-second auto-redirect.
- **Exit:** a proposal can be submitted end-to-end and appears in the admin grid.

### M2 — Portal & communications (Sun AM, ~6 h) — *brief #2, #3*
- Portal: Home, Submissions, Profile (bio, headshot, links), Tasks.
- Email pipeline: templates, themes, renderer, queue consumer, message log.
- `submission_confirmation` ("must have"), `magic_link`, `task_assigned`.
- ICS builder + `schedule_confirmed` with Gmail/Outlook/iCal verification.
- Cron reminder sweeps.
- **Exit:** submit → email → portal login → edit profile, all without a password.

### M3 — Review & scoring (Sun PM, ~5 h) — *brief #4*
- Abstracts grid: status tabs, search, filter, sort, column preferences, saved views, pagination.
- Inline status editing, bulk actions, detail drawer with Details/Participants.
- Evaluation plans, criteria, reviewer assignment, reviewer workspace, rating aggregation.
- Decision emails with idempotency.
- **Exit:** score, sort by rating, bulk-accept, notify.

### M4 — Agenda & conflicts (Mon, ~7 h) — *brief #5*
- Views: List, Day, Week, Month, Rooms, Conflicts; track grouping.
- Unscheduled tray, drag/drop/resize, undo, keyboard Move dialog.
- Conflict engine with the eight rules; Conflicts view with resolve actions.
- Schedule-change emails with updated `.ics`.
- **Exit:** schedule an accepted session, provoke and resolve a conflict, receive an invite.

### M5 — Dashboard (Tue AM, ~4 h) — *brief #6*
- Today dashboard: KPIs, status tiles, "Also check" nudges, tabs.
- **Speaker Tracking dashboard** (the required one): accepted speakers, outstanding tasks,
  top speakers by outstanding tasks, overdue list with "Send reminder", asset completeness.
- Submissions Pipeline dashboard.
- Live refresh with ETag polling.
- **Exit:** completing a portal task visibly moves the dashboard.

### M6 — API, polish, deploy (Tue PM, ~5 h)
- REST API + OpenAPI + `/docs`; webhooks if time allows.
- Airtable mirror worker (bonus).
- Exports (CSV/XLSX, files bundle).
- Performance pass against the budgets in [03 §6](03-architecture.md); Lighthouse on the public pages.
- Accessibility pass; empty states; error states.
- Seed the public demo, nightly reset cron.
- README with a 15-minute deploy path, architecture notes and the judgment-call rationale.

### M7 — Buffer & submission (Wed)
- Run the demo script end-to-end three times, on desktop and phone.
- Record a 3–5 minute walkthrough matching the organiser's video.
- Push to Forge (+ GitHub mirror), submit the form.

### Cut list, in order
If time runs short, drop in this order — every item here is explicitly optional or struck through:
embeds → dashboard builder/gallery → Review Progress dashboard → webhooks → Airtable mirror →
cross-field character limits → saved views → import → Month view → personas/record settings.

**Never cut:** the confirmation email, the success page + portal redirect, conditional logic,
routing, conflict detection, calendar invites, outstanding-task tracking.

---

## 2. Seed data (demo instance)

Model it on the real event so judges recognise it.

**Event** — "AI.Engineer Sandbox Event – NYC", slug `ai-engineer-sandbox-event`,
Oct 12–14 2026, New York, `America/Los_Angeles`, theme "Test Event for NYC".

**Tracks** — Agents · Evals · RAG & Retrieval · Infra & Serving · AI in Production
**Rooms** — Main Stage (600) · Hall A (250) · Hall B (250) · Studio (80) · Pavilion (120) · Lounge (40)
**Formats** — Keynote · Featured Keynote · Talk · Workshop · Panel · Lightning Talk
**Levels** — Beginner · Intermediate · Advanced
**Tags** — Open Source · Research · Production · Sponsor

**Forms**
1. *Call for Speakers 2026* — open, closes 15 Sep 2026 23:59 PT, limit 3/user, participants on,
   one conditional question (Workshop → room setup + prerequisites), routing by track to three
   evaluation plans. **This is the form judges will use.**
2. *Session Submission Form #2* — open, 1 submission, no close date.
3. *Lightning Talks* — closed, to demonstrate the closed state.

**Contacts** — 24 speakers; a deliberate spread: 6 with complete bio+headshot, 4 missing headshots,
2 missing bios, the rest partial. 3 reviewers, 2 admins.

**Submissions** — 40 total: 8 accepted (5 scheduled, **3 unscheduled so the nudge fires**),
6 accept queue, 14 pending, 4 decline queue, 5 declined, 2 withdrawn, 1 draft.

**Evaluation** — "Round 1 — Track leads": criteria Relevance (w2), Speaker credibility (w1),
Novelty (w1), scale 1–5; 3 reviewers; ~60% of reviews complete so Review Progress has data.

**Tasks** — *Presentation Upload* (submission task, file upload, due T-14d),
*Speaker Profile & Headshot* (contact task, due T-30d),
*Hotel and Travel Reservations* (contact task, portal form, due T-21d),
*Speaker Agreement* (contact task, acknowledge).
Seed so that **4 speakers have outstanding tasks and 2 are overdue**.

**Agenda** — 5 sessions scheduled on Oct 12 across Main Stage and Hall A, with **one deliberate
speaker double-booking left in place** so the Conflicts view is non-empty on arrival.

**Demo logins** — a documented admin login and a documented speaker login on the deployed site's
front page, plus a "reset demo data" button. Judges should never have to ask how to get in.

---

## 3. Demo script (the path that must be flawless)

This mirrors the organiser's walkthrough video. Time it: target under 6 minutes.

1. **Public CFP** — open `/submit/ai-engineer-sandbox-event/<form>`. Deadline banner and
   submission limit are visible. Read the welcome copy.
2. **Submit** — enter an email; complete the submission step; choose format **Workshop** and watch
   the conditional questions appear; add a second speaker; review; submit.
3. **Success** — the customised success page shows, then auto-redirects to the portal after 10 s.
4. **Email** — the confirmation email has arrived with a working portal link.
5. **Portal** — land authenticated on Home. Edit the bio, upload a headshot, see the Tasks panel.
6. **Admin → Abstracts** — the new submission is `Pending`, routed to the *Workshops* evaluation
   plan and tagged by the routing rule.
7. **Review** — open the reviewer workspace, score it, return to the grid and sort by rating.
8. **Accept** — bulk-select, move to Accept Queue, send decision emails; `Notified` flips.
9. **Tasks** — the acceptance auto-assigned *Presentation Upload*; the dashboard's
   **Outstanding Speaker Tasks** count rises.
10. **Portal again** — complete the task by uploading a PDF; the dashboard count falls live.
11. **Agenda** — drag the accepted session from the tray onto Main Stage 10:00. Drop a second
    session on the same slot → `ROOM_DOUBLE_BOOKED` flags both; open Conflicts and resolve it.
12. **Calendar invite** — the schedule confirmation email arrives with a `.ics`; add it in Gmail;
    move the session in the admin and show the calendar entry **updating in place**.
13. **Dashboard** — Speaker Tracking: accepted speakers, top speakers by outstanding tasks,
    overdue list; send a reminder from the row.
14. **API** — `curl` the submissions endpoint and show `/docs`.
15. **Speed** — show the Lighthouse score for the public CFP page.

---

## 4. Submission checklist

- [ ] Public deployed URL, seeded, with demo credentials on the landing page
- [ ] Open-source repo (Forge, mirrored to GitHub), MIT licence
- [ ] README: what it is, screenshots/GIF, 15-minute deploy, architecture, judgment calls made,
      what is deliberately out of scope and why
- [ ] `docs/` (this set) included in the repo
- [ ] 3–5 minute walkthrough video matching the script above
- [ ] Demo-reset cron running
- [ ] Token-cost receipts kept for the $500 reimbursement claim
- [ ] Organiser's submission form completed before **Wed 12 Aug, 10:00 PM PT**
