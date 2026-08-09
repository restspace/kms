// GET /files/:id — serve stored files (headshots, task uploads) to signed-in
// members of the owning event. Bytes come from the KV file store (see
// filestore.ts for the R2 judgment call). Event scope is not enough on its
// own: resolveFileAccess applies the record-level decision table (sweep item
// P1-4) so a speaker cannot enumerate another speaker's assets.
//
// Malware scanning of stored bytes is deliberately out of scope for this pass
// (documented decision): uploads are checked for size and magic-number/mime
// agreement in filestore.ts, and responses are served with nosniff and an
// attachment disposition for non-images.

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { resolveFileAccess } from '../fileAuth';
import { loadFile } from '../filestore';
import { getSession } from '../session';

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get('/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.text('Sign in required', 401);
  const id = c.req.param('id');
  const found = await loadFile(c.env, id, session.eventId);
  if (!found) return c.text('Not found', 404);
  const allowed = await resolveFileAccess(
    c.env.DB,
    { contactId: session.contactId, role: session.role, eventId: session.eventId },
    id,
  );
  // 404, not 403: a denied request must not confirm that the asset exists.
  if (!allowed) return c.text('Not found', 404);
  const contentType = found.row.content_type ?? 'application/octet-stream';
  const disposition = contentType.startsWith('image/') ? 'inline' : 'attachment';
  return new Response(found.body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `${disposition}; filename="${found.row.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
});
