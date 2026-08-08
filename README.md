# KMS — speaker and program management for conferences

An open-source replacement for [Sessionboard](https://www.sessionboard.com/): organisers publish a
call for speakers, collect and score submissions, accept speakers into a self-service portal that
chases them for bios, headshots and slides, build a conflict-free agenda by drag and drop, and
watch the outstanding onboarding tasks on a live dashboard. It runs on Cloudflare Workers with D1
as the system of record.

**Status: hello-world scaffold.** What exists today is a Hono Worker that server-renders one page
from D1, a single migration, a seed row, and the two-target frontend build. The product itself is
built across milestones M0–M7 tracked in [docs/12-build-plan.md](docs/12-build-plan.md). The full
specification is in [docs/](docs/README.md).

## Run it locally

No Cloudflare account and no login are needed — `wrangler dev` runs D1 and KV locally in miniflare.

```bash
npm install
npm run db:migrate:local   # apply packages/db/migrations to the local D1
npm run seed:local         # load the demo event from packages/db/seed.sql
npm run dev                # builds the public client bundle, then wrangler dev
```

Then open http://localhost:8787 (and http://localhost:8787/healthz for the D1 connectivity check).

Order matters: migrate before seed, and seed before dev, or the page renders with no event.
`npm run dev` runs `build:public` first, so re-run it after changing anything under
`apps/public/src` or `packages/ui`. `npm run typecheck` runs `tsc --noEmit` over the workspaces.

## Deploy it

Requires a Cloudflare account (the free plan is enough).

```bash
npx wrangler login
npx wrangler d1 create kms
npx wrangler kv namespace create KV
```

Both commands print an id. The ids currently in `wrangler.toml` are **placeholders**
(`00000000-…` for `database_id`, `0000…000f` for the KV `id`) — paste the real ones over them, and
set `APP_URL` under `[vars]` to your deployed URL. Then:

```bash
npm run db:migrate         # wrangler d1 migrations apply kms --remote
npm run seed               # wrangler d1 execute kms --remote --file=packages/db/seed.sql
npm run deploy             # build:public, then wrangler deploy
```

## Accounts you need

None of these are needed for local development.

| Service | Cost | Needed for |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Free plan sufficient | Deployment only — Workers, D1, KV, later R2 and Cron |
| [Resend](https://resend.com) + a sending domain | Free tier, domain extra | Outbound email and the `.ics` calendar invites — from M2 onward |
| [Airtable](https://airtable.com) PAT + base | Free tier | Optional: the one-way D1 → Airtable mirror (bonus feature) |
| [Forge](https://forge.smol.ai/) or GitHub | Free | Hosting the repository |

Cloudflare Queues is deliberately **not** required; it needs the Workers paid plan (see
Architecture below).

## Configuration

Non-secret values live in `[vars]` in `wrangler.toml`. Secrets go in `.dev.vars` locally (already
gitignored) and `npx wrangler secret put NAME` in production. From
[docs/03 §9](docs/03-architecture.md):

| Variable | Where | Notes |
|---|---|---|
| `APP_URL` | var | Public base URL; `http://localhost:8787` locally |
| `EVENT_DEFAULT_TZ` | var | Default event timezone, e.g. `America/Los_Angeles` |
| `AIRTABLE_SYNC` | var | `off` (default) or `on` — one-way D1 → Airtable mirror |
| `AIRTABLE_API_KEY` | secret | `pat…` |
| `AIRTABLE_BASE_ID` | secret | `app…` |
| `USE_QUEUES` | var | `off` (default, outbox + cron) or `on` (paid plan) |
| `EMAIL_PROVIDER` | var | `resend` |
| `RESEND_API_KEY` | secret | `re_…` |
| `EMAIL_FROM` | var | e.g. `"AI.Engineer <cfp@example.com>"` |
| `SESSION_SECRET` | secret | 32-byte hex, signs the auth cookie |

`APP_URL`, `EVENT_DEFAULT_TZ`, `AIRTABLE_SYNC` and `USE_QUEUES` are already set in
`wrangler.toml`; the rest arrive with the milestones that use them.

## Architecture

Full rationale in [docs/03-architecture.md](docs/03-architecture.md).

- **Cloudflare Workers + Hono.** Edge SSR for the public CFP and portal pages, a JSON API under
  `/api/v1`, and an admin SPA served as static assets.
- **D1 is the system of record; Airtable is a one-way mirror.** Airtable alone cannot back a grid
  product (5 req/s per base, no joins, no transactions), so it is fed from D1 rather than queried.
  A `Repository<T>` interface keeps the store swappable.
- **D1 `outbox` table + Cron Triggers instead of Queues.** Jobs are attempted inline via
  `ctx.waitUntil` and retried by a per-minute cron sweep with backoff and a dead-letter status.
  Queues requires the Workers paid plan, so it stays an optional optimisation (`USE_QUEUES=on`).
- **One React JSX idiom, two build targets.** The public build aliases `react`/`react-dom` to
  `preact/compat` (the current island measures 8 KB gzip against a 60 KB budget); the admin build bundles real React
  for TanStack and dnd-kit compatibility. Shared components in `packages/ui` are written once.
- **Magic-link auth.** A single-use token hashed into KV with a 15-minute TTL, exchanged for a
  signed HttpOnly cookie. No passwords. Roles `owner > admin > reviewer > speaker`, enforced by a
  `Scope` passed into every repository call.
- **R2 for files** — headshots, slides and documents uploaded direct via short-lived presigned
  URLs, with the ZIP export bundle streamed from a Worker.

## Repo layout

Structure from [docs/03 §3](docs/03-architecture.md). Only a slice exists today.

```
apps/
  public/        SSR routes (Hono + React-API SSR)      exists (hello-world route + healthz)
  admin/         React SPA (Vite) → /app/*              planned
  api/           Hono REST → /api/v1/*                  planned
packages/
  ui/            shared components, SSR + SPA           exists (Page, HelloPage, SubmissionCounter)
  db/            D1 schema, migrations, repositories     exists (events only; outbox planned)
  core/          pure-TS domain: forms, routing,        planned
                 conflicts, scoring, scheduling
  airtable/      one-way D1 → Airtable mirror            planned
  email/         templates, renderer, ICS builder        planned
workers/
  jobs/          outbox consumer (email + Airtable)      planned
  cron/          reminder + retry sweeps, aggregates     planned
docs/            the specification set                   exists
wrangler.toml    D1 "DB", KV "KV", assets "ASSETS"       exists (R2 + Cron planned)
```

## Licence

MIT — see [LICENSE](LICENSE).
