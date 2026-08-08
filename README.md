# KMS — speaker and program management for conferences

An open-source replacement for [Sessionboard](https://www.sessionboard.com/): organisers publish a
call for speakers, collect and score submissions, accept speakers into a self-service portal that
chases them for bios, headshots and slides, build a conflict-free agenda by drag and drop, and
watch the outstanding onboarding tasks on a live dashboard. It runs on Cloudflare Workers with D1
as the system of record.

**Status: M0 (foundations) complete locally.** Full D1 schema and migrations, magic-link auth with
signed session cookies and role gating, a seeded demo event, the speaker-portal and admin M0
pages, and the two-target frontend build (SSR + hydrated island measured ~8 KB gzip). The product
is built across milestones M0–M7 tracked in [docs/12-build-plan.md](docs/12-build-plan.md); the
full specification is in [docs/](docs/README.md).

## Run it locally

No Cloudflare account and no login are needed — `wrangler dev` runs D1 and KV locally in miniflare.

```bash
npm install
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .dev.vars   # signs the auth cookie
npm run migrate:local      # apply packages/db/migrations to the local D1
npm run seed:local         # load the demo event from packages/db/seed/seed.sql
npm run dev                # builds the public client bundle, then wrangler dev
```

Then open http://localhost:8787 — it redirects to the admin login. With `DEV_MODE = "on"`
(the default in `wrangler.toml`) the magic link is shown directly on the page after you enter an
email, so no email provider is needed:

- **Admin**: sign in as `james@atelyr.com` (seeded owner) → the admin shell at `/app`
- **Speaker**: sign in as `ada@example.com` at `/portal/ai-engineer-sandbox-event`
- `/hello` — the SSR + island proof page; `/health` — liveness check

Order matters: migrate before seed, and seed before dev, or pages render with no event.
`npm run dev` runs `build:public` first, so re-run it after changing anything under
`apps/public/src` or `packages/ui`. `npm run typecheck` covers the workspaces.

## Deploy it

Requires a Cloudflare account (the free plan is enough — Queues is deliberately not used).

```bash
npx wrangler login
npx wrangler d1 create kms
npx wrangler kv namespace create KV
```

Both commands print an id. The ids in `wrangler.toml` are **placeholders** — paste the real ones
over them, set `APP_URL` under `[vars]` to your deployed URL, and set `DEV_MODE = "off"`
(with it on, login links are shown in the browser instead of emailed). Then:

```bash
npx wrangler secret put SESSION_SECRET   # 32-byte hex
npx wrangler secret put RESEND_API_KEY   # sending-only key
npx wrangler secret put EMAIL_FROM       # e.g. "AI.Engineer <cfp@yourdomain>"
npm run migrate:remote
npm run seed:remote
npm run deploy             # build:public, then wrangler deploy
```

## Accounts you need

None of these are needed for local development.

| Service | Cost | Needed for |
|---|---|---|
| [Cloudflare](https://dash.cloudflare.com/sign-up) | Free plan sufficient | Deployment only — Workers, D1, KV, later R2 and Cron |
| [Resend](https://resend.com) + a sending domain | Free tier, domain extra | Outbound email (magic links, confirmations) — deployed only |
| A calendar-safe email provider (SendGrid planned) | Free tier | `.ics` calendar invites from M2 — Resend strips calendar MIME (see docs/12 M0 spike result) |
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
| `DEV_MODE` | var | `on` shows magic links in the browser; **must be `off` in production** |
| `AIRTABLE_SYNC` | var | `off` (default) or `on` — one-way D1 → Airtable mirror |
| `AIRTABLE_API_KEY` | secret | `pat…` |
| `AIRTABLE_BASE_ID` | secret | `app…` |
| `USE_QUEUES` | var | `off` (default, outbox + cron) or `on` (paid plan) |
| `EMAIL_PROVIDER` | var | `resend` |
| `RESEND_API_KEY` | secret | `re_…` |
| `EMAIL_FROM` | secret | e.g. `"AI.Engineer <cfp@example.com>"` |
| `SESSION_SECRET` | secret | 32-byte hex, signs the auth cookie |

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
  `preact/compat` (the current island measures ~8 KB gzip against a 60 KB budget); the admin build
  bundles real React for TanStack and dnd-kit compatibility. Shared components in `packages/ui`
  are written once. The Worker's SSR bundle uses the same alias via `wrangler.toml [alias]`.
- **Magic-link auth.** A single-use token hashed into KV with a 15-minute TTL, exchanged for a
  signed HttpOnly cookie (HMAC-SHA256, WebCrypto, no dependencies). No passwords. Roles
  `owner > admin > reviewer > speaker` enforced by `can()` in `packages/core`, with a `Scope`
  carried into repository calls.
- **R2 for files** — headshots, slides and documents uploaded direct via short-lived presigned
  URLs, with the ZIP export bundle streamed from a Worker. (Arrives M2; binding intentionally
  absent until then.)

## Repo layout

Structure from [docs/03 §3](docs/03-architecture.md).

```
apps/
  api/           the deployed Worker: Hono routes for /auth, /portal, /app,
                 /hello (SSR island proof), /health; scheduled outbox sweep
  public/        public client build (Vite → preact/compat island)
  admin/         React SPA (Vite) → /app/*                placeholder, lands M1+
packages/
  core/          pure-TS domain: types, roles, can()      grows with M1 (forms, routing…)
  db/            D1 schema, migrations, repositories, outbox, seed
  ui/            shared components, SSR + SPA (Page, HelloPage…)
  email/         provider seam (Resend + dev console)     ICS builder lands M2
docs/            the specification set
spikes/          M0 calendar-invite spike scripts + findings
wrangler.toml    D1 "DB", KV "KV", assets "ASSETS", cron  (R2 planned)
```

## Licence

MIT — see [LICENSE](LICENSE).
