# 13 — Assumptions & Open Questions

The brief froze requirements after the Sunday clarification video, so the working rule is:
**do not block on answers.** Each item below records the assumption taken so the build can
proceed, and flags what would change if the answer differs.

---

## 1. Assumptions taken

| # | Area | Assumption | If wrong |
|---|---|---|---|
| A1 | Multi-event | The product is multi-tenant (org → many events) even though the demo shows one event. | Trivial to hide; the schema already supports it, and this is no longer purely theoretical: migration `0015` moved `Contact` to org-scoped identity (`docs/02` §2) precisely so it is exercised — a speaker record is now one row across every event in the org, not one per event. |
| A2 | Sessions vs abstracts | Abstracts and Sessions are two views over **one** submission pipeline; a session is a submission with a time and room. | If they are genuinely separate records with a promotion step, add a `Session` table and a convert action. Localised to [02](02-domain-model.md). |
| A3 | Payments | No payments, fees, promo codes or invoicing anywhere — the screenshot says "NOT NEEDED". | Would be a new module; not started. |
| A4 | Exhibitors & sponsors | Out of scope. The event-settings toggle exists in the reference but no requirement references it. | Group entities would need adding; portal work is the same shape as speakers. |
| A5 | AI review | Out of scope (struck through in the brief). | The evaluation schema already supports a machine "reviewer", so adding an LLM scorer is additive. |
| A6 | Accelevents | Out of scope (struck through). The API + webhooks make a one-way push feasible later. | New integration module. |
| A7 | Resources / wiki | Out of scope (struck through). | Portal would need a content module. |
| A8 | Embeds | Optional; built only after the core lands. | Already specced in [09 §9](09-dashboard-and-reporting.md). |
| A9 | Dashboard builder | The four named dashboards ship as fixed layouts; the generic widget gallery and the "AI prompt" dashboard creator do not. | Widget schema is in [02](02-domain-model.md) if it is later needed. |
| A10 | Auth | Passwordless magic link only, for speakers and admins alike. No SSO. | SSO/OAuth would be additive; sessions already cookie-based. |
| A11 | Calendar delivery | Standards-based `.ics` (`METHOD:REQUEST`) plus Google/Outlook add links, not OAuth calendar-API writes. This satisfies "delivered directly to each speaker's own calendar" without asking speakers to grant calendar scopes. | If they want true API writes, add Google Calendar + Microsoft Graph OAuth; the ICS work is still needed as the fallback. |
| A12 | Timezone | One timezone per event; all display in event-local time with the abbreviation shown. | Per-speaker timezone display would be a rendering change only. |
| A13 | Persistence | D1 is the system of record with an optional Airtable mirror, rather than Airtable-primary. Chosen because Airtable's rate limits conflict with the speed bonus. | `PERSISTENCE=airtable` mode exists; document its limits. |
| A14 | Submission limit | Event default of 3 per user per form, including drafts, matching the reference screenshot. | Configurable already. |
| A15 | Page-heading cap | The 15-character cap on Page Heading is a real product constraint, reproduced. | Trivial to relax. |
| A16 | Status model | The two "queue" states (Accept Queue / Decline Queue) exist to batch decision emails. | If they mean something else operationally, the enum is the only change. |
| A17 | Conflicts | Room double-booking and speaker double-booking are hard errors; track overlap and capacity are warnings. | Severity is configuration, not code. |
| A18 | Real-time | 15-second ETag polling counts as "real-time" for the dashboard; WebSockets are a stretch. | Durable Object path is designed but not required. |
| A19 | Licence | MIT. | Any OSI licence works; the brief only requires open source. |
| A20 | Hosting | Cloudflare Workers + D1 + R2 + KV + Queues, deployed publicly with seeded demo data and a nightly reset. | Portable to Node/Postgres via the repository interface. |

---

## 2. Questions for the organisers

Ask in Discord; none of these block the build.

**Product**
1. Do you want **one CFP form per track** (multiple public URLs) or a single form with track
   routing? The spec assumes a single form with routing, which is what "category-based routing"
   implies — but the reference shows several forms per event.
2. Should accepted speakers be able to **edit their submission after acceptance**, or does the
   record lock? The spec locks it and asks admins to make changes, with editing still allowed
   while the form is open.
3. How do you want **co-speakers** handled — does every co-speaker get their own portal account
   and task list, or only the primary contact? The spec gives every participant an account.
4. Is a **speaker confirmation step** wanted after acceptance ("yes, I'll be there")? The Speaker
   Confirmation Mix widget implies one; the spec models it as an acknowledge task.
   - Add one, make it optional

**Communications**
5. Which **sending domain** should the demo use? Deliverability from a fresh domain is the main
   risk to the "confirmation email arrives" demo step.
6. Do you want calendar invites to include a **video link / room details** field?
7. Should decision emails be **sendable per submission** as well as in bulk? The spec supports both.
   - both

**Data**
8. If Airtable persistence matters for judging, should we mirror into **your existing base
   schema**? If so, a copy of the base structure would let the adapter match it exactly.
9. Is there a **prior event's data** we can import for the submission-pacing comparison chart?

**Scope**
10. The screenshots mark the dashboard "optional / best efforts", but requirement #6 lists a
    real-time outstanding-tasks dashboard as a primary feature. The spec treats the
    **Speaker Tracking** view as required and the rest as optional — please confirm.
    - Let's include this
11. Is the **embeddable agenda/speaker gallery** (item #9, struck through) genuinely dead, or
    would a simple version be valued? The spec keeps it as a stretch.

---

## 3. Known risks

| Risk | Mitigation |
|---|---|
| Email deliverability on a fresh domain breaks the headline demo step | Use a warmed provider (Resend) with a verified domain; show the message log in the UI as evidence; include an in-app "view the email" preview so a judge can see it even if delivery is slow |
| Calendar invite rendering differs across Gmail / Outlook / Apple | Test all three explicitly during M2; keep the Add-to-Google and Add-to-Outlook links as belt and braces |
| Drag-and-drop scheduling eats a disproportionate amount of build time | Timebox to M4; the keyboard "Move session" dialog is the functional fallback and ships first |
| Grid feature creep (saved views, column config, filters) | Build one grid component; anything beyond filter/sort/columns is cut-listed |
| Airtable rate limits make the demo feel slow if used as primary | Ship with D1 primary and the mirror on; document the trade-off in the README as a deliberate judgment call |
| Scope temptation: CRM, marketing, invoices, studio all exist in the reference | The scope table in [00](00-overview.md) is the contract; anything not in it needs a written reason |
