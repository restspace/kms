# KMS — speaker and program management for conferences

An open-source replacement for [Sessionboard](https://www.sessionboard.com/): organisers publish a
call for speakers, collect and score submissions, accept speakers into a self-service portal that
chases them for bios, headshots and slides, build a conflict-free agenda by drag and drop, watch
the outstanding onboarding tasks on a live dashboard, and run the day itself from a phone. It
runs on Cloudflare Workers with D1 as the system of record.

## What's built

Milestones M0–M6 of [docs/12-build-plan.md](docs/12-build-plan.md) are complete, plus the
workplans in [tests/](tests/) that followed them (the numbered `workplan-*.md` files record the
scope and reasoning for each). The full specification is in [docs/](docs/README.md), and the
plain-language user manual — also served in-app under **Help** — is in [docs/manual/](docs/manual/README.md).

- **Public CFP** — multi-step submission wizard from a form builder: conditional questions,
  participant sections, submission limits, close dates, routing rules that assign track, tags and
  an evaluation plan on arrival, a customised success page, and a confirmation email.
- **Speaker portal** — sign in by magic link or password; speakers edit their profile, upload a
  headshot, complete assigned tasks (file uploads, forms, acknowledgements) and see their
  submissions.
- **Admin workspace** — a tab workspace (Speakers · Submissions · Tasks · Reviews · Comments ·
  Messages · Files · Events) over one generic query engine. Shift-click any row to **anchor** it:
  every other tab narrows to that record's slice and the tab counts update. Inline status edits,
  bulk accept/decline queues, decision emails, checklists, comment threads, exports.
- **Review & scoring** — evaluation plans with weighted criteria, reviewer assignment
  (all / round-robin) with per-reviewer caps, a reviewer-only workspace, live rating aggregation
  into the grid.
- **Agenda** — drag-and-drop scheduling across rooms and days, a conflict engine
  (double-bookings, overlaps) with an ignore list, pencilled-in slots, calendar invites (`.ics`
  METHOD:REQUEST with in-place updates and cancellations), and undo.
- **Green Room** — the phone-shaped day-of screen: who is on now and next in each room, speaker
  check-in, readiness flags (slides in, bio done) and tap-to-call contact actions.
- **Pipeline** — an org-wide prospecting board (prospect → invited → awaiting reply → confirmed →
  declined) with notes, history, and enrolling a card's speaker into an event.
- **Dashboards** — Today, Speaker Tracking and Submissions Pipeline boards plus an all-events
  view, on one ETag-polled payload; overdue-task reminders (idempotent per day); every stat
  deep-links into the workspace pre-filtered.
- **Embeds** — sessions, speakers, agenda grid, schedule and speaker-gallery widgets for an
  outside website, as a styled `<script>` embed, an iframe or a raw feed (including
  `/e/:slug/agenda.xml`), with named configurations saved for reuse.
- **REST API** — `/api/v1` with org-scoped bearer tokens, OpenAPI 3.1 at
  `/api/v1/openapi.json`, rendered docs at `/docs`, CSV/XLSX exports that honour the same
  filters the admin grid uses. Tokens are managed under Settings.
- **Import** — spreadsheet import with a named Sessionboard mode, undo in one click, and
  everything unmapped preserved on the record.
- **Airtable mirror** — optional one-way D1 → Airtable copy, off by default, set up entirely from
  **Settings → Airtable mirror**: paste a token, pick the base, and the app creates the tables it
  needs. Sixteen tables: events, contacts and their per-event speaker profiles, submissions,
  reviews and comments, tasks, tracks/rooms/tags, the sourcing pipeline, files and file
  requests, portal responses, and the outbound message log. See
  [tests/airtable-mirror-setup.md](tests/airtable-mirror-setup.md).
- **Operations** — outbox-based email delivery with retries, reminder and bulk-job sweeps, a
  nightly demo-data reset, and a one-click reset button.

## Run it locally

No Cloudflare account and no login are needed — `wrangler dev` runs D1 and KV locally in miniflare.

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .dev.vars   # signs the auth cookie
echo "DEV_MODE=on" >> .dev.vars                              # show magic links in the browser
npm run migrate:local      # apply packages/db/migrations to the local D1
npm run seed:local         # load the demo event from packages/db/seed/seed.sql
npm run dev                # full build (theme, manual, both frontends), then wrangler dev
```

Then open http://localhost:8787 — it redirects to the admin login. With `DEV_MODE=on` the magic
link is shown directly on the page after you enter an email, so no email provider is needed:

- **Admin**: sign in as `james@atelyr.com` (seeded owner) → the admin shell at `/app`
- **Speaker**: sign in as `ada@example.com` at `/portal/ai-engineer-sandbox-event`
- **Public CFP**: `/submit/ai-engineer-sandbox-event/form0000-0000-4000-8000-000000000001`
- `/docs` — API reference; `/health` — liveness check

Order matters: migrate before seed, and seed before dev, or pages render with no event.
`npm run dev` runs the full build first — theme tokens, the manual, both frontends — so re-run it
after changing anything under `apps/public/src`, `apps/admin/src`, `packages/ui`,
`packages/theme` or `docs/manual`. `npm run typecheck` covers the workspaces, and `npm test`
runs all three vitest projects (`unit`, `ui`, `workers`).

Cron triggers never fire under `wrangler dev`, so the per-minute sweeps (outbox retries,
reminders, bulk jobs, the Airtable mirror) only run when you kick them by hand — see the
scheduled-trigger URL wrangler prints at startup.

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
| [Airtable](https://airtable.com) PAT + base | Free tier | Optional: the one-way D1 → Airtable mirror (off by default, configured in Settings) |
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
| `AIRTABLE_SYNC` | var | `off` (default) or `on` — one-way D1 → Airtable mirror. Superseded by Settings → Airtable mirror once that has been saved |
| `AIRTABLE_API_KEY` | secret | Airtable PAT; only needed to configure the mirror from the command line rather than in Settings |
| `AIRTABLE_BASE_ID` | secret | `app…`; likewise |
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
- **Magic-link auth, with passwords as an opt-in second door.** A single-use token hashed into KV
  with a 15-minute TTL, exchanged for a signed HttpOnly cookie (HMAC-SHA256, WebCrypto, no
  dependencies). Since 0032 an account may also set a password (PBKDF2-SHA256 in
  `auth_credentials`), where a signup's hash stays pending until a consumed magic link proves the
  mailbox — the link is still the root of trust. Roles `owner > admin > reviewer > speaker`
  enforced by `can()` in `packages/core`.
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
- **Integrations are set up in the product, not the terminal.** Every org brings its own Airtable
  account, so the mirror asks for a token in Settings, lists the bases that token can see, and
  creates the eight tables and their columns itself — the schema lives in
  `packages/airtable/src/schema.ts` and a test asserts it matches the field mappers, so the two
  cannot drift. Configuration is stored in D1 and takes precedence over the `AIRTABLE_*` env
  vars, which remain for command-line deployments.
- **Import from Sessionboard, scoped honestly.** The spreadsheet importer has a named
  Sessionboard mode: their header spellings auto-map, statuses translate (unknown ones degrade
  to pending with a note, never an error), `YYYY-MM-DD HH:mm` times are read in the event's
  timezone, and a Speakers column links sessions to people — by email, or by exact-unique name
  match only, because a false link is worse than a missing one. The promise is deliberately
  narrow: people and sessions import cleanly; schedule and files are best-effort; everything
  unmapped is preserved on the record ("Imported fields"), and every import can be undone in
  one click (created records only — merges fill blanks and are left in place). Tasks and
  evaluations do not import, because Sessionboard does not export them.

## Deliberately out of scope

Dashboard builder/custom widgets, webhooks (specced in [docs/10](docs/10-api.md), cut for time),
month-view agenda, and per-user record permissions. The cut list with ordering is in
[docs/12 §1](docs/12-build-plan.md). Two items originally on it have since been built: the
**Airtable mirror** (`tests/workplan-9-airtable-mirror.md`, docs/03 §2) and **embeds**
(`tests/workplan-1.md` W3-A, extended by workplan 14 wave D).

## Repo layout

```
apps/
  api/           the deployed Worker: Hono routes for /auth, /portal, /app, /submit,
                 /api/v1, /docs, /e (embeds); scheduled outbox, reminder, bulk-job,
                 demo-reset and Airtable sweeps
  public/        public client build (Vite → preact/compat island)
  admin/         React SPA (Vite) → /app: workspace, forms, evaluation, review, agenda,
                 greenroom, crm (pipeline), embeds, dashboard, settings, help
packages/
  core/          pure-TS domain: types, roles, can(), conflict engine
  db/            D1 schema, migrations, repositories, outbox, seed
  ui/            shared components, SSR + SPA
  email/         provider seam (Resend + SendGrid + dev console), ICS builder
  theme/         design tokens → generated CSS, with contrast tests
  airtable/      mirror client, base schema + setup, watermark sweep
docs/            the specification set
  manual/        the plain-language user manual, built into the in-app Help screen
tests/           numbered workplans, eval findings and operator runbooks
spikes/          M0 calendar-invite spike scripts + findings
scripts/         build-manual, asset headers, post-migrate verification
wrangler.toml    D1 "DB", KV "KV", assets "ASSETS", crons
```

## Licence

MIT — see [LICENSE](LICENSE).
