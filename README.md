# KMS — speaker and program management for conferences

An open-source replacement for [Sessionboard](https://www.sessionboard.com/): organisers publish a
call for speakers, collect and score submissions, accept speakers into a self-service portal that
chases them for bios, headshots and slides, build a conflict-free agenda by drag and drop, and
watch the outstanding onboarding tasks on a live dashboard. It runs on Cloudflare Workers with D1
as the system of record.

## What's built

Milestones M0–M6 of [docs/12-build-plan.md](docs/12-build-plan.md) are complete; the full
specification is in [docs/](docs/README.md).

- **Public CFP** — multi-step submission wizard from a form builder: conditional questions,
  participant sections, submission limits, close dates, routing rules that assign track, tags and
  an evaluation plan on arrival, a customised success page, and a confirmation email.
- **Speaker portal** — magic-link login; speakers edit their profile, upload a headshot, complete
  assigned tasks (file uploads, forms, acknowledgements) and see their submissions.
- **Admin workspace** — a tab workspace (Speakers · Submissions · Tasks · Messages) over one
  generic query engine. Shift-click any row to **anchor** it: every other tab narrows to that
  record's slice and the tab counts update. Inline status edits, bulk accept/decline queues,
  decision emails, checklists, exports.
- **Review & scoring** — evaluation plans with weighted criteria, reviewer assignment
  (all / round-robin), a reviewer-only workspace, live rating aggregation into the grid.
- **Agenda** — drag-and-drop scheduling across rooms and days, a conflict engine
  (double-bookings, overlaps) with an ignore list, calendar invites (`.ics` METHOD:REQUEST with
  in-place updates and cancellations), and undo.
- **Dashboards** — Today, Speaker Tracking and Submissions Pipeline boards on one ETag-polled
  payload; overdue-task reminders (idempotent per day); every stat deep-links into the workspace
  pre-filtered.
- **REST API** — `/api/v1` with org-scoped bearer tokens, OpenAPI 3.1 at
  `/api/v1/openapi.json`, rendered docs at `/docs`, CSV/XLSX exports that honour the same
  filters the admin grid uses. Tokens are managed under Settings.
- **Operations** — outbox-based email delivery with retries, reminder sweeps, a nightly
  demo-data reset, and a one-click reset button.

## Run it locally

No Cloudflare account and no login are needed — `wrangler dev` runs D1 and KV locally in miniflare.

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .dev.vars   # signs the auth cookie
echo "DEV_MODE=on" >> .dev.vars                              # show magic links in the browser
npm run migrate:local      # apply packages/db/migrations to the local D1
npm run seed:local         # load the demo event from packages/db/seed/seed.sql
npm run dev                # builds both frontends, then wrangler dev
```

Then open http://localhost:8787 — it redirects to the admin login. With `DEV_MODE=on` the magic
link is shown directly on the page after you enter an email, so no email provider is needed:

- **Admin**: sign in as `james@atelyr.com` (seeded owner) → the admin shell at `/app`
- **Speaker**: sign in as `ada@example.com` at `/portal/ai-engineer-sandbox-event`
- **Public CFP**: `/submit/ai-engineer-sandbox-event/frm00000-0000-4000-8000-000000000001`
- `/docs` — API reference; `/health` — liveness check

Order matters: migrate before seed, and seed before dev, or pages render with no event.
`npm run dev` builds both frontends first, so re-run it after changing anything under
`apps/public/src`, `apps/admin/src` or `packages/ui`. `npm run typecheck` covers the workspaces.

## Try the API

Create a token in the admin app under **Settings → API tokens**, then:

```bash
curl -H "Authorization: Bearer kms_…" "http://localhost:8787/api/v1/events"
curl -H "Authorization: Bearer kms_…" \
  "http://localhost:8787/api/v1/events/EVENT_ID/submissions?status=pending&sort=-created_at"
curl -H "Authorization: Bearer kms_…" -o pending.xlsx \
  "http://localhost:8787/api/v1/events/EVENT_ID/submissions/export?format=xlsx&status=pending"
```

The list endpoints, their filter vocabulary and the exports are generated from the same resource
registry the admin SPA queries — the OpenAPI document at `/api/v1/openapi.json` is derived from
it too, so the docs cannot drift from the implementation.

## Deploy it — the 15-minute path

Requires a Cloudflare account (the free plan is enough — Queues is deliberately not used).

```bash
npx wrangler login
npx wrangler d1 create kms          # 1. create the database
npx wrangler kv namespace create KV # 2. create the KV namespace
```

Both commands print an id — paste them over the ids in `wrangler.toml`, and set `APP_URL` under
`[vars]` to your `https://<worker>.<account>.workers.dev` URL (or custom domain). Then:

```bash
npx wrangler secret put SESSION_SECRET   # 3. 32-byte hex (openssl rand -hex 32)
npx wrangler secret put RESEND_API_KEY   # 4. sending-only key from resend.com
npx wrangler secret put EMAIL_FROM       #    e.g. "AI.Engineer <cfp@yourdomain>"
npm run migrate:remote                   # 5. schema
npm run seed:remote                     # 6. demo event (skip for a blank install)
npm run deploy                          # 7. build both frontends, wrangler deploy
```

For a **real installation** (not a public demo) set `DEMO_RESET = "off"` in `wrangler.toml` —
with it on, the Settings page offers a destructive "reset demo data" button and the nightly
09:00 UTC cron replays the seed. `DEV_MODE` must stay `off` in production (with it on, login
links are shown in the browser instead of emailed).

## Accounts you need

None of these are needed for local development.

| Service | Cost | Needed for |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Free plan sufficient | Deployment only — Workers, D1, KV, Cron |
| [Resend](https://resend.com) + a sending domain | Free tier, domain extra | Outbound email (magic links, confirmations) — deployed only |
| A calendar-safe email provider (SendGrid) | Free tier | `.ics` calendar invites — Resend strips calendar MIME (see docs/12 M0 spike result) |
| [Airtable](https://airtable.com) PAT + base | Free tier | Optional: the one-way D1 → Airtable mirror (bonus feature, off by default) |
| [Forge](https://forge.smol.ai/) or GitHub | Free | Hosting the repository |

## Configuration

Non-secret values live in `[vars]` in `wrangler.toml`. Secrets go in `.dev.vars` locally (already
gitignored) and `npx wrangler secret put NAME` in production. From
[docs/03 §9](docs/03-architecture.md):

| Variable | Where | Notes |
|---|---|---|
| `APP_URL` | var | Public base URL; `http://localhost:8787` locally |
| `EVENT_DEFAULT_TZ` | var | Default event timezone, e.g. `America/Los_Angeles` |
| `DEV_MODE` | var | `on` shows magic links in the browser; **must be `off` in production** |
| `DEMO_RESET` | var | `on` enables the Settings reset button + nightly seed replay — demo deployments only |
| `AIRTABLE_SYNC` | var | `off` (default) or `on` — one-way D1 → Airtable mirror |
| `USE_QUEUES` | var | `off` (default, outbox + cron) or `on` (paid plan) |
| `EMAIL_PROVIDER` | var | `resend` |
| `RESEND_API_KEY` | secret | `re_…` |
| `SENDGRID_API_KEY` | secret | calendar-invite sends (optional; falls back to Resend) |
| `EMAIL_FROM` | secret | e.g. `"AI.Engineer <cfp@example.com>"` |
| `SESSION_SECRET` | secret | 32-byte hex, signs the auth cookie |

## Architecture

Full rationale in [docs/03-architecture.md](docs/03-architecture.md).

- **Cloudflare Workers + Hono.** Edge SSR for the public CFP and portal pages, the admin SPA as
  static assets behind a session gate, and the REST API under `/api/v1`.
- **D1 is the system of record.** Airtable alone cannot back a grid product (5 req/s per base, no
  joins, no transactions), so it is at most a one-way mirror fed from D1.
- **D1 `outbox` table + Cron Triggers instead of Queues.** Emails are attempted inline via
  `ctx.waitUntil` and retried by a per-minute cron sweep with backoff and a dead-letter status.
  Queues requires the Workers paid plan, so it stays an optional optimisation (`USE_QUEUES=on`).
- **One React JSX idiom, two build targets.** The public build aliases `react`/`react-dom` to
  `preact/compat` (the hydrated island measures ~8 KB gzip against a 60 KB budget); the admin
  build bundles real React. The Worker's SSR bundle uses the same alias via `wrangler.toml [alias]`.
- **Magic-link auth.** A single-use token hashed into KV with a 15-minute TTL, exchanged for a
  signed HttpOnly cookie (HMAC-SHA256, WebCrypto, no dependencies). No passwords. Roles
  `owner > admin > reviewer > speaker` enforced by `can()` in `packages/core`.
- **Files in KV behind a storage seam.** Headshots and slide uploads live as KV values (25 MB cap,
  far above the per-file limits) with metadata in D1; `filestore.ts` is the seam an R2
  implementation swaps into without touching callers.

## Judgment calls

The decisions a reviewer will most likely ask about, with the reasoning:

- **A tab workspace with a global anchor filter, not a page-per-resource clone.** Sessionboard
  gives each resource its own page, so "everything about this speaker" is four navigations.
  Here the workspace holds Speakers, Submissions, Tasks and Messages as tabs over one query
  engine, and shift-clicking any row anchors it: one gesture narrows every other tab to that
  record's slice, with live counts. Cross-record questions ("what did we send the speaker whose
  task is overdue?") become one click instead of a navigation chain. It also collapses the
  build: one virtualised grid, one filter registry, one detail-panel idiom serve four resources.
- **One resource registry drives three surfaces.** The SPA's query endpoint, the REST API and
  the OpenAPI document are all generated from the same filter/sort registry
  (`apps/api/src/routes/adminApi.ts`). The API documentation cannot describe behaviour the grid
  does not have, and a filter added for a dashboard deep-link becomes an API capability for free.
- **Bearer tokens are org-scoped with the event in the path.** No session-held "current event"
  state in the API: every request names its scope, which is friendlier to agents and to
  server-to-server callers alike. Only a SHA-256 hash of a token is stored.
- **Dashboards recompute per read behind an ETag, not a cache.** The payload hash (clock
  excluded) becomes the ETag; idle 15-second polls cost a 304 and a handful of indexed queries
  over demo-scale data, and the exit criterion — a speaker completing a portal task moves the
  admin dashboard within one poll — needs no invalidation logic at all.
- **Conflict counts run through the agenda's own engine**, honouring its ignore list, so the
  dashboard and the agenda screen can never disagree.
- **XLSX is hand-rolled minimal OOXML** (five XML files zipped with `fflate`) rather than a
  spreadsheet library: SheetJS is megabytes against a Workers bundle; a filtered D1 result set
  needs inline strings and numbers, nothing more.
- **Decision emails never leave via the API.** The status endpoint moves pipeline state only;
  batch notification stays an explicit admin action, so an automated status change can never
  email a speaker by surprise.

## Deliberately out of scope

Dashboard builder/custom widgets, embeds, webhooks and the Airtable mirror (both specced in
[docs/10](docs/10-api.md), cut for time), import, month-view agenda, and per-user record
permissions. The cut list with ordering is in [docs/12 §1](docs/12-build-plan.md).

## Repo layout

```
apps/
  api/           the deployed Worker: Hono routes for /auth, /portal, /app,
                 /submit, /api/v1, /docs; scheduled outbox + reminder + demo-reset sweeps
  public/        public client build (Vite → preact/compat island)
  admin/         React SPA (Vite) → /app: workspace, forms, evaluation, agenda,
                 dashboards, settings
packages/
  core/          pure-TS domain: types, roles, can(), conflict engine
  db/            D1 schema, migrations, repositories, outbox, seed
  ui/            shared components, SSR + SPA
  email/         provider seam (Resend + SendGrid + dev console), ICS builder
docs/            the specification set
spikes/          M0 calendar-invite spike scripts + findings
wrangler.toml    D1 "DB", KV "KV", assets "ASSETS", crons
```

## Licence

MIT — see [LICENSE](LICENSE).
