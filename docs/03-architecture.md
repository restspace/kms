# 03 — Architecture

This is a recommendation, not a constraint from the brief: *"Choose whatever
language/tools/frameworks you want."* The recommendation optimises for the three things the
brief rewards — **Cloudflare deployment, Airtable persistence, and speed** — plus one thing it
implies: a stranger must be able to clone and deploy it.

---

## 1. Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | **Cloudflare Workers** | Bonus points; global edge; sub-50 ms cold start |
| Web framework | **Hono** (Workers-native) | Tiny, fast, first-class Workers support |
| Frontend | **React API everywhere, two build targets** — admin SPA (Vite) bundles real React; the public build aliases `preact/compat`, so the *same* components are server-rendered by Hono and hydrate as a ~13 KB island | One JSX idiom, so `/packages/ui` and the form renderer are written once; public pages ship near-zero JS; admin keeps full React ecosystem compatibility (dnd-kit, TanStack) |
| Styling | Tailwind + a small component set (shadcn-style, vendored) | Speed of build, consistent look without a heavy dependency |
| Primary DB | **Cloudflare D1** (SQLite) | Free-tier, edge-local reads, SQL keeps grids/filters/sorts fast |
| Files | **Cloudflare R2** | Headshots, slides, supporting docs, export bundles |
| Cache / sessions | **Workers KV** | Magic-link tokens, session cookies, dashboard aggregates |
| Background work | **D1 outbox table + Cron Triggers** (Queues optional, see §2a) | Email sends, reminder sweeps, Airtable sync — without leaving the free tier (Queues requires the Workers paid plan) |
| Realtime (optional) | **Durable Objects** | Live dashboard + collaborative agenda editing |
| Email | **Resend** for transactional mail; a **second provider for calendar invites** (SendGrid REST planned) | M0 spike (Aug 8) proved Resend cannot carry invites: its pipeline (REST *and* SMTP) demotes the `text/calendar` alternative part to a generic attachment and strips `method=REQUEST`, so Outlook never offers RSVP (Gmail copes; resend-node #198, closed unfixed). Provider clients already sit behind one interface. (MailChannels' free Workers integration was discontinued in 2024 — not a fallback.) |
| Auth | Magic link + signed cookie (JWT in HttpOnly cookie) | No password storage; matches the portal UX in the screenshots |

### If not Cloudflare
The same design maps onto Next.js + Postgres + S3 + a job runner. Keep the repository
interface (below) so the choice is reversible; do not let SQL leak into route handlers.

---

## 2. Persistence strategy — SQL primary, one-way Airtable mirror

The brief offers bonus points for Airtable "because those are what we use on our team", but
Airtable alone is a poor primary store for a grid product (5 req/s per base, 100 records per
page, no joins, no transactions). **D1 is always the system of record**; Airtable is a mirror.
Two modes, one interface:

```ts
interface Repository<T> {
  get(id: string, scope: Scope): Promise<T | null>
  list(query: ListQuery, scope: Scope): Promise<Page<T>>
  create(input: Partial<T>, scope: Scope): Promise<T>
  update(id: string, patch: Partial<T>, scope: Scope): Promise<T>
  delete(id: string, scope: Scope): Promise<void>
}
```

| Mode | Config | Behaviour |
|---|---|---|
| **`sql`** (default) | `AIRTABLE_SYNC=off` | D1 only. Fast, transactional. |
| **`airtable-mirror`** | `AIRTABLE_SYNC=on` + `AIRTABLE_API_KEY`/`AIRTABLE_BASE_ID` secrets | A cron-driven watermark sweep (`jobs/airtableSync.ts`) mirrors Events, Submissions, Contacts, Tasks, Reviews, Tracks, Rooms and Tags into one Airtable base within a cron tick (~1 min) — **one-way, D1 → Airtable**. Single global base: a single-tenant-deployment feature (workplan-9 §5b). |

**Cut from scope:** Airtable as primary store (`PERSISTENCE=airtable`). It doubled the adapter
work to support a mode nobody should run at the target scale (NFR-2), and the rate-limit
caveats made it a support liability. The `Repository<T>` interface stays, so the decision is
reversible post-deadline.

**Stretch, post-deadline:** pulling Airtable edits back into D1 (cron, last-write-wins on
`updated_at`). Bidirectional sync is where deletes, schema drift and conflict edge cases live;
it is deliberately off the critical path.

**Airtable base schema** (tables mirror [02](02-domain-model.md)): `Events`, `Submissions`,
`Contacts`, `Tasks`, `Reviews`, `Tracks`, `Rooms`, `Tags`. `Forms` is config, not content, and
is not mirrored; "Sessions" is not a table anywhere (a session is a scheduled submission) — the
schedule columns ride on `Submissions` and a filtered "Sessions" view is built once in the base
UI. Record IDs are stored back on the D1 row (`airtable_record_id`) to make the mirror
idempotent; hard deletes are staged into `airtable_pending_deletes` and drained by the sweep.

### 2a. Background jobs — outbox, not Queues

Asynchronous work is **outbound email** (per-event jobs off a D1 `outbox` table) and the
**Airtable mirror** (a watermark sweep in `jobs/airtableSync.ts`, *not* outbox jobs — write
sites are spread across too many files to instrument each one; see
tests/workplan-9-airtable-mirror.md §4). The outbox works like this:

1. The request handler inserts a job row (with an idempotency key, per NFR-11) and attempts it
   immediately via `ctx.waitUntil` — the happy path is near-instant.
2. A cron sweep (every minute) retries failed/stuck rows with exponential backoff and a
   dead-letter status after N attempts.

Cloudflare **Queues requires the Workers paid plan**, so it is an optional optimisation
(`USE_QUEUES=on` swaps the outbox consumer onto a Queue binding), never a dependency. The
free-tier deploy path — the one a stranger follows from the README — must work end-to-end
without it.

---

## 3. Application structure

```
/apps
  /admin        React SPA (Vite)                     → /app/*
  /public       SSR routes (Hono + React SSR)        → /submit/*, /portal/*, /e/*, /embed/*
  /api          Hono REST                            → /api/v1/*
/packages
  /core         domain services (pure TS): forms, routing, conflicts, scoring, scheduling
  /db           D1 schema, migrations, SQL repositories, outbox
  /airtable     Airtable mirror adapter (one-way, D1 → Airtable)
  /email        templates, renderer, ICS builder, provider clients
  /ui           shared React components — used by BOTH the SSR pages and the SPA
/workers
  /jobs         outbox consumer: email (waitUntil + cron retry sweep); Airtable watermark sweep
  /cron         reminder sweeps, outbox retry sweep, dashboard aggregate refresh
```

Domain logic lives in `/packages/core` with **no I/O** so the conflict engine, conditional-logic
evaluator, routing engine and scoring aggregation are unit-testable without a database.

**One JSX idiom, two build targets.** Everything is written against the React API; the weight
question is settled per bundle, because it only ever mattered on the public island:

- **Public build** — aliases `react`/`react-dom` to **`preact/compat`** in Vite. Pages are
  rendered to HTML on the Worker with `preact-render-to-string` and ship no client JS except
  the hydrated CFP form island (preact + compat ≈ 13 KB gzip vs React's ≈ 45 KB, leaving the
  60 KB budget mostly for the form logic itself). Compat risk is near-zero here: the island is
  entirely first-party code.
- **Admin build** — bundles **real React**. Its 250 KB budget absorbs React easily, and the
  hard parts of this product (virtualised grids via TanStack Table/Virtual, agenda drag-drop
  via dnd-kit) get maximum third-party compatibility. *Optional follow-up, off the critical
  path:* if an early smoke test shows dnd-kit and TanStack behave under `preact/compat`, the
  admin can be aliased too.

The payoff is unchanged: the form renderer and conditional-logic display are written once and
reused in the public wizard, the admin form-builder preview, and portal task forms. Hono's own
JSX is not used. (Svelte was rejected — full idiom change days before the deadline, thinner
grid/dnd ecosystem; Astro was rejected — it still needs an island framework, so it adds a
meta-framework overlapping Hono rather than replacing React.)

---

## 4. Request paths

| Path | Rendering | Auth | Cache |
|---|---|---|---|
| `/submit/<event-slug>/<form-id>` | SSR, hydrate only the form island | none (email captured at Account step) | HTML cached 60 s at edge, form definition in KV |
| `/portal/<event-slug>/*` | SSR shell + islands | magic-link cookie | private, no-store |
| `/app/*` | SPA | admin cookie | app shell immutable, data via API |
| `/api/v1/*` | JSON | Bearer token or session cookie | none |
| `/embed/<token>.js` and `/embed/<token>` | SSR HTML + tiny loader | public token | edge cache 5 min |

---

## 5. Authentication & authorisation

**Magic link flow**
1. User submits email on the CFP Account step or the portal login page.
2. Server mints a 32-byte token, stores `hash(token) → {contact_id, event_id}` in KV with a
   **15-minute TTL and single-use flag**, emails the link.
3. Link `GET /auth/callback?t=…` verifies, deletes the KV entry, sets a signed HttpOnly cookie
   (7-day expiry, sliding), redirects to the portal or back to the in-progress submission.

**Roles** — `owner > admin > reviewer > speaker`. Authorisation is a single `can(actor, action, resource)`
function in `/packages/core/auth.ts`; every repository call takes a `Scope {org_id, event_id, actor}`
and the SQL layer appends the scope predicate. Reviewers see only submissions assigned to them
via `ReviewAssignment`. Speakers see only records where they are the submitter or a participant.

Admin impersonation ("View Portal") issues a short-lived portal cookie carrying
`impersonated_by`, shown as a banner in the portal and reversible via "Back to Admin Mode".

---

## 6. Performance budgets

The brief explicitly rewards speed and penalises "slow SaaS".

| Surface | Budget |
|---|---|
| Public CFP page TTFB | < 200 ms p95 from edge |
| Public CFP LCP (mid-tier Android, 4G) | < 1.5 s |
| Portal home TTFB | < 250 ms p95 |
| Admin grid, 1000 rows, filter+sort | < 150 ms server, < 100 ms perceived (virtualised rows) |
| Agenda drag → visual response | < 16 ms (optimistic), conflict recheck < 100 ms |
| Public JS payload (CFP) | < 60 KB gzip |
| Admin initial JS | < 250 KB gzip, route-split thereafter |

Techniques: edge SSR, no client-side data fetching on first paint for public pages, virtualised
grids, denormalised counters (`submission_count`, `rating_cache`) rather than count queries,
KV-cached dashboard aggregates refreshed by cron and invalidated on write, HTTP caching with
stale-while-revalidate on public reads.

---

## 7. Realtime

The brief calls the dashboard **"real-time"**. Two acceptable levels:

- **Baseline (ship this):** dashboard aggregates cached in KV, invalidated on write, client
  polls `/api/v1/dashboard/summary` every 15 s with ETag support. Cheap and sufficient.
- **Stretch:** a Durable Object per event broadcasting `submission.*`, `task.*`, `session.*`
  events over WebSocket, driving both the dashboard and multi-user agenda editing.

---

## 8. Files

Uploads go direct to R2 via a short-lived presigned URL issued by the API after validating
type and size. Images (headshots) are resized on read through Cloudflare Images or a Worker
transform. The "Download files bundle" action streams a ZIP assembled in a Worker.

Limits: headshot ≤ 5 MB (jpg/png/webp); slides ≤ 50 MB (pdf/pptx/key); documents ≤ 25 MB.

---

## 9. Environment & configuration

```
APP_URL                 https://…                     public base URL
EVENT_DEFAULT_TZ        America/Los_Angeles
AIRTABLE_SYNC           off | on                      one-way D1 → Airtable mirror
AIRTABLE_API_KEY        pat…
AIRTABLE_BASE_ID        app…
USE_QUEUES              off | on                      on = paid plan, Queue-driven jobs; off = outbox + cron (free tier, default)
EMAIL_PROVIDER          resend | mailchannels
RESEND_API_KEY          re_…
EMAIL_FROM              "AI.Engineer <cfp@…>"
SESSION_SECRET          32-byte hex
R2_BUCKET               bindings in wrangler.toml
```

`wrangler.toml` declares D1, R2, KV and Cron bindings (plus a Queue only when `USE_QUEUES=on`). `npm run seed` populates the demo
event described in [12](12-build-plan.md).

---

## 10. Testing

| Level | Coverage |
|---|---|
| Unit | conditional-logic evaluator, routing engine, conflict detector, score aggregation, ICS builder, merge-variable renderer |
| Integration | form create → public submit → confirmation email queued → portal shows submission |
| E2E (Playwright) | the full demo script in [12](12-build-plan.md), run against a preview deployment |
| Load (light) | 1000-row grid filter/sort; 200 concurrent CFP page loads |

---

## 11. Deployment

- `wrangler deploy` from CI on push to `main`; preview deployments per PR.
- Migrations applied with `wrangler d1 migrations apply` in the deploy step.
- Public demo instance seeded and reset nightly by a cron trigger so judges always see a clean,
  populated product.
- Repository hosted on **Forge** (`forge.smol.ai`) with a GitHub mirror — the brief gives a small
  bonus for Forge, and a mirror keeps the repo discoverable.
- Licence: MIT. README must get a stranger deployed in < 15 minutes.
