// The proven SSR + island vertical slice from the parallel scaffold (commit 8454ce6),
// ported onto the unified worker: same @kms/ui components, same hydration contract
// (/static/hello.js served from the ASSETS binding), event now read via createDb.

import { Hono } from 'hono';
import { renderToString } from 'preact-render-to-string';
import { createDb } from '@kms/db';
import { HelloPage, Page, type HelloPageData } from '@kms/ui';
import type { AppEnv } from '../env';

export const publicRoutes = new Hono<AppEnv>();

publicRoutes.get('/', async (c) => {
  const db = createDb(c.env.DB);
  const events = await db.events.listAll();
  const event = events[0] ?? null;

  const data: HelloPageData = {
    event: event && {
      name: event.name,
      slug: event.slug,
      timezone: event.timezone,
      starts_on: event.starts_at,
    },
    renderedAt: new Date().toISOString(),
  };

  const html =
    '<!doctype html>' +
    renderToString(
      <Page
        title={event ? `${event.name} — Call for Speakers` : 'KMS'}
        clientEntry="/static/hello.js"
        bootstrap={data}
      >
        <HelloPage data={data} />
      </Page>,
    );
  return c.html(html, 200, {
    // Public pages are edge-cacheable; the portal and admin are not (docs/03 §4).
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  });
});
