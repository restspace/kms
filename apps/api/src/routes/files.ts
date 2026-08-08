// GET /files/:id — serve stored files (headshots, task uploads) to signed-in
// members of the owning event. Bytes come from the KV file store (see
// filestore.ts for the R2 judgment call).

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { loadFile } from '../filestore';
import { getSession } from '../session';

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get('/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.text('Sign in required', 401);
  const found = await loadFile(c.env, c.req.param('id'));
  if (!found || found.row.event_id !== session.eventId) return c.text('Not found', 404);
  return new Response(found.body, {
    headers: {
      'content-type': found.row.content_type ?? 'application/octet-stream',
      'content-disposition': `inline; filename="${found.row.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'cache-control': 'private, max-age=3600',
    },
  });
});
