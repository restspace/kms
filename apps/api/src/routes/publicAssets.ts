// GET /e/:slug/speakers/:speakerId/headshot — the one public-safe asset
// route (lane W2-D3). /files/:id (see routes/files.ts) is session-gated and
// stays that way; a headshot on the published speaker directory needs to
// load in a plain <img> tag with no cookie, so this route re-derives its own
// narrow visibility rule instead of reusing fileAuth's session-actor logic:
//
//   contact -> event_contacts.headshot_asset_id -> file_assets row (same KV
//   read as loadFile in filestore.ts)
//
// gated on the exact chain speakers.json already exposes the contact through:
//   event.agenda_published = 1 AND the contact participates in an accepted,
//   scheduled ('starts_at'/'ends_at' set) submission of that event.
//
// Anyone can already learn a headshot exists (speakers.json lists every
// published speaker's id); this route only decides whether *this* speaker
// is one of them before it will stream bytes, so it never leaks more than
// the JSON feed already does. 404 (not 403) on every negative path, same
// convention as /files/:id, so a probe can't distinguish "wrong event",
// "not a published speaker", and "no headshot set".

import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { IMAGE_TYPES, loadFile } from '../filestore';

export const publicAssetRoutes = new Hono<AppEnv>();

interface PublicEventRow {
  id: string;
  agenda_published: number;
}

interface PublicSpeakerContactRow {
  headshot_asset_id: string | null;
}

publicAssetRoutes.get('/e/:slug/speakers/:speakerId/headshot', async (c) => {
  const db = c.env.DB;
  const slug = c.req.param('slug');
  const speakerId = c.req.param('speakerId');

  const event = await db
    .prepare('SELECT id, agenda_published FROM events WHERE slug = ?')
    .bind(slug)
    .first<PublicEventRow>();
  if (!event || event.agenda_published !== 1) return c.text('Not found', 404);

  // Same visibility rule as GET /e/:slug/speakers.json: only a contact who is
  // a participant on an accepted, scheduled submission of this event counts
  // as a "published speaker" — anyone else's headshot stays unreachable even
  // if they happen to have one on file (a rejected co-author, a reviewer).
  //
  // Post-0015 the contact row is org-wide and the headshot is not: it hangs
  // off event_contacts, one row per (event, contact). That makes the guard
  // three conditions, all pinned to THIS event:
  //   1. `event_contacts ec ... ec.event_id = ?2` — membership. This replaces
  //      the old `c.event_id = ?2` tenancy check and is also the fetch: the
  //      asset id we read is the headshot this person published for this
  //      event, so an image uploaded for a different event in the same org is
  //      simply not selected here, never mind served.
  //   2. `c.id = ?1` — the requested speaker.
  //   3. the EXISTS, whose `s.event_id = ?2` is now load-bearing rather than
  //      belt-and-braces: without it the subquery would range over every
  //      submission the person has ever made anywhere in the org, so being an
  //      accepted speaker at ANY event would publish their headshot at THIS
  //      one.
  const contact = await db
    .prepare(
      `SELECT ec.headshot_asset_id
       FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE c.id = ?1 AND ec.event_id = ?2
         AND EXISTS (
           SELECT 1 FROM submission_participants sp
           JOIN submissions s ON s.id = sp.submission_id
           WHERE sp.contact_id = c.id AND s.event_id = ?2
             AND s.status = 'accepted' AND s.content_approved = 1 AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
             AND s.pencilled_at IS NULL
         )`,
    )
    .bind(speakerId, event.id)
    .first<PublicSpeakerContactRow>();
  if (!contact || !contact.headshot_asset_id) return c.text('Not found', 404);

  const found = await loadFile(c.env, contact.headshot_asset_id, event.id);
  if (!found) return c.text('Not found', 404);

  const contentType = found.row.content_type ?? '';
  // Belt and braces: this route only ever serves images, never the document
  // types /files/:id also handles (task uploads, contracts).
  if (!IMAGE_TYPES.has(contentType)) return c.text('Not found', 404);

  return new Response(found.body, {
    headers: {
      'content-type': contentType,
      'content-disposition': 'inline',
      'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
      'x-content-type-options': 'nosniff',
    },
  });
});
