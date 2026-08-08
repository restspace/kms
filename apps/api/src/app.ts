import { Hono } from 'hono';
import type { AppEnv } from './env';
import { authRoutes } from './routes/auth';
import { portalRoutes } from './routes/portal';
import { adminRoutes } from './routes/admin';
import { publicRoutes } from './routes/public';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'kms', time: new Date().toISOString() }),
  );

  app.route('/auth', authRoutes);
  app.route('/portal', portalRoutes);
  app.route('/app', adminRoutes);
  app.route('/hello', publicRoutes); // SSR + island proof page (commit 8454ce6)

  app.get('/', (c) => c.redirect('/app'));

  return app;
}
