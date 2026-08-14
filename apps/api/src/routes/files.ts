// GET /files/:id — serve stored files (headshots, task uploads) to signed-in
// members of the owning event. Bytes come from the KV file store (see
// filestore.ts for the R2 judgment call). Event scope is not enough on its
// own: resolveFileAccess applies the record-level decision table (sweep item
// P1-4) so a speaker cannot enumerate another speaker's assets.
//
// The event this route scopes to is the ASSET'S, not the session's (workplan-5
// §5). There is no slug here to resolve against, and since the portal serves any
// event the caller has a contact for, the cookie's `eventId` is only "the event
// the cookie was last minted against" — a speaker reading event B's portal on an
// event A cookie would otherwise 404 every image on the page. Resolving from the
// asset makes the actor's event equal to the event whose page is being rendered
// by construction: a portal page only ever links assets belonging to its own
// event. The alternative — re-minting the cookie with each portal's event — was
// rejected: §5 keeps the cookie shape and says no re-mint, a Set-Cookie on every
// GET breaks two tabs on two events against each other, and it would still leave
// the cookie's `role` stale for the event being viewed.
//
// Malware scanning of stored bytes is deliberately out of scope for this pass
// (documented decision): uploads are checked for size and magic-number/mime
// agreement in filestore.ts, and responses are served with nosniff and an
// attachment disposition for non-images.

import { Hono } from 'hono';
import { resolveEventActor } from '../access';
import type { AppEnv } from '../env';
import { resolveFileAccess } from '../fileAuth';
import { loadFile } from '../filestore';
import { getSession } from '../session';

export const fileRoutes = new Hono<AppEnv>();

fileRoutes.get('/:id', async (c) => {
  const session = await getSession(c);
  if (!session) return c.text('Sign in required', 401);
  const id = c.req.param('id');
  // 404, not 403, on every denial below: a refusal must not confirm that the
  // asset exists. Reading the owning event first costs one indexed lookup and
  // never touches the object store.
  const asset = await c.env.DB.prepare('SELECT event_id FROM file_assets WHERE id = ?')
    .bind(id)
    .first<{ event_id: string }>();
  if (!asset) return c.text('Not found', 404);
  // Identity, membership and role all re-derived against the asset's event —
  // the cookie's contactId belongs to its own org and its role to its own event,
  // so an owner at A must not arrive at B still holding owner.
  const actor = await resolveEventActor(c.env.DB, session.email ?? '', asset.event_id);
  if (!actor) return c.text('Not found', 404);
  const found = await loadFile(c.env, id, asset.event_id);
  if (!found) return c.text('Not found', 404);
  const allowed = await resolveFileAccess(
    c.env.DB,
    { contactId: actor.contactId, role: actor.role, eventId: asset.event_id },
    id,
  );
  if (!allowed) return c.text('Not found', 404);
  const contentType = found.row.content_type ?? 'application/octet-stream';
  // Inline only for types the browser renders in a sandboxed viewer (images,
  // PDFs) — Chrome downloads anything marked attachment, which made PDFs
  // un-previewable. Everything else (notably text/html) stays attachment so a
  // stored file can never execute in this origin; nosniff below keeps the
  // browser from second-guessing the type.
  const disposition =
    contentType.startsWith('image/') || contentType === 'application/pdf' ? 'inline' : 'attachment';
  return new Response(found.body, {
    headers: {
      'content-type': contentType,
      'content-disposition': `${disposition}; filename="${found.row.filename.replace(/[^\w.\- ]/g, '_')}"`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
});
