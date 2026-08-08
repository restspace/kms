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
| Frontend | **React + Vite SPA** for admin; **server-rendered HTML** for public CFP, portal login and embeds | Public pages must be fast on mobile; admin can be an app-shell |
| Styling | Tailwind + a small component set (shadcn-style, vendored) | Speed of build, consistent look without a heavy dependency |
| Primary DB | **Cloudflare D1** (SQLite) | Free-tier, edge-local reads, SQL keeps grids/filters/sorts fast |
| Files | **Cloudflare R2** | Headshots, slides, supporting docs, export bundles |
| Cache / sessions | **Workers KV** | Magic-link tokens, session cookies, dashboard aggregates |
| Background work | **Cloudflare Queues** + **Cron Triggers** | Email sends, reminder sweeps, Airtable sync |
| Realtime (optional) | **Durable Objects** | Live dashboard + collaborative agenda editing |
| Email | **Resend** (or MailChannels via Workers) | Simple API, good deliverability, attachments for `.ics` |
| Auth | Magic link + signed cookie (JWT in HttpOnly cookie) | No password storage; matches the portal UX in the screenshots |

### If not Cloudflare
The same design maps onto Next.js + Postgres + S3 + a job runner. Keep the repository
interface (below) so the choice is reversible; do not let SQL leak into route handlers.

---

## 2. Persistence strategy — SQL primary, Airtable adapter

The brief offers bonus points for Airtable "because those are what we use on our team", but
Airtable alone is a poor primary store for a grid product (5 req/s per base, 100 records per
page, no joins, no transactions). Two modes, one interface:

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
| **`sql`** (default) | `PERSISTENCE=d1` | D1 is the system of record. Fast, transactional. |
| **`airtable-mirror`** (recommended for the demo) | `PERSISTENCE=d1 AIRTABLE_SYNC=on` | D1 is the system of record; a queue-backed worker mirrors Submissions, Contacts, Sessions and Tasks into Airtable within seconds, and a cron pulls Airtable edits back (last-write-wins on `updated_at`). Gives the AIE team the Airtable view they actually want without the latency penalty. |
| **`airtable`** | `PERSISTENCE=airtable` | Airtable is the system of record. Supported for small events; documented rate-limit caveats. |

**Airtable base schema** (tables mirror [02](02-domain-model.md)): `Events`, `Forms`,
`Submissions`, `Contacts`, `Sessions`, `Tasks`, `Reviews`, `Tracks`, `Rooms`, `Tags`.
Record IDs are stored back on the D1 row (`airtable_record_id`) to make the mirror idempotent.

---

## 3. Application structure

```
/apps
  /admin        React SPA (Vite)         → /app/*
  /public       SSR routes (Hono + JSX)  → /submit/*, /portal/*, /e/*, /embed/*
  /api          Hono REST                → /api/v1/*
/packages
  /core         domain services (pure TS): forms, routing, conflicts, scoring, scheduling
  /db           D1 schema, migrations, SQL repositories
  /airtable     Airtable adapter + sync worker
  /email        templates, renderer, ICS builder, provider clients
  /ui           shared components
/workers
  /queue-consumer   email + sync jobs
  /cron             reminder sweeps, dashboard aggregate refresh
```

Domain logic lives in `/packages/core` with **no I/O** so the conflict engine, conditional-logic
evaluator, routing engine and scoring aggregation are unit-testable without a database.

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
PERSISTENCE             d1 | airtable
AIRTABLE_SYNC           off | on
AIRTABLE_API_KEY        pat…
AIRTABLE_BASE_ID        app…
EMAIL_PROVIDER          resend | mailchannels
RESEND_API_KEY          re_…
EMAIL_FROM              "AI.Engineer <cfp@…>"
SESSION_SECRET          32-byte hex
R2_BUCKET               bindings in wrangler.toml
```

`wrangler.toml` declares D1, R2, KV, Queue and Cron bindings. `npm run seed` populates the demo
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
