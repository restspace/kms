// GET / — the public front door (docs/12 §2 "Demo logins", checklist §4).
// A judge arriving cold must be able to sign in as the demo admin, sign in as
// the demo speaker, and reset the demo data without asking anyone how. The
// logins are one-click magic-link requests against the seeded contacts; the
// reset replays the same seed the Settings button and the nightly cron use.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { renderToString } from 'preact-render-to-string';
import { redactInternal, redactInternalAll } from '@kms/core';
import {
  Page,
  EventPage,
  type EventPageBootstrap,
  type EventPageKind,
  type EventPageOptions,
} from '@kms/ui';
import type { AppEnv } from '../env';
import { esc, page } from '../html';
import { matchTrackIds } from './embed';

export const landingRoutes = new Hono<AppEnv>();

/** The repo's docs folder on GitHub — the demo is public and the source is too,
 * so the orientation a tester needs is one link away rather than pasted here. */
const REPO_DOCS = 'https://github.com/restspace/kms/blob/main/docs';

/** Banner above everything else on the front door: a tester arriving cold reads
 * this before the sign-in buttons start competing for their attention. */
const testersNotice = `<div class="notice">
  <strong>Testers please read</strong>
  <p class="muted">Two short documents, on GitHub — worth five minutes before you click anything.</p>
  <ul>
    <li><a href="${REPO_DOCS}/Intro.md" target="_blank" rel="noopener noreferrer">Intro</a> — what this is, and how it answers the brief.</li>
    <li><a href="${REPO_DOCS}/SuppliedExtras.md" target="_blank" rel="noopener noreferrer">Extras</a> — things to try that the brief never asked for.</li>
  </ul>
</div>`;

interface DemoLogins {
  eventName: string;
  eventSlug: string;
  adminEmail: string | null;
  speakerEmail: string | null;
  openFormId: string | null;
}

/** Read the demo credentials out of the seeded data rather than hard-coding them. */
export async function demoLogins(db: D1Database): Promise<DemoLogins | null> {
  // Prefer the most recently created event that still has an open submission
  // form — that's the one worth advertising as "Public call for speakers" —
  // falling back to the most recently created event overall so a fresh
  // install with no open form yet still resolves to something. A single
  // query: the CASE pushes rows with no open form to the back before the
  // created_at tiebreak, so this stays as cheap as the old single-column sort.
  const event = await db
    .prepare(
      `SELECT e.id, e.name, e.slug FROM events e
       ORDER BY
         (EXISTS (SELECT 1 FROM submission_forms f WHERE f.event_id = e.id AND f.status = 'open')) DESC,
         e.created_at DESC
       LIMIT 1`,
    )
    .first<{ id: string; name: string; slug: string }>();
  if (!event) return null;

  const admin = await db
    .prepare(
      `SELECT c.email FROM event_users eu
       JOIN contacts c ON c.id = eu.contact_id
       WHERE eu.event_id = ? AND eu.role IN ('owner', 'admin')
       ORDER BY eu.role = 'owner' DESC LIMIT 1`,
    )
    .bind(event.id)
    .first<{ email: string }>();

  // A speaker, not an organiser: someone who submitted but holds no event role.
  //
  // Contacts-hygiene item 5: this used to match on email alone (no name
  // requirement), which is fine against a freshly-seeded event but not
  // guaranteed to stay pointed at the same person once the demo picks up
  // runtime data — a nameless stub contact (submit.tsx's Account-step
  // upsert, see App.tsx's isPlaceholderContact for the full story) sorts by
  // `created_at, email` exactly like any seeded row and, if it happens to
  // land first, would advertise an email nobody can meaningfully sign in as
  // (there is no one to greet as). Requiring a real name pins the advertised
  // login to an actual person, so the emailed/displayed identity here always
  // matches the contact the session and its portal display name resolve to.
  //
  // Post-0015 the contact row itself is org-wide, so all three conditions are
  // pinned to this event explicitly: `event_contacts` is the membership filter
  // `contacts.event_id` used to be, and the two subqueries would otherwise see
  // submissions and roles the person holds at OTHER events in the same org —
  // which could advertise a login for someone who is not a speaker here, or
  // hide the real one because they happen to be an organiser elsewhere.
  const speaker = await db
    .prepare(
      `SELECT c.email FROM event_contacts ec
       JOIN contacts c ON c.id = ec.contact_id
       WHERE ec.event_id = ?1
         AND TRIM(COALESCE(c.first_name, '') || COALESCE(c.last_name, '')) != ''
         AND EXISTS (SELECT 1 FROM submissions s
                     WHERE s.submitter_contact_id = c.id AND s.event_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM event_users eu
                         WHERE eu.contact_id = c.id AND eu.event_id = ?1)
       ORDER BY c.created_at, c.email LIMIT 1`,
    )
    .bind(event.id)
    .first<{ email: string }>();

  const form = await db
    .prepare(
      `SELECT id FROM submission_forms
       WHERE event_id = ? AND status = 'open' ORDER BY created_at LIMIT 1`,
    )
    .bind(event.id)
    .first<{ id: string }>();

  return {
    eventName: event.name,
    eventSlug: event.slug,
    adminEmail: admin?.email ?? null,
    speakerEmail: speaker?.email ?? null,
    openFormId: form?.id ?? null,
  };
}

function loginForm(id: string, heading: string, blurb: string, email: string, eventSlug: string): string {
  return `<section>
  <h2>${esc(heading)}</h2>
  <p class="muted">${esc(blurb)}</p>
  <form method="post" action="/auth/request" id="${esc(id)}">
    <input type="hidden" name="email" value="${esc(email)}">
    <input type="hidden" name="event_slug" value="${esc(eventSlug)}">
    <p class="code">${esc(email)}</p>
    <button type="submit">${esc(heading)}</button>
  </form>
</section>`;
}

landingRoutes.get('/', async (c) => {
  const logins = await demoLogins(c.env.DB);
  if (!logins) {
    return c.html(
      page(
        'KMS',
        `${testersNotice}
<h1>KMS</h1>
<p>No event has been seeded yet. Run <span class="code">npm run seed:local</span>, then reload.</p>`,
      ),
    );
  }

  const adminBlock = logins.adminEmail
    ? loginForm(
        'demo-admin-login',
        'Demo admin login',
        `Sign in as the organiser of ${logins.eventName}: the workspace, agenda, dashboards and settings.`,
        logins.adminEmail,
        logins.eventSlug,
      )
    : '<section><h2>Demo admin login</h2><p class="muted">No organiser is seeded for this event.</p></section>';

  const speakerBlock = logins.speakerEmail
    ? loginForm(
        'demo-speaker-login',
        'Demo speaker login',
        'Sign in as a speaker with submissions, tasks and a message history: the speaker portal.',
        logins.speakerEmail,
        logins.eventSlug,
      )
    : '<section><h2>Demo speaker login</h2><p class="muted">No speaker is seeded for this event.</p></section>';

  const resetBlock =
    c.env.DEMO_RESET === 'on'
      ? `<section>
  <h2>Demo data</h2>
  <p class="muted">Replays the seed: the demo organisation and everything below it are recreated from scratch.</p>
  <form method="post" action="/demo/reset" id="demo-reset">
    <button type="submit">Reset demo data</button>
  </form>
</section>`
      : '';

  return c.html(
    page(
      'KMS — event knowledge management',
      `${testersNotice}
<h1>KMS — ${esc(logins.eventName)}</h1>
<p>A speaker and session management system: call for papers, review and scoring, agenda,
speaker comms. Pick a door — the sign-in link is shown on the next page. Fixture passwords also work: admin demo-admin-pass, speaker demo-speaker-pass.</p>
${adminBlock}
${speakerBlock}
${resetBlock}
<section>
  <h2>Elsewhere</h2>
  <ul class="list">
    ${
      logins.openFormId
        ? `<li><a href="/submit/${esc(logins.eventSlug)}/${esc(logins.openFormId)}">Public call for speakers</a></li>`
        : ''
    }
    <li><a href="/e/${esc(logins.eventSlug)}/sessions">Public sessions list</a></li>
    <li><a href="/e/${esc(logins.eventSlug)}/speakers">Public speaker directory</a></li>
    <li><a href="/e/${esc(logins.eventSlug)}/agenda">Public agenda</a></li>
    <li><a href="/e/${esc(logins.eventSlug)}/schedule">Public schedule / itinerary</a></li>
    <li><a href="/e/${esc(logins.eventSlug)}/gallery">Public speaker gallery</a></li>
    <li><a href="/docs">REST API docs</a></li>
  </ul>
</section>`,
    ),
  );
});

// POST /demo/reset — the landing page's button. Same reset the Settings screen
// runs, gated on the same DEMO_RESET flag so a real installation cannot be
// wiped by an anonymous visitor.
landingRoutes.post('/demo/reset', async (c) => {
  if (c.env.DEMO_RESET !== 'on') {
    return c.html(
      page('Reset disabled', '<h1>Demo reset is disabled</h1><p>This deployment is not a demo instance.</p>'),
      403,
    );
  }
  const { resetDemoData } = await import('../demo');
  await resetDemoData(c.env.DB);
  return c.html(
    page(
      'Demo data reset',
      `<h1>Demo data reset</h1>
<p>The seed has been replayed — every demo record is back to its starting state.</p>
<p><a href="/">Back to the front page</a></p>`,
    ),
  );
});

// ---------------------------------------------------------------------------
// GET /e/:slug/agenda.json — the published public agenda (docs/07 §8).
//
// This endpoint is what `events.agenda_published` *means*: until an organiser
// flips the flag the agenda is 404, and once flipped only accepted, scheduled
// sessions are exposed — speaker display names, never contact details, and
// every row passes the internal-field redaction boundary.
// ---------------------------------------------------------------------------

interface PublicEventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  agenda_published: number;
  /** Additive (EMB-07): event date range, so widgets can derive the full day-tab list. */
  starts_at: string;
  ends_at: string;
}

interface PublicSessionRow {
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

/** YYYY-MM-DD in the event's own timezone, so days group the way attendees see them. */
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

/**
 * Every calendar day the event spans (in the event's own timezone), inclusive
 * of both ends — not just the days that happen to have a session scheduled
 * yet. A day with zero sessions still needs a tab/entry, so this must not be
 * derived from the session list.
 */
function eventDayRange(startsAt: string, endsAt: string, timezone: string): string[] {
  const startKey = dayKey(startsAt, timezone);
  const endKey = dayKey(endsAt, timezone);
  const days: string[] = [];
  let cursor = new Date(`${startKey}T00:00:00Z`);
  const end = new Date(`${endKey}T00:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
  }
  return days;
}

/**
 * Shared by GET /e/:slug/agenda.json and GET /e/:slug/sessions.json (EMB-15):
 * the two feeds carry the identical published-session payload — SessionsWidget
 * already reads the agenda shape (rooms/tracks/day grouping is what lets its
 * facets work) — under two URLs, so the embed builder can hand out a URL that
 * actually says "sessions" for the Sessions list widget instead of the
 * agenda one. Returns null on an unknown slug or an unpublished agenda,
 * exactly like the route handlers did before this was extracted.
 */
async function loadAgendaFeed(db: D1Database, slug: string) {
  const event = await db
    .prepare('SELECT id, name, slug, timezone, agenda_published, starts_at, ends_at FROM events WHERE slug = ?')
    .bind(slug)
    .first<PublicEventRow>();
  if (!event || event.agenda_published !== 1) return null;

  const [sessions, rooms, tracks, speakers] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, title, description, format, level, capacity, track_id, room_id, starts_at, ends_at
         FROM submissions
         WHERE event_id = ? AND status = 'accepted' AND content_approved = 1 AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND pencilled_at IS NULL
         ORDER BY starts_at, code`,
      )
      .bind(event.id)
      .all<PublicSessionRow>()
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
        // ec carries the per-event profile (0015): title/company are whatever
        // this speaker published for THIS event, never another event's copy.
        // LEFT JOIN because the tenancy guard here is s.event_id — a
        // participant with no roster row should still be listed, just without
        // a title/company.
        `SELECT sp.submission_id, c.id AS contact_id,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name,
                ec.job_title, ec.company
         FROM submission_participants sp
         JOIN contacts c ON c.id = sp.contact_id
         JOIN submissions s ON s.id = sp.submission_id
         LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
         WHERE s.event_id = ?1 AND s.status = 'accepted' AND s.content_approved = 1
           AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL AND s.pencilled_at IS NULL
         ORDER BY sp.position`,
      )
      .bind(event.id)
      .all<{
        submission_id: string;
        contact_id: string;
        name: string | null;
        job_title: string | null;
        company: string | null;
      }>()
      .then((r) => r.results),
  ]);

  // EMB-01: `speakers` stays a plain name list — AgendaWidget still consumes
  // that shape. `speaker_details` is the additive, richer parallel field
  // (id/name/title/company) other consumers (SessionsWidget) read instead;
  // no email/phone here either, same PII boundary as speakers.json.
  const speakersBySession = new Map<string, string[]>();
  const speakerDetailsBySession = new Map<
    string,
    { id: string; name: string; title: string | null; company: string | null }[]
  >();
  for (const row of speakers) {
    const name = (row.name ?? '').trim();
    if (!name) continue; // no email fallback: public payloads carry no PII
    const list = speakersBySession.get(row.submission_id) ?? [];
    list.push(name);
    speakersBySession.set(row.submission_id, list);
    const details = speakerDetailsBySession.get(row.submission_id) ?? [];
    details.push({ id: row.contact_id, name, title: row.job_title, company: row.company });
    speakerDetailsBySession.set(row.submission_id, details);
  }

  // The full event span, not just days that already have a session on the
  // calendar (EMB-XX): an empty day should still show up as an empty day
  // rather than silently vanishing from the count. Session days are unioned
  // in too, in case a session's timestamp ever falls outside the event's
  // recorded starts_at/ends_at.
  const days = [
    ...new Set([...eventDayRange(event.starts_at, event.ends_at, event.timezone), ...sessions.map((s) => dayKey(s.starts_at, event.timezone))]),
  ].sort();

  return {
    // Non-null: the object literal handed to redactInternal is never null/undefined
    // itself, only its (never-taken) input-`null` branch returns null.
    event: redactInternal({ name: event.name, slug: event.slug, timezone: event.timezone, starts_at: event.starts_at, ends_at: event.ends_at })!,
    days,
    rooms: redactInternalAll(rooms),
    tracks: redactInternalAll(tracks),
    sessions: redactInternalAll(sessions).map((s) => ({
      ...s,
      day: dayKey(s.starts_at, event.timezone),
      speakers: speakersBySession.get(s.id) ?? [],
      speaker_details: redactInternalAll(speakerDetailsBySession.get(s.id) ?? []),
    })),
  };
}

landingRoutes.get('/e/:slug/agenda.json', async (c) => {
  const feed = await loadAgendaFeed(c.env.DB, c.req.param('slug'));
  if (!feed) return c.json({ error: 'not_found' }, 404);
  return c.json(feed, 200, { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' });
});

// ---------------------------------------------------------------------------
// GET /e/:slug/sessions.json — the same published-session payload as
// agenda.json, under the URL the Sessions list widget's embed actually is
// (EMB-15, major defect): the admin Embeds screen previously handed out
// .../agenda.json for every JSON-feed widget, including "Sessions list",
// which reads oddly to an organiser wiring up a sessions-only integration
// even though the shape SessionsWidget needs (rooms/tracks for its facets,
// not just a flat session array) is identical to the agenda feed's. Same
// gate, same cache policy, same payload — `loadAgendaFeed` above is the one
// source of truth for both routes.
// ---------------------------------------------------------------------------

landingRoutes.get('/e/:slug/sessions.json', async (c) => {
  const feed = await loadAgendaFeed(c.env.DB, c.req.param('slug'));
  if (!feed) return c.json({ error: 'not_found' }, 404);
  return c.json(feed, 200, { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' });
});

// ---------------------------------------------------------------------------
// GET /e/:slug/speakers.json — the published speaker directory.
//
// Mirrors agenda.json's conventions exactly: same slug lookup, same
// agenda_published gate (a speaker directory without a published agenda would
// leak who is scheduled before the organiser is ready to say so), same
// PII-redaction boundary and cache headers. Only people who are participants
// on an accepted, scheduled session appear — no email, no phone, no notes.
// ---------------------------------------------------------------------------

interface PublicSpeakerRow {
  contact_id: string;
  first_name: string | null;
  last_name: string | null;
  biography: string | null;
  company: string | null;
  job_title: string | null;
  headshot_asset_id: string | null;
  submission_id: string;
  submission_title: string;
  /** EMB-05/EMB-13: so the speaker detail page and gallery modal can show when/where each session is. */
  submission_starts_at: string;
  submission_ends_at: string;
  room_name: string | null;
}

landingRoutes.get('/e/:slug/speakers.json', async (c) => {
  const db = c.env.DB;
  const event = await db
    .prepare('SELECT id, name, slug, timezone, agenda_published, starts_at, ends_at FROM events WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<PublicEventRow>();
  if (!event || event.agenda_published !== 1) return c.json({ error: 'not_found' }, 404);

  // headshot_url points at the one public-safe asset route (routes/publicAssets.ts,
  // lane W2-D3): /files/:id (routes/files.ts) still requires a signed-in
  // session, so it stays off-limits to this feed. headshot_asset_id itself is
  // never exposed — only the URL, and only when the contact actually has one.
  const { results } = await db
    .prepare(
      // bio/company/job_title/headshot come from event_contacts pinned to this
      // event (0015): the same person can speak at several events in the org
      // with a different profile at each, and this feed must publish only the
      // one they wrote for the event being rendered. LEFT JOIN because
      // s.event_id is the tenancy guard — a participant missing a roster row
      // still appears, with an empty profile.
      `SELECT c.id AS contact_id, c.first_name, c.last_name, ec.biography, ec.company, ec.job_title,
              ec.headshot_asset_id, s.id AS submission_id, s.title AS submission_title,
              s.starts_at AS submission_starts_at, s.ends_at AS submission_ends_at, r.name AS room_name
       FROM submission_participants sp
       JOIN contacts c ON c.id = sp.contact_id
       JOIN submissions s ON s.id = sp.submission_id
       LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
       LEFT JOIN rooms r ON r.id = s.room_id
       WHERE s.event_id = ?1 AND s.status = 'accepted' AND s.content_approved = 1
         AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL AND s.pencilled_at IS NULL
       ORDER BY sp.position`,
    )
    .bind(event.id)
    .all<PublicSpeakerRow>();

  interface SpeakerAgg {
    id: string;
    name: string;
    title: string | null;
    company: string | null;
    bio: string | null;
    headshot_url: string | null;
    sessions: { id: string; title: string; starts_at: string; ends_at: string; day: string; room: string | null }[];
  }

  const bySpeaker = new Map<string, SpeakerAgg>();
  for (const row of results) {
    const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
    if (!name) continue; // no email fallback: public payloads carry no PII
    let agg = bySpeaker.get(row.contact_id);
    if (!agg) {
      agg = {
        id: row.contact_id,
        name,
        title: row.job_title,
        company: row.company,
        bio: row.biography,
        // Lane N1 (EMB-04): seed.sql has no R2/KV object to back a real
        // file_assets row (see contacts UPDATE comment below the speakers
        // insert), so demo headshots can't flow through the asset route.
        // A `headshot_asset_id` that already looks like a path (starts with
        // `/`) is a seeded static asset under the worker's own ASSETS
        // binding (apps/public/public/avatars/*.svg -> /static/avatars/*.svg)
        // and is passed straight through; a real uploaded asset id (a UUID,
        // never starting with `/`) still resolves via the gated route below.
        headshot_url: row.headshot_asset_id
          ? row.headshot_asset_id.startsWith('/')
            ? row.headshot_asset_id
            : `/e/${encodeURIComponent(event.slug)}/speakers/${encodeURIComponent(row.contact_id)}/headshot`
          : null,
        sessions: [],
      };
      bySpeaker.set(row.contact_id, agg);
    }
    agg.sessions.push({
      id: row.submission_id,
      title: row.submission_title,
      starts_at: row.submission_starts_at,
      ends_at: row.submission_ends_at,
      day: dayKey(row.submission_starts_at, event.timezone),
      room: row.room_name,
    });
  }

  const speakers = [...bySpeaker.values()].sort((a, b) => {
    const surname = (s: SpeakerAgg) => s.name.trim().split(/\s+/).pop() ?? s.name;
    return surname(a).localeCompare(surname(b)) || a.name.localeCompare(b.name);
  });

  return c.json(
    {
      event: redactInternal({ name: event.name, slug: event.slug, timezone: event.timezone, starts_at: event.starts_at, ends_at: event.ends_at }),
      speakers: redactInternalAll(speakers),
    },
    200,
    { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' },
  );
});

// ---------------------------------------------------------------------------
// GET /e/:slug/agenda.ics — the published agenda as a downloadable calendar.
//
// Same gate, same session set as agenda.json. Times are emitted in UTC
// (`...Z` DTSTAMP/DTSTART/DTEND, per RFC 5545 form 3) so the file is valid
// regardless of the subscriber's local timezone; the room becomes LOCATION,
// the description carries the (already-published) session description.
// ---------------------------------------------------------------------------

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/** Fold an ICS content line to <=75 octets per RFC 5545 §3.1, CRLF + one space. */
function foldLine(line: string): string {
  const bytes = new TextEncoder();
  if (bytes.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > 0) {
    const limit = first ? 75 : 74;
    let cut = Math.min(limit, rest.length);
    // Never split a UTF-16 surrogate pair.
    if (cut < rest.length && rest.charCodeAt(cut - 1) >= 0xd800 && rest.charCodeAt(cut - 1) <= 0xdbff) cut -= 1;
    parts.push((first ? '' : ' ') + rest.slice(0, cut));
    rest = rest.slice(cut);
    first = false;
  }
  return parts.join('\r\n');
}

/** `2026-08-09T13:00:00.000Z` -> `20260809T130000Z`, the ICS UTC form. */
function icsDate(iso: string): string {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Shared by GET /e/:slug/agenda.ics and GET /e/:slug/sessions.ics (EMB-15):
 * same published, scheduled session set either way — only the downloaded
 * filename differs, so an organiser embedding "Sessions list" gets a file
 * named for what it is. Returns null on an unknown slug or unpublished agenda.
 */
async function buildAgendaIcsBody(db: D1Database, slug: string): Promise<string | null> {
  const event = await db
    .prepare('SELECT id, name, slug, timezone, agenda_published, starts_at, ends_at FROM events WHERE slug = ?')
    .bind(slug)
    .first<PublicEventRow>();
  if (!event || event.agenda_published !== 1) return null;

  const [sessions, rooms, speakers] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, title, description, starts_at, ends_at, room_id
         FROM submissions
         WHERE event_id = ? AND status = 'accepted' AND content_approved = 1 AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND pencilled_at IS NULL
         ORDER BY starts_at, code`,
      )
      .bind(event.id)
      .all<{
        id: string;
        code: string;
        title: string;
        description: string | null;
        starts_at: string;
        ends_at: string;
        room_id: string | null;
      }>()
      .then((r) => r.results),
    db
      .prepare('SELECT id, name FROM rooms WHERE event_id = ?')
      .bind(event.id)
      .all<{ id: string; name: string }>()
      .then((r) => r.results),
    db
      .prepare(
        `SELECT sp.submission_id,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name
         FROM submission_participants sp
         JOIN contacts c ON c.id = sp.contact_id
         JOIN submissions s ON s.id = sp.submission_id
         WHERE s.event_id = ? AND s.status = 'accepted' AND s.content_approved = 1
           AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL AND s.pencilled_at IS NULL
         ORDER BY sp.position`,
      )
      .bind(event.id)
      .all<{ submission_id: string; name: string | null }>()
      .then((r) => r.results),
  ]);

  const roomsById = new Map(rooms.map((r) => [r.id, r.name]));
  const speakersBySession = new Map<string, string[]>();
  for (const row of speakers) {
    const name = (row.name ?? '').trim();
    if (!name) continue;
    const list = speakersBySession.get(row.submission_id) ?? [];
    list.push(name);
    speakersBySession.set(row.submission_id, list);
  }

  const now = icsDate(new Date().toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//KMS//Public Agenda//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    foldLine(`X-WR-CALNAME:${icsEscape(event.name)}`),
    foldLine(`X-WR-TIMEZONE:${icsEscape(event.timezone)}`),
  ];

  for (const s of sessions) {
    const room = s.room_id ? roomsById.get(s.room_id) ?? null : null;
    const speakerNames = speakersBySession.get(s.id) ?? [];
    const descriptionParts = [
      s.description ?? '',
      speakerNames.length > 0 ? `Speakers: ${speakerNames.join(', ')}` : '',
    ].filter((p) => p !== '');

    lines.push('BEGIN:VEVENT');
    lines.push(foldLine(`UID:${s.id}@${event.slug}.kms`));
    lines.push(`DTSTAMP:${now}`);
    lines.push(`DTSTART:${icsDate(s.starts_at)}`);
    lines.push(`DTEND:${icsDate(s.ends_at)}`);
    lines.push(foldLine(`SUMMARY:${icsEscape(s.title)}`));
    if (room) lines.push(foldLine(`LOCATION:${icsEscape(room)}`));
    if (descriptionParts.length > 0) {
      lines.push(foldLine(`DESCRIPTION:${descriptionParts.map(icsEscape).join('\\n\\n')}`));
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  return lines.join('\r\n') + '\r\n';
}

landingRoutes.get('/e/:slug/agenda.ics', async (c) => {
  const slug = c.req.param('slug');
  const body = await buildAgendaIcsBody(c.env.DB, slug);
  if (body === null) return c.json({ error: 'not_found' }, 404);
  return c.body(body, 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `inline; filename="${slug}-agenda.ics"`,
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  });
});

// GET /e/:slug/sessions.ics — same body as agenda.ics (EMB-15), different
// filename, for the "Sessions list" widget's embed builder iCal link.
landingRoutes.get('/e/:slug/sessions.ics', async (c) => {
  const slug = c.req.param('slug');
  const body = await buildAgendaIcsBody(c.env.DB, slug);
  if (body === null) return c.json({ error: 'not_found' }, 404);
  return c.body(body, 200, {
    'content-type': 'text/calendar; charset=utf-8',
    'content-disposition': `inline; filename="${slug}-sessions.ics"`,
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  });
});

// ---------------------------------------------------------------------------
// GET /e/:slug/sessions.xml — the published sessions as well-formed XML
// (EMB-15): the embed builder's XML feed link for the "Sessions list" widget
// previously pointed at /agenda.xml (routes/embed.ts) regardless of which
// widget was selected. That endpoint lives in a different lane's file, so
// rather than editing it this mirrors its shape locally — same session set,
// same escaping rules, same day/room/track/speaker structure — under a URL
// that actually says "sessions". If the two ever drift, agenda.xml stays the
// source of truth for the agenda-grid embed.
// ---------------------------------------------------------------------------

/** Escape text for an XML text node or attribute value. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // XML 1.0 forbids most control characters outright — drop them rather
    // than emit a document no parser will accept.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function xmlTag(name: string, value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return `<${name}>${xmlEscape(String(value))}</${name}>`;
}

landingRoutes.get('/e/:slug/sessions.xml', async (c) => {
  const slug = c.req.param('slug');
  const feed = await loadAgendaFeed(c.env.DB, slug);
  if (!feed) {
    return c.body('<?xml version="1.0" encoding="UTF-8"?><error code="not_found"/>', 404, {
      'content-type': 'application/xml; charset=utf-8',
    });
  }

  // Same ?track= / ?day= vocabulary as agenda.xml (routes/embed.ts): the embed
  // builder appends the filter to this URL too, so honouring it here keeps the
  // snippet, the direct link and the feed describing the same slice. Track
  // accepts UUID, name or readable slug.
  const q = new URL(c.req.url).searchParams;
  const wantTrack = (q.get('track') ?? '').trim();
  const wantDay = (q.get('day') ?? '').trim();
  const trackIds = matchTrackIds(feed.tracks, wantTrack);
  const visibleSessions = feed.sessions.filter((s) => {
    if (wantTrack && !(s.track_id !== null && trackIds.has(s.track_id))) return false;
    if (wantDay && s.day !== wantDay) return false;
    return true;
  });
  const visibleDays = wantTrack || wantDay ? [...new Set(visibleSessions.map((s) => s.day))].sort() : feed.days;

  const parts: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  parts.push(
    `<sessions-feed slug="${xmlEscape(feed.event.slug)}" timezone="${xmlEscape(feed.event.timezone)}" generated="${new Date().toISOString()}">`,
  );
  parts.push(
    `<event>${xmlTag('name', feed.event.name)}${xmlTag('slug', feed.event.slug)}${xmlTag('timezone', feed.event.timezone)}</event>`,
  );
  parts.push(`<days>${visibleDays.map((d) => xmlTag('day', d)).join('')}</days>`);

  const roomsById = new Map(feed.rooms.map((r) => [r.id, r]));
  const tracksById = new Map(feed.tracks.map((t) => [t.id, t]));

  parts.push('<sessions>');
  for (const s of visibleSessions) {
    const room = s.room_id ? roomsById.get(s.room_id) ?? null : null;
    const track = s.track_id ? tracksById.get(s.track_id) ?? null : null;
    parts.push(`<session id="${xmlEscape(s.id)}">`);
    parts.push(xmlTag('code', s.code));
    parts.push(xmlTag('title', s.title));
    parts.push(xmlTag('description', s.description));
    parts.push(xmlTag('format', s.format));
    parts.push(xmlTag('level', s.level));
    parts.push(xmlTag('capacity', s.capacity));
    parts.push(xmlTag('day', s.day));
    parts.push(xmlTag('starts_at', s.starts_at));
    parts.push(xmlTag('ends_at', s.ends_at));
    if (room) parts.push(`<room id="${xmlEscape(room.id)}">${xmlEscape(room.name)}</room>`);
    if (track) parts.push(`<track id="${xmlEscape(track.id)}">${xmlEscape(track.name)}</track>`);
    parts.push('<speakers>');
    for (const sp of s.speaker_details) {
      parts.push(`<speaker>${xmlTag('name', sp.name)}${xmlTag('title', sp.title)}${xmlTag('company', sp.company)}</speaker>`);
    }
    parts.push('</speakers>');
    parts.push('</session>');
  }
  parts.push('</sessions>');
  parts.push('</sessions-feed>');

  return c.body(parts.join(''), 200, {
    'content-type': 'application/xml; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
  });
});

// ---------------------------------------------------------------------------
// The five public event pages (sessions, speakers, speaker detail, agenda,
// schedule, gallery) — all SSR + island, same contract as /hello and /submit
// (docs/03 §6): the Worker renders <EventPage> for a fast first paint, then
// /static/event.js hydrates the same tree and each widget fetches its own
// feed client-side. No auth: these routes sit under landingRoutes, mounted
// at '/' with no session gate (docs/03 §4, "public pages are edge-cacheable").
//
// The page shell renders even when agenda_published = 0 — an event that
// exists but hasn't published yet still has a name and a nav; each widget
// stub reports "not published" itself once its feed 404s. Only a genuinely
// unknown slug 404s here.
// ---------------------------------------------------------------------------

interface EventLookupRow {
  name: string;
  slug: string;
}

async function lookupEventBySlug(db: D1Database, slug: string): Promise<EventLookupRow | null> {
  return db.prepare('SELECT name, slug FROM events WHERE slug = ?').bind(slug).first<EventLookupRow>();
}

function renderEventPage(title: string, data: EventPageBootstrap): string {
  return (
    '<!doctype html>' +
    renderToString(
      <Page title={title} clientEntry="/static/event.js" bootstrap={data}>
        <EventPage data={data} />
      </Page>,
    )
  );
}

/**
 * Query-param options for the public pages (lane W3-A, rubric EMB-15). These
 * exist so an organiser can embed or deep-link a *slice* of a page:
 *
 *   ?accent=%23ff0055   brand colour (--accent); `#rgb`/`#rrggbb` only —
 *                       anything else is dropped, since the value lands in a
 *                       stylesheet and must not be able to escape the rule
 *   ?header=0           hide the event name + tab strip (embed chrome)
 *   ?embed=1            embed mode: transparent background + a height
 *                       postMessage to the framing page (see /embed.js)
 *   ?track=<id|name>    sessions / agenda / schedule
 *   ?day=YYYY-MM-DD     sessions / agenda / schedule
 *   ?show_abstract=0    sessions / agenda / schedule — field-visibility (F3/D6)
 *   ?show_speakers=0    sessions / agenda / schedule
 *   ?show_room=0        sessions / agenda / schedule
 *   ?show_track=0       sessions / agenda / schedule
 *   ?font=serif         preset theme token (F3/D5) — allowlisted, see below
 *   ?radius=8           preset theme token, 0-32
 *   ?spacing=roomy       preset theme token
 *   ?muted=%23667        preset theme token, validated hex like accent
 *
 * Filtering itself happens client-side over the same agenda.json payload
 * (packages/ui applyFeedFilter), so the feeds and their cache keys are
 * unchanged and an unknown track simply renders an empty page.
 *
 * Theming (F3/D5) is deliberately NOT free-form CSS: `accent` above is the
 * one colour that was ever allowed to ride raw in a query param, and only
 * because it is regex-validated as a bare hex triple/sextet before it ever
 * touches a stylesheet. `font`/`radius`/`spacing`/`muted` get the identical
 * treatment — a closed allowlist checked here, then mapped to concrete CSS
 * text by fixed lookup tables in packages/ui (EventPage.tsx) that never
 * interpolate the raw param. Anything not in the allowlist is dropped, not
 * echoed back or partially applied.
 */
const ACCENT_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const RADIUS_RE = /^\d{1,2}$/;
const FONT_PRESETS: ReadonlySet<string> = new Set(['sans', 'serif', 'mono']);
const SPACING_PRESETS: ReadonlySet<string> = new Set(['compact', 'cozy', 'roomy']);
const FILTERABLE: ReadonlySet<EventPageKind> = new Set(['sessions', 'agenda', 'schedule']);

/** `?param=0`/`false`/`off` -> explicitly hidden; anything else leaves the field at its default (shown). */
function isOff(value: string | null): boolean {
  return value === '0' || value === 'false' || value === 'off';
}

export function parsePageOptions(url: string, kind: EventPageKind): EventPageOptions | undefined {
  const q = new URL(url).searchParams;
  const options: EventPageOptions = {};

  const accent = (q.get('accent') ?? '').trim();
  if (accent && ACCENT_RE.test(accent)) options.accent = accent;

  const header = q.get('header');
  if (header === '0' || header === 'false' || header === 'off') options.header = false;

  const embed = q.get('embed');
  if (embed === '1' || embed === 'true' || embed === 'on') options.embed = true;

  if (FILTERABLE.has(kind)) {
    const track = (q.get('track') ?? '').trim();
    const day = (q.get('day') ?? '').trim();
    const filter: { track?: string; day?: string } = {};
    if (track) filter.track = track.slice(0, 120);
    if (day && DAY_RE.test(day)) filter.day = day;
    if (filter.track || filter.day) options.filter = filter;

    // Field-visibility toggles (F3/D6): default shown, so `show` is only
    // attached when at least one field was explicitly turned off — a bare
    // page keeps carrying no `options.show` at all, same convention as `filter`.
    const show: EventPageOptions['show'] = {};
    if (isOff(q.get('show_abstract'))) show.abstract = false;
    if (isOff(q.get('show_speakers'))) show.speakers = false;
    if (isOff(q.get('show_room'))) show.room = false;
    if (isOff(q.get('show_track'))) show.track = false;
    if (Object.keys(show).length > 0) options.show = show;
  }

  // Theme tokens (F3/D5): every field validated independently, so an
  // invalid one is dropped without discarding the valid ones alongside it.
  const theme: NonNullable<EventPageOptions['theme']> = {};
  const font = (q.get('font') ?? '').trim();
  if (FONT_PRESETS.has(font)) theme.font = font as 'sans' | 'serif' | 'mono';
  const radiusRaw = (q.get('radius') ?? '').trim();
  if (RADIUS_RE.test(radiusRaw)) {
    const radius = Number(radiusRaw);
    if (radius >= 0 && radius <= 32) theme.radius = radius;
  }
  const spacing = (q.get('spacing') ?? '').trim();
  if (SPACING_PRESETS.has(spacing)) theme.spacing = spacing as 'compact' | 'cozy' | 'roomy';
  const muted = (q.get('muted') ?? '').trim();
  if (muted && ACCENT_RE.test(muted)) theme.muted = muted;
  if (Object.keys(theme).length > 0) options.theme = theme;

  return Object.keys(options).length > 0 ? options : undefined;
}

function eventPageResponse(c: Context<AppEnv>, event: EventLookupRow, kind: EventPageKind, speakerId?: string) {
  const options = parsePageOptions(c.req.url, kind);
  const data: EventPageBootstrap = {
    page: kind,
    event: { name: event.name, slug: event.slug },
    ...(speakerId !== undefined ? { speakerId } : {}),
    ...(options ? { options } : {}),
  };
  const html = renderEventPage(`${event.name} — ${kindTitle(kind)}`, data);
  return c.html(html, 200, {
    'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
    // Framing is the point of these pages (rubric EMB-15): they are the embed
    // targets for /embed.js on an organiser's own site. Stated explicitly, and
    // with no X-Frame-Options alongside it, so nobody has to guess whether the
    // omission was deliberate. The admin SPA (routes/admin.ts) states the
    // opposite — frame-ancestors 'none' — and the CFP wizard already did.
    'content-security-policy': 'frame-ancestors *',
    // Different query strings are different documents (?track=, ?accent=…).
    vary: 'Accept-Encoding',
  });
}

function kindTitle(kind: EventPageKind): string {
  switch (kind) {
    case 'sessions': return 'Sessions';
    case 'speakers': return 'Speakers';
    case 'speaker-detail': return 'Speaker';
    case 'agenda': return 'Agenda';
    case 'schedule': return 'Schedule';
    case 'gallery': return 'Gallery';
  }
}

// The event root. /e/:slug used to 404 while /e/:slug/agenda rendered a full
// site (eval defect) — redirect to the agenda page, which is the natural
// landing and carries the full nav. Query params (accent/header/embed/track/
// day) ride along so a filtered/branded root link keeps its options.
landingRoutes.get('/e/:slug', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  const query = new URL(c.req.url).search;
  return c.redirect(`/e/${encodeURIComponent(event.slug)}/agenda${query}`, 302);
});

landingRoutes.get('/e/:slug/sessions', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'sessions');
});

landingRoutes.get('/e/:slug/speakers', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'speakers');
});

landingRoutes.get('/e/:slug/speakers/:speakerId', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'speaker-detail', c.req.param('speakerId'));
});

landingRoutes.get('/e/:slug/agenda', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'agenda');
});

landingRoutes.get('/e/:slug/schedule', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'schedule');
});

landingRoutes.get('/e/:slug/gallery', async (c) => {
  const event = await lookupEventBySlug(c.env.DB, c.req.param('slug'));
  if (!event) return c.notFound();
  return eventPageResponse(c, event, 'gallery');
});
