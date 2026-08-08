# 12 — Build Plan, Seed Data & Demo Script

Deadline: **Wednesday 12 August, 10:00 PM PT.** The plan below assumes work starts Saturday
8 August and treats Tuesday evening as the real finish line, leaving Wednesday for buffer,
deployment and the write-up.

---

## 0. Admin UI idiom — the tab workspace

The admin's record-keeping core is **not** built as per-resource grid pages with detail
drawers (the original [11 §3](11-ui-and-navigation.md) plan). It is one **tab workspace**
built on `DataTabManager`/`DataList` (ported into `apps/admin/src/components/` from the
atelyr codebase; kept near-verbatim for diffability, with a minimal local `RecordForm`
standing in for the schema-form stack):

- **List tabs** — one per entity: Speakers, Submissions, Tasks, and (as time allows)
  Messages and Files. Virtualised infinite scroll, sortable columns, per-tab filters,
  live row counts on the tab labels.
- **Detail / create / edit tabs** — opened from rows (double-click, context menu, "+"),
  inserted next to their parent list tab, with dirty-state guarding. Simple entities get
  schema-driven forms; Submissions get a custom detail component.
- **The global anchor filter** — shift-click a row (or right-click → *Make global filter*)
  and every other tab narrows to records related to it: anchor a speaker and Submissions,
  Tasks, Messages show *theirs*; anchor a submission and Speakers shows its participants.
  This replaces the bespoke "detail page assembling related sub-lists" screens Sessionboard
  uses, with one symmetric mechanism — and it is the demo's differentiator moment.

Ground rules for where the idiom applies (per the assessment that led to this):

- **In the idiom:** Speakers, Submissions, Tasks, Messages, Files — the flat, highly
  relational CRM core. Relation filters use explicit per-tab receive maps
  (`contact_id`, `submission_id`, `track_id`, `tag_id`); join-table relations
  (participants, task assignments) are resolved server-side with `EXISTS` — the tab never
  exposes junction rows directly. Ambiguous paths get named columns/filters
  ("Submitted" vs "Speaking on"), never a bare "related".
- **Not in the idiom:** the form builder, public CFP wizard, speaker portal, reviewer
  workspace, agenda editor and dashboards stay bespoke as specced. Where cheap, they
  *consume* the anchor (agenda filtered to the anchored speaker is a stretch goal, not a
  commitment).
- **Deliberately dropped** because the components don't do them and the deadline doesn't
  need them: column show/hide + width persistence, multi-key sort, page-number pagination
  (infinite scroll instead), saved views. Status tabs become status filter chips inside
  the Submissions tab, with the tab count tracking the active filter.

---

## 1. Milestones

### M0 — Foundations (Sat AM, ~3 h) — **done**
- **Spike, first hour — native calendar invites (acceptance criterion #6, the likeliest late
  failure):** send a real `.ics` through Resend from the actual sending domain, built as a
  `text/calendar; method=REQUEST` *alternative MIME part* (not merely an attachment). Verify it
  renders as a native invite in Gmail, Outlook and Apple Calendar, and that re-sending with an
  incremented `SEQUENCE` updates the calendar entry in place and `METHOD:CANCEL` removes it.
  If any client fails, there are still four days to change the MIME shape or provider.
  **Result (Aug 8, spikes/):** Gmail renders natively even from a REST attachment; Outlook does
  not, and delivered-MIME inspection proved why — Resend (REST and SMTP alike) re-files the
  `text/calendar` alternative part as a generic attachment and strips `method=REQUEST`
  (nodemailer's local output verified correct; upstream resend-node #198, closed unfixed).
  **Decision: invite emails go through a calendar-safe provider (SendGrid REST planned); all
  other mail stays on Resend.** Still open: verify SendGrid on Outlook, the SEQUENCE update /
  METHOD:CANCEL round-trip on the final provider, and the Apple Calendar leg (no iCloud test
  address yet).
- Repo, licence (MIT), README skeleton, CI.
- Cloudflare Worker + Hono + Vite scaffold; D1, R2, KV, Cron bindings; `outbox` table
  (no Queues — free tier, see [03 §2a](03-architecture.md)).
- Schema and migrations for the entities in [02](02-domain-model.md).
- Auth: magic link, signed cookie, role guard, `Scope` plumbing.
- **Also done (Aug 8):** `DataTabManager`/`DataList` + closure ported into `apps/admin`,
  type-clean, building, and browser-verified against in-memory demo data (global filter,
  create/edit round trip). See §0.
- **Exit:** a seeded event renders behind login. ✅

### M0.5 — Tab workspace on real data (Sat early PM, ~2.5 h) — **done**
- Admin shell for the `/app` SPA: event switcher, slim sidebar
  (Dashboard · Workspace · Forms · Evaluation · Agenda · Settings), session/role gate.
- **Generic list endpoint pattern** on the Worker: `from`/`size`/`filters`/`sort` in,
  `{ items, total }` out, per resource. Relation filter params translated to `EXISTS`
  joins: `contact_id` on submissions (via `submitter_contact_id` *and* participants, as
  separate named filters), `submission_id` on contacts (via participants), `track_id`,
  `tag_id`, `status`, free-text `q`.
- TabConfigs for **Speakers** and **Submissions** against those endpoints, with both
  directions of the anchor filter mapped (`globalFilterSets`/`globalFilterReceives`).
  Speakers create/edit via JSON Schema + `RecordForm`; delete with confirm.
- **Workspace skin pass** (pulled forward from M6 so the design is reviewable early):
  tokenise the ported `DataTabManager.css`/`DataList.css` onto CSS custom properties
  extending the M0 page palette (neutral greys, `#2563eb` accent, labelled status
  chips), per the [11 §4](11-ui-and-navigation.md) direction — 13 px grids, 32 px
  compact rows, flat 1 px borders, ≤150 ms motion, dark mode with both themes explicit.
- Replace the in-memory demo wiring in `App.tsx` with the real API.
- **Exit:** seeded speakers and submissions browsable in the workspace; anchoring
  Ada narrows Submissions to hers, against D1. ✅
- **Notes (Aug 8):** the skin pass had already landed with the M0 port. Delivered here:
  `/app/api` JSON routes (`POST /:resource/query` with whitelisted filter/sort maps,
  contact CRUD, `/me`, `/switch-event`); the SPA build lands in
  `apps/public/dist/app` and `/app` stays behind the Worker's session gate via
  `run_worker_first`; both anchor directions browser-verified (Ada → her 3
  submissions; a submission → its participants), plus speaker create/edit/delete
  round-trip and server-side sort.

### M1 — Forms & public submission (Sat PM, ~6 h) — *brief #1*
- Form builder wizard: Submission Setup, Welcome, Abstract, Participant, Settings, Notifications.
- Question list with drag order, required toggles, locked system fields, field library + create field.
- Conditional-logic editor and evaluator (client + server).
- Routing-rule engine.
- Public wizard: Welcome → Account → Submission → Participant → Review, autosave drafts,
  close date, submission limits, success page, 10-second auto-redirect.
- **Exit:** a proposal can be submitted end-to-end and appears in the workspace
  Submissions tab.

### M2 — Portal & communications (Sun AM, ~6 h) — *brief #2, #3*
- Portal: Home, Submissions, Profile (bio, headshot, links), Tasks.
- Email pipeline: templates, themes, renderer, outbox consumer + retry sweep, message log.
- `submission_confirmation` ("must have"), `magic_link`, `task_assigned`.
- ICS builder + `schedule_confirmed`, wired to the MIME shape proven by the M0 spike.
- Cron reminder sweeps.
- *Stretch (~30 min):* **Messages** list tab over `message_log`, receiving the
  `contact_id` anchor — makes "every email we sent this speaker" a one-click view and
  gives comms debugging a UI for free.
- **Exit:** submit → email → portal login → edit profile, all without a password.

### M3 — Review & scoring (Sun PM, ~4 h) — *brief #4*
The 5-hour bespoke-grid line item from the original plan is gone; the workspace already
does search/sort/virtualise/detail. What remains:
- Submissions tab: status **filter chips** (`FilterComponent`) with the tab count tracking
  the active chip; rating column from `rating_cache`; inline status edit via an editable
  column.
- Row checklist + a **bulk-action bar** (wired through `onChecklist`): move to accept/decline
  queue, send decision emails (idempotent).
- Submission detail tab (custom component): answers, participants with roles, review
  summary — and participants also reachable by anchoring the row and reading Speakers.
- **Tasks** list tab over `task_assignments` (joined to task + contact), receiving both
  `contact_id` and `submission_id` anchors.
- Evaluation plans + criteria config (schema-driven forms where they fit), reviewer
  assignment, bespoke reviewer workspace, rating aggregation.
- **Exit:** score, sort by rating, bulk-accept, notify — from the workspace.

### M4 — Agenda & conflicts (Mon, ~7 h) — *brief #5*
- Views: List, Day, Week, Month, Rooms, Conflicts; track grouping.
- Unscheduled tray, drag/drop/resize, undo, keyboard Move dialog.
- Conflict engine with the eight rules; Conflicts view with resolve actions.
- Schedule-change emails with updated `.ics`.
- *Stretch:* the agenda respects the workspace anchor (calendar filtered to the anchored
  speaker/track).
- **Exit:** schedule an accepted session, provoke and resolve a conflict, receive an invite.

### M5 — Dashboard (Tue AM, ~4 h) — *brief #6*
- Today dashboard: KPIs, status tiles, "Also check" nudges, tabs.
- **Speaker Tracking dashboard** (the required one): accepted speakers, outstanding tasks,
  top speakers by outstanding tasks, overdue list with "Send reminder", asset completeness.
- Submissions Pipeline dashboard.
- Live refresh with ETag polling.
- *Stretch:* dashboard rows deep-link into the workspace with the row pre-anchored
  (e.g. an overdue speaker opens Tasks narrowed to them).
- **Exit:** completing a portal task visibly moves the dashboard.

### M6 — API, polish, deploy (Tue PM, ~5 h)
- REST API + OpenAPI + `/docs`; webhooks if time allows.
- Airtable mirror worker (bonus).
- Exports (CSV/XLSX, files bundle) — served by the API, offered from the workspace tabs.
- Workspace polish remainder: replace the `window.alert`/`confirm` call sites with proper
  dialogs (the skin pass itself moved to M0.5).
- *If time:* **Files** list tab over `file_assets` receiving the anchor.
- Performance pass against the budgets in [03 §6](03-architecture.md); Lighthouse on the public pages.
- Accessibility pass; empty states; error states.
- Seed the public demo, nightly reset cron.
- README with a 15-minute deploy path, architecture notes and the judgment-call rationale —
  including why the admin core is a tab workspace with a global anchor filter rather than
  a Sessionboard-style page-per-resource clone.

### M7 — Buffer & submission (Wed)
- Run the demo script end-to-end three times, on desktop and phone.
- Record a 3–5 minute walkthrough matching the organiser's video.
- Push to Forge (+ GitHub mirror), submit the form.

### Cut list, in order
If time runs short, drop in this order — every item here is explicitly optional or struck through:
embeds → dashboard builder/gallery → Review Progress dashboard → webhooks → Airtable mirror →
Files tab → dashboard→workspace deep-links → agenda-respects-anchor → Messages tab →
workspace URL deep-links → cross-field character limits → import → Month view →
personas/record settings.

**Never cut:** the confirmation email, the success page + portal redirect, conditional logic,
routing, conflict detection, calendar invites, outstanding-task tracking — and the anchor
filter working between Speakers, Submissions and Tasks (it is the demo's differentiator).

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
**At least one speaker must have 2+ submissions, tasks in mixed states and several logged
emails, so anchoring them makes every tab visibly change.**

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
6. **Admin → Workspace** — the new submission sits in the Submissions tab as `Pending`
   (status chip + live tab count), routed to the *Workshops* evaluation plan and tagged by
   the routing rule.
7. **The anchor moment** — shift-click the new speaker in the Speakers tab: Submissions
   narrows to their proposal, Tasks to their assignments, the tab counts all update.
   One gesture, the whole record. Clear it with the filter dot.
8. **Review** — open the reviewer workspace, score it, return to the Submissions tab and
   sort by rating.
9. **Accept** — check the rows, bulk-move to Accept Queue from the action bar, send decision
   emails; `Notified` flips inline.
10. **Tasks** — the acceptance auto-assigned *Presentation Upload*; anchor the speaker and
    see it in the Tasks tab; the dashboard's **Outstanding Speaker Tasks** count rises.
11. **Portal again** — complete the task by uploading a PDF; the dashboard count falls live.
12. **Agenda** — drag the accepted session from the tray onto Main Stage 10:00. Drop a second
    session on the same slot → `ROOM_DOUBLE_BOOKED` flags both; open Conflicts and resolve it.
13. **Calendar invite** — the schedule confirmation email arrives with a `.ics`; add it in Gmail;
    move the session in the admin and show the calendar entry **updating in place**.
14. **Dashboard** — Speaker Tracking: accepted speakers, top speakers by outstanding tasks,
    overdue list; send a reminder from the row.
15. **API** — `curl` the submissions endpoint and show `/docs`.
16. **Speed** — show the Lighthouse score for the public CFP page.

---

## 4. Submission checklist

- [ ] Public deployed URL, seeded, with demo credentials on the landing page
- [ ] Open-source repo (Forge, mirrored to GitHub), MIT licence
- [ ] README: what it is, screenshots/GIF, 15-minute deploy, architecture, judgment calls made
      (including the tab-workspace idiom), what is deliberately out of scope and why
- [ ] `docs/` (this set) included in the repo
- [ ] 3–5 minute walkthrough video matching the script above
- [ ] Demo-reset cron running
- [ ] Token-cost receipts kept for the $500 reimbursement claim
- [ ] Organiser's submission form completed before **Wed 12 Aug, 10:00 PM PT**
