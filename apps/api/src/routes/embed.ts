// Embed surfaces (lane W3-A, rubric EMB-15): the two endpoints an organiser's
// own website talks to, kept out of landing.tsx so the public pages and their
// feeds stay one file and this one stays a leaf.
//
//   GET /embed.js            loader script — reads data-* attributes off its
//                            own <script> tag and injects a sized iframe of
//                            the matching /e/:slug/<widget> page
//   GET /e/:slug/agenda.xml  the agenda.json payload as well-formed XML, for
//                            consumers (CMS importers, feed readers) that
//                            want a document rather than JSON
//
// Nothing here is persisted or configurable server-side: the admin Embeds
// screen is a snippet *generator*, so every option travels in the URL.

import { Hono } from 'hono';
import type { AppEnv } from '../env';

export const embedRoutes = new Hono<AppEnv>();

/** The five embeddable public surfaces — must match packages/ui EventPageKind. */
export const EMBED_WIDGETS = ['sessions', 'speakers', 'agenda', 'schedule', 'gallery'] as const;
export type EmbedWidget = (typeof EMBED_WIDGETS)[number];

// ---------------------------------------------------------------------------
// GET /embed.js
// ---------------------------------------------------------------------------
//
// Usage on a third-party page:
//
//   <script src="https://kms.example/embed.js"
//           data-event="my-conf" data-widget="agenda"
//           data-accent="#ff0055" data-header="0"
//           data-track="Platform" data-day="2026-05-12"
//           data-height="640"></script>
//
// The script runs at parse time, so `document.currentScript` is its own tag;
// it inserts the iframe immediately before itself, meaning the embed lands
// exactly where the publisher put the tag. Height auto-follows the content via
// the postMessage the embedded page emits (packages/ui EMBED_RESIZE_SCRIPT) —
// with `data-height` as the starting/fallback height for browsers where the
// message never arrives. The script origin comes from the tag's own `src`, so
// one snippet works from any deployment without a hard-coded hostname.

const LOADER_JS = `(function () {
  var s = document.currentScript;
  if (!s) return;
  var d = s.dataset || {};
  var slug = d.event || '';
  var widget = d.widget || 'agenda';
  if (!slug) {
    if (window.console) console.error('[kms-embed] missing data-event on the <script> tag');
    return;
  }
  var origin;
  try { origin = new URL(s.src, window.location.href).origin; } catch (e) { origin = ''; }

  var params = new URLSearchParams();
  params.set('embed', '1');
  if (d.header === '0' || d.header === 'false') params.set('header', '0');
  if (d.accent) params.set('accent', d.accent);
  if (d.track) params.set('track', d.track);
  if (d.day) params.set('day', d.day);

  var src = origin + '/e/' + encodeURIComponent(slug) + '/' + encodeURIComponent(widget) + '?' + params.toString();

  var frame = document.createElement('iframe');
  frame.src = src;
  frame.title = d.title || 'Event ' + widget;
  frame.loading = 'lazy';
  frame.setAttribute('scrolling', 'no');
  frame.style.width = '100%';
  frame.style.border = '0';
  frame.style.display = 'block';
  frame.style.height = (parseInt(d.height, 10) > 0 ? parseInt(d.height, 10) : 600) + 'px';
  frame.className = 'kms-embed kms-embed-' + widget;

  window.addEventListener('message', function (event) {
    if (origin && event.origin !== origin) return;
    if (event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || data.type !== 'kms:embed:height') return;
    var h = parseInt(data.height, 10);
    if (h > 0) frame.style.height = h + 'px';
  });

  s.parentNode.insertBefore(frame, s);
})();
`;

embedRoutes.get('/embed.js', (c) =>
  c.body(LOADER_JS, 200, {
    'content-type': 'application/javascript; charset=utf-8',
    // Third-party pages fetch this cross-origin; it is a public static asset.
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=300, s-maxage=3600, stale-while-revalidate=86400',
  }),
);

// ---------------------------------------------------------------------------
// GET /e/:slug/agenda.xml
// ---------------------------------------------------------------------------
//
// Same gate and same session set as /e/:slug/agenda.json (agenda_published =
// 1; accepted + scheduled only; display names, never contact details). The
// query is re-stated here rather than shared out of landing.tsx so this lane
// adds a file instead of restructuring one other lanes are editing — if the
// two ever drift, agenda.json is the source of truth.
//
// Supports the same ?track= / ?day= filters the public pages accept, so a
// snippet and its XML feed can describe the same slice.

interface XmlEventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  agenda_published: number;
}

interface XmlSessionRow {
  id: string;
  code: string;
  title: string;
  description: string | null;
  format: string | null;
  level: string | null;
  capacity: number | null;
  track_id: string | null;
  room_id: string | null;
  starts_at: string;
  ends_at: string;
}

/** Escape text for an XML text node or attribute value. */
export function xmlEscape(value: string): string {
  return (
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      // XML 1.0 forbids most control characters outright — drop them rather
      // than emit a document no parser will accept.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
  );
}

function tag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `<${name}>${xmlEscape(String(value))}</${name}>`;
}

/** YYYY-MM-DD in the event's own timezone (same rule as agenda.json's `day`). */
function dayKey(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

embedRoutes.get('/e/:slug/agenda.xml', async (c) => {
  const db = c.env.DB;
  const event = await db
    .prepare('SELECT id, name, slug, timezone, agenda_published FROM events WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<XmlEventRow>();
  if (!event || event.agenda_published !== 1) {
    return c.body('<?xml version="1.0" encoding="UTF-8"?><error code="not_found"/>', 404, {
      'content-type': 'application/xml; charset=utf-8',
    });
  }

  const [sessions, rooms, tracks, speakers] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, title, description, format, level, capacity, track_id, room_id, starts_at, ends_at
         FROM submissions
         WHERE event_id = ? AND status = 'accepted' AND content_approved = 1 AND starts_at IS NOT NULL AND ends_at IS NOT NULL
         ORDER BY starts_at, code`,
      )
      .bind(event.id)
      .all<XmlSessionRow>()
      .then((r) => r.results),
    db
      .prepare('SELECT id, name, capacity FROM rooms WHERE event_id = ? ORDER BY position')
      .bind(event.id)
      .all<{ id: string; name: string; capacity: number | null }>()
      .then((r) => r.results),
    db
      .prepare('SELECT id, name, color FROM tracks WHERE event_id = ? ORDER BY position')
      .bind(event.id)
      .all<{ id: string; name: string; color: string | null }>()
      .then((r) => r.results),
    db
      .prepare(
        // title/company live on event_contacts since 0015 — pinned to this
        // event so an embed of one event never shows a speaker's profile from
        // another event in the same org. LEFT JOIN: s.event_id is the tenancy
        // guard, so a participant without a roster row still gets listed.
        `SELECT sp.submission_id,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
                ec.job_title, ec.company
         FROM submission_participants sp
         JOIN contacts c ON c.id = sp.contact_id
         JOIN submissions s ON s.id = sp.submission_id
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
         WHERE s.event_id = ?1 AND s.status = 'accepted' AND s.content_approved = 1
           AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
         ORDER BY sp.position`,
      )
      .bind(event.id)
      .all<{
        submission_id: string;
        name: string | null;
        job_title: string | null;
        company: string | null;
      }>()
      .then((r) => r.results),
  ]);

  const roomsById = new Map(rooms.map((r) => [r.id, r]));
  const tracksById = new Map(tracks.map((t) => [t.id, t]));
  const speakersBySession = new Map<
    string,
    { name: string; title: string | null; company: string | null }[]
  >();
  for (const row of speakers) {
    const name = (row.name ?? '').trim();
    if (!name) continue; // no email fallback: public payloads carry no PII
    const list = speakersBySession.get(row.submission_id) ?? [];
    list.push({ name, title: row.job_title, company: row.company });
    speakersBySession.set(row.submission_id, list);
  }

  // Same filter vocabulary as the public pages: track id or track name, day key.
  const q = new URL(c.req.url).searchParams;
  const wantTrack = (q.get('track') ?? '').trim().toLowerCase();
  const wantDay = (q.get('day') ?? '').trim();
  const trackIds = new Set(
    tracks
      .filter((t) => t.id.toLowerCase() === wantTrack || (t.name ?? '').trim().toLowerCase() === wantTrack)
      .map((t) => t.id),
  );

  const visible = sessions.filter((s) => {
    if (wantTrack && !(s.track_id !== null && trackIds.has(s.track_id))) return false;
    if (wantDay && dayKey(s.starts_at, event.timezone) !== wantDay) return false;
    return true;
  });

  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push(
    `<agenda slug="${xmlEscape(event.slug)}" timezone="${xmlEscape(event.timezone)}" generated="${new Date().toISOString()}">`,
  );
  parts.push(
    `<event>${tag('name', event.name)}${tag('slug', event.slug)}${tag('timezone', event.timezone)}</event>`,
  );

  const days = [...new Set(visible.map((s) => dayKey(s.starts_at, event.timezone)))].sort();
  parts.push(`<days>${days.map((d) => tag('day', d)).join('')}</days>`);

  parts.push('<sessions>');
  for (const s of visible) {
    const room = s.room_id ? roomsById.get(s.room_id) ?? null : null;
    const track = s.track_id ? tracksById.get(s.track_id) ?? null : null;
    const people = speakersBySession.get(s.id) ?? [];
    parts.push(`<session id="${xmlEscape(s.id)}">`);
    parts.push(tag('code', s.code));
    parts.push(tag('title', s.title));
    parts.push(tag('description', s.description));
    parts.push(tag('format', s.format));
    parts.push(tag('level', s.level));
    parts.push(tag('capacity', s.capacity));
    parts.push(tag('day', dayKey(s.starts_at, event.timezone)));
    parts.push(tag('starts_at', s.starts_at));
    parts.push(tag('ends_at', s.ends_at));
    if (room) parts.push(`<room id="${xmlEscape(room.id)}">${xmlEscape(room.name)}</room>`);
    if (track) parts.push(`<track id="${xmlEscape(track.id)}">${xmlEscape(track.name)}</track>`);
    parts.push('<speakers>');
    for (const p of people) {
      parts.push(`<speaker>${tag('name', p.name)}${tag('title', p.title)}${tag('company', p.company)}</speaker>`);
    }
    parts.push('</speakers>');
    parts.push('</session>');
  }
  parts.push('</sessions>');
  parts.push('</agenda>');

  return c.body(parts.join(''), 200, {
    'content-type': 'application/xml; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  });
});
