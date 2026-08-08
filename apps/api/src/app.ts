import { Hono } from 'hono';
import type { AppEnv } from './env';
import { authRoutes } from './routes/auth';
import { portalRoutes } from './routes/portal';
import { adminRoutes } from './routes/admin';
import { adminApiRoutes } from './routes/adminApi';
import { restApiRoutes } from './routes/restApi';
import { buildOpenApi, docsHtml } from './openapi';
import { fileRoutes } from './routes/files';
import { publicRoutes } from './routes/public';
import { submitRoutes } from './routes/submit';

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
  app.get('/app/', (c) => c.redirect('/app')); // strict routing: normalise the slash form
  app.route('/app', adminRoutes);
  app.route('/hello', publicRoutes); // SSR + island proof page (commit 8454ce6)
  app.route('/submit', submitRoutes); // public CFP wizard (docs/04 §5)
  app.route('/files', fileRoutes); // stored files, event-scoped (docs/05 §7)

  app.get('/', (c) => c.redirect('/app'));

  return app;
}
