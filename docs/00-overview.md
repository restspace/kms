# 00 — Product Overview & Scope

> Source of truth: `Brief.md` (High Level Brief + 40 annotated Sessionboard screenshots).
> This document set specifies **an open-source replacement for [Sessionboard](https://www.sessionboard.com/)**
> for the AI Engineer (AIE) team, who currently pay >$40k/year for it.

---

## 1. Context

- Hackathon brief issued by swyx / AI.Engineer. Prize: **$10,000 cash** + a latent.space
  walkthrough/interview for the winning submission.
- The winner is chosen by **independent AIE-team evaluation**, with a tiebreaker for
  *"whoever has made subjective judgment calls for the product that we would actually use/buy."*
- **Design cloning is explicitly NOT required.** The goal is a *good-enough open-source
  alternative* they never have to pay for. Judgment, polish and speed matter more than pixel parity.
- The reference event used throughout the screenshots: **"AI.Engineer Sandbox Event – NYC"**,
  slug `ai-engineer-sandbox-event`, Oct 12–14 2026, timezone America/Los_Angeles.

### Deliverables required by the brief

| # | Deliverable | Notes |
|---|---|---|
| 1 | Submission form (sent out by organisers) | Non-engineering |
| 2 | **Open-source repo** | You keep the code regardless of outcome |
| 3 | **Deployed site** the judges can test against the walkthrough | Must be publicly reachable and seeded with demo data |

### Timeline

- Target: one weekend. **Hard deadline: Wednesday Aug 12, 10:00 PM PT.**
- Requirements were frozen after the Sunday-morning clarification video — the feature set in
  these docs is the frozen set.
- Token-cost reimbursement up to $500 available for valid submissions.

---

## 2. Product in one sentence

**A multi-tenant event program-management SaaS**: organisers publish a call for speakers,
collect and review submissions, accept speakers into a self-service portal that chases them
for bios / headshots / slides, build a conflict-free agenda by drag and drop, and watch it all
on a live dashboard.

---

## 3. Feature scope

Struck-through items in the brief are **out of scope**; they are listed so that scope creep is
a deliberate decision rather than an accident.

| # | Feature | Status | Spec |
|---|---|---|---|
| 1 | Custom call-for-speakers submission forms with conditional logic and category-based routing | **IN — core** | [04](04-cfp-and-forms.md) |
| 2 | Self-service speaker portal (bios, headshots, slides, supporting documents) | **IN — core** | [05](05-speaker-portal.md) |
| 3 | Automated, templated speaker communications: reminders + calendar invites delivered to the speaker's own calendar (Gmail, Outlook, iCal) | **IN — core** | [08](08-communications.md) |
| 4 | Submission evaluation and scoring workflows | **IN — core** | [06](06-review-and-scoring.md) |
| 4b | ~~optional AI-assisted review across multiple rounds~~ | **OUT** (struck in brief) | — |
| 5 | Drag-and-drop schedule/agenda building with automatic conflict detection across rooms and tracks; list, day, week, track, room views | **IN — core** | [07](07-agenda-and-scheduling.md) |
| 6 | Real-time dashboard of speakers with outstanding onboarding tasks | **IN — core** | [09](09-dashboard-and-reporting.md) |
| 7 | ~~Native one-way Accelevents integration~~ | **OUT** (struck) | — |
| 8 | ~~Resource/wiki pages in the portal with HTML embed support~~ | **OUT** (struck) | — |
| 9 | ~~Embeddable mobile-friendly speaker gallery / schedule itinerary~~ | **OUT** (struck), but a minimal embed exists as a stretch | [09](09-dashboard-and-reporting.md) |

### Screenshot-derived scope signals

Annotations written directly on the screenshots by the organiser:

| Screen | Annotation | Meaning |
|---|---|---|
| Form builder → Payments & Fees | **"NOT NEEDED"** | Do **not** build payments, gateways, promo codes or invoicing |
| Form settings → Close Date | **"kinda impt"** | Submission-deadline handling is required |
| Form settings → success page | **"make sure this works"** | Post-submit confirmation + auto-redirect into the portal is a judged path |
| Notifications → submitter notifications | **"must have"** | Submission-confirmation email to the submitter is mandatory |
| Notifications → admin alert recipients | **"nice to have"** | Admin-alert routing is optional |
| Portal → Profile | **"update your own bio data"** | Speakers must be able to self-edit their profile |
| CMS → Embeds | **"(OPTIONAL)"** | Build only if core is complete |
| Dashboard | **"optional but nice to have, best efforts"** | Ship a simple version; do not gold-plate |

Also out of scope on the same evidence: **Invoices**, **payments / fees / promo codes**,
**Marketing**, **Studio**, **CRM beyond speaker contacts**, **exhibitor & sponsor portals**
(the Sessionboard settings toggle exists but no requirement references it), and
**Cvent / Swoogo / Zoom integrations**.

---

## 4. Judging-driven priorities

Because the tiebreaker is *"a product we'd actually use/buy"*, build order is:

1. **The end-to-end demo path must be flawless.** Public CFP → submit → confirmation email →
   speaker-portal login → accept in admin → task assigned → speaker completes task → session
   scheduled on the agenda → calendar invite lands in the speaker's calendar.
2. **Speed.** The brief says *"we do not want slow SaaS pls"* — see performance budgets in
   [03-architecture.md](03-architecture.md).
3. **Bonus points**, in the brief's own order of value:
   - Deploy on **Cloudflare** infra (mild bonus)
   - Persistence via **Airtable** (bonus — it is what the AIE team actually uses)
   - **Speed / performance** (bonus)
   - A public **API** modelled on the [Sessionboard API](https://sessionboard.mintlify.app/introduction) (bonus)
   - Host source and site on [Forge](https://forge.smol.ai/) rather than GitHub (very small bonus)

---

## 5. Personas

| Persona | Description | Primary surfaces |
|---|---|---|
| **Organiser / Admin** | AIE staff running the event. Creates the event, builds CFP forms, reviews submissions, schedules the agenda, chases speakers. | Admin app (all modules) |
| **Reviewer** | Invited to score submissions within an evaluation plan. Sees only assigned submissions. | Admin app → Evaluation |
| **Speaker / Submitter** | Submits a proposal; after acceptance maintains profile, uploads slides, completes tasks. | Public CFP + speaker portal |
| **Public visitor** | Reads the CFP page; later views the published agenda / speaker list. | Public pages, embeds |

---

## 6. Document map

| File | Contents |
|---|---|
| [00-overview.md](00-overview.md) | This file — context, scope, priorities, personas |
| [01-requirements.md](01-requirements.md) | Numbered functional + non-functional requirements, MoSCoW |
| [02-domain-model.md](02-domain-model.md) | Entities, relationships, field catalogue, status enums |
| [03-architecture.md](03-architecture.md) | Stack, deployment, storage, auth, performance budgets |
| [04-cfp-and-forms.md](04-cfp-and-forms.md) | Form builder, conditional logic, routing, public submission flow |
| [05-speaker-portal.md](05-speaker-portal.md) | Portal home, submissions, profile, tasks, portal forms, file requests |
| [06-review-and-scoring.md](06-review-and-scoring.md) | Abstracts grid, statuses, evaluation plans, scoring, bulk actions |
| [07-agenda-and-scheduling.md](07-agenda-and-scheduling.md) | Drag-drop scheduling, rooms/tracks, conflict engine, views |
| [08-communications.md](08-communications.md) | Email templates/themes, triggers, reminders, calendar invites |
| [09-dashboard-and-reporting.md](09-dashboard-and-reporting.md) | Dashboards, widgets, exports, optional embeds |
| [10-api.md](10-api.md) | Public REST API + webhooks |
| [11-ui-and-navigation.md](11-ui-and-navigation.md) | Information architecture, screens, components, design direction |
| [12-build-plan.md](12-build-plan.md) | Milestones against the Aug 12 deadline, demo script, seed data |
| [13-open-questions.md](13-open-questions.md) | Assumptions taken and questions for the organisers |
| [14-e2e-browser-test.md](14-e2e-browser-test.md) | Staged end-to-end browser test plan (browser-pilot), one section per milestone |
