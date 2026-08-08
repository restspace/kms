# Speaker & Program Management Platform — Specification

An open-source replacement for [Sessionboard](https://www.sessionboard.com/), specified from
`Brief.md` (the AI.Engineer hackathon brief plus 40 annotated screenshots of the incumbent product).

**One-line scope:** organisers publish a call for speakers, review and score submissions, accept
speakers into a self-service portal that chases them for bios / headshots / slides, build a
conflict-free agenda by drag and drop, and watch it all on a live dashboard.

**Deadline:** Wednesday 12 August, 10:00 PM PT. **Prize:** $10,000 + a latent.space writeup.

---

## Read in this order

| Doc | What it answers |
|---|---|
| [00-overview.md](00-overview.md) | What are we building, what is explicitly out of scope, who is it for |
| [01-requirements.md](01-requirements.md) | Every requirement, numbered and prioritised (MoSCoW) |
| [02-domain-model.md](02-domain-model.md) | Entities, fields, status enums, invariants |
| [03-architecture.md](03-architecture.md) | Stack, persistence, auth, performance budgets, deployment |
| [04-cfp-and-forms.md](04-cfp-and-forms.md) | Form builder, conditional logic, routing, public submission flow |
| [05-speaker-portal.md](05-speaker-portal.md) | Portal home, profile, tasks, portal forms, file requests |
| [06-review-and-scoring.md](06-review-and-scoring.md) | Abstracts grid, statuses, evaluation plans, scoring, decisions |
| [07-agenda-and-scheduling.md](07-agenda-and-scheduling.md) | Drag-and-drop scheduling and the conflict engine |
| [08-communications.md](08-communications.md) | Email templates, reminders, and calendar invites |
| [09-dashboard-and-reporting.md](09-dashboard-and-reporting.md) | Dashboards, exports, optional embeds |
| [10-api.md](10-api.md) | Public REST API and webhooks |
| [11-ui-and-navigation.md](11-ui-and-navigation.md) | Information architecture, screens, design direction |
| [12-build-plan.md](12-build-plan.md) | Milestones, seed data, the demo script that must be flawless |
| [13-open-questions.md](13-open-questions.md) | Assumptions taken, questions for the organisers, risks |
| [14-e2e-browser-test.md](14-e2e-browser-test.md) | End-to-end browser test plan, staged per milestone, run with browser-pilot |

---

## The six core features (from the brief)

1. **Custom CFP forms** with conditional logic and category-based routing → [04](04-cfp-and-forms.md)
2. **Self-service speaker portal** for bios, headshots, slides, documents → [05](05-speaker-portal.md)
3. **Automated templated communications** incl. calendar invites to Gmail / Outlook / iCal → [08](08-communications.md)
4. **Submission evaluation and scoring workflows** → [06](06-review-and-scoring.md)
5. **Drag-and-drop agenda** with conflict detection; list / day / week / track / room views → [07](07-agenda-and-scheduling.md)
6. **Real-time dashboard** of speakers with outstanding onboarding tasks → [09](09-dashboard-and-reporting.md)

Struck through in the brief and therefore **not built**: AI-assisted review, Accelevents
integration, portal wiki/resources, embeddable gallery (kept as a stretch). Marked
"NOT NEEDED" on the screenshots and therefore **not built**: payments, fees, promo codes, invoicing.

---

## Extracted assets

The 40 screenshots embedded as base64 in `Brief.md` were extracted for analysis to:
`%LOCALAPPDATA%\Temp\claude\C--info-kms\<session>\scratchpad\img\image1..40.png`

Screenshot → topic index:

| Images | Subject |
|---|---|
| 1 | Sessionboard marketing site / product taxonomy |
| 2–4 | Event settings: overview, event details, exhibitors & images |
| 5–15 | Submission-form list and the seven-step form builder (12 = payments "NOT NEEDED", 13 = close date "kinda impt", 14 = success page "make sure this works", 15 = notifications "must have") |
| 16 | Public CFP page (5-step wizard) |
| 17–18 | Speaker portal: home, profile ("update your own bio data") |
| 19–23 | Abstracts grid, status picker, column preferences, import/export, Add Abstract |
| 24 | Agenda with List / Day / Week / Month / Rooms / Conflicts |
| 25–31 | Portal tasks, portal forms, form builder, file requests |
| 32–33 | CMS → Embeds (marked OPTIONAL) |
| 34–40 | Dashboards: Today, forms, participants, evaluations, speaker tracking, submissions pipeline, dashboard gallery |
