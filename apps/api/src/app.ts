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

  return app;
}
