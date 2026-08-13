import { Hono } from 'hono';
import type { AppEnv } from './env';
import { authRoutes } from './routes/auth';
import { portalRoutes } from './routes/portal';
import { adminRoutes } from './routes/admin';
import { adminApiRoutes } from './routes/adminApi';
import { restApiRoutes } from './routes/restApi';
import { buildOpenApi, docsHtml } from './openapi';
import { fileRoutes } from './routes/files';
import { filesAdminRoutes } from './routes/filesAdmin';
import { exportRoutes, importRoutes } from './routes/importExport';
import { publicRoutes } from './routes/public';
import { submitRoutes } from './routes/submit';
import { landingRoutes } from './routes/landing';
import { publicAssetRoutes } from './routes/publicAssets';
import { embedRoutes } from './routes/embed';
import { messagingAdminRoutes } from './routes/messagingAdmin';
import { chaseRoutes } from './chase';
import { airtableAdminRoutes } from './routes/airtableAdmin';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'kms', time: new Date().toISOString() }),
  );

  // Docs + spec are public and must register before the authed /api/v1 mount.
  app.get('/api/v1/openapi.json', (c) => c.json(buildOpenApi(new URL(c.req.url).origin)));
  app.get('/docs', (c) => c.html(docsHtml(new URL(c.req.url).origin)));
  app.route('/api/v1', restApiRoutes); // public REST API, bearer-token auth (docs/10)

  app.route('/auth', authRoutes);
  app.route('/portal', portalRoutes);
  // /app/api must register before /app so its JSON guard answers API requests
  // (the /app catch-all guard replies with the HTML login page instead).
  app.route('/app/api', adminApiRoutes);
  // Organiser file surfaces (lane W2-C) live in their own router but behind the
  // same guard: registered after the /app/api mount so adminApiRoutes' `use('*')`
  // middleware still runs first and populates `session`.
  app.route('/app/api/files', filesAdminRoutes);
  // FR-REV-8 import wizard + files-bundle ZIP, mounted the same way and for
  // the same reason (the /app/api guard has already populated `session`).
  app.route('/app/api/import', importRoutes);
  app.route('/app/api/export', exportRoutes);
  // Organiser-triggered sends that don't fit adminApi.ts's generic CRUD
  // tables (SPK-06 portal invitation); same mount convention as files/import/export.
  app.route('/app/api/messaging', messagingAdminRoutes);
  // Assisted chasing inbox (workplan-13 W4c); same mount convention again.
  app.route('/app/api/chase', chaseRoutes);
  // Airtable mirror settings (Settings page); same mount convention again.
  app.route('/app/api/airtable', airtableAdminRoutes);
  app.get('/app/', (c) => c.redirect('/app')); // strict routing: normalise the slash form
  app.route('/app', adminRoutes);
  app.route('/hello', publicRoutes); // SSR + island proof page (commit 8454ce6)
  app.route('/submit', submitRoutes); // public CFP wizard (docs/04 §5)
  app.route('/files', fileRoutes); // stored files, event-scoped (docs/05 §7)

  // The front door: demo admin login, demo speaker login, reset (docs/12 §2).
  app.route('/', landingRoutes);
  // The one public-safe asset route: published speakers' headshots (docs: lane W2-D3).
  app.route('/', publicAssetRoutes);
  // Embed loader (/embed.js) + XML agenda feed (lane W3-A): public, no auth.
  app.route('/', embedRoutes);

  // Unknown paths previously fell through to the runtime's bare-text 404,
  // which reads like a broken deployment when someone guesses organizer-style
  // URLs (/admin, /organizer, /workspace/…). Answer JSON on API-ish paths and
  // a small styled page everywhere else, pointing at the real front doors.
  app.notFound((c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/app/api') || path.startsWith('/api/')) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page not found</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f5f2;color:#1f2430}
  main{text-align:center;padding:2rem;max-width:28rem}
  h1{font-size:1.4rem;margin:0 0 .5rem}
  p{margin:.4rem 0;color:#555c6e}
  a{color:#3d5a99}
</style></head><body><main>
<h1>Page not found</h1>
<p>There's nothing at <code>${path.replace(/[&<>"']/g, '')}</code>. If it's an organiser page it may also require signing in.</p>
<p><a href="/">Event site</a> · <a href="/app">Organiser workspace</a> · <a href="/portal">Speaker portal</a></p>
</main></body></html>`,
      404,
    );
  });

  return app;
}
