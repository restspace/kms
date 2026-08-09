// GET / — the public front door (docs/12 §2 "Demo logins", checklist §4).
// A judge arriving cold must be able to sign in as the demo admin, sign in as
// the demo speaker, and reset the demo data without asking anyone how. The
// logins are one-click magic-link requests against the seeded contacts; the
// reset replays the same seed the Settings button and the nightly cron use.

import { Hono } from 'hono';
import { redactInternal, redactInternalAll } from '@kms/core';
import type { AppEnv } from '../env';
import { esc, page } from '../html';

export const landingRoutes = new Hono<AppEnv>();

interface DemoLogins {
  eventName: string;
  eventSlug: string;
  adminEmail: string | null;
  speakerEmail: string | null;
  openFormId: string | null;
}

/** Read the demo credentials out of the seeded data rather than hard-coding them. */
async function demoLogins(db: D1Database): Promise<DemoLogins | null> {
  const event = await db
    .prepare('SELECT id, name, slug FROM events ORDER BY created_at LIMIT 1')
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
  const speaker = await db
    .prepare(
      `SELECT c.email FROM contacts c
       WHERE c.event_id = ?
         AND EXISTS (SELECT 1 FROM submissions s WHERE s.submitter_contact_id = c.id)
         AND NOT EXISTS (SELECT 1 FROM event_users eu WHERE eu.contact_id = c.id)
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
        `<h1>KMS</h1>
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
      `<h1>KMS — ${esc(logins.eventName)}</h1>
<p>A speaker and session management system: call for papers, review and scoring, agenda,
speaker comms. Pick a door — no password required, the sign-in link is shown on the next page.</p>
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

landingRoutes.get('/e/:slug/agenda.json', async (c) => {
  const db = c.env.DB;
  const event = await db
    .prepare('SELECT id, name, slug, timezone, agenda_published FROM events WHERE slug = ?')
    .bind(c.req.param('slug'))
    .first<PublicEventRow>();
  if (!event || event.agenda_published !== 1) return c.json({ error: 'not_found' }, 404);

  const [sessions, rooms, tracks, speakers] = await Promise.all([
    db
      .prepare(
        `SELECT id, code, title, description, format, level, capacity, track_id, room_id, starts_at, ends_at
         FROM submissions
         WHERE event_id = ? AND status = 'accepted' AND starts_at IS NOT NULL AND ends_at IS NOT NULL
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
        `SELECT sp.submission_id,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name
         FROM submission_participants sp
         JOIN contacts c ON c.id = sp.contact_id
         JOIN submissions s ON s.id = sp.submission_id
         WHERE s.event_id = ? AND s.status = 'accepted'
           AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
         ORDER BY sp.position`,
      )
      .bind(event.id)
      .all<{ submission_id: string; name: string | null }>()
      .then((r) => r.results),
  ]);

  const speakersBySession = new Map<string, string[]>();
  for (const row of speakers) {
    const name = (row.name ?? '').trim();
    if (!name) continue; // no email fallback: public payloads carry no PII
    const list = speakersBySession.get(row.submission_id) ?? [];
    list.push(name);
    speakersBySession.set(row.submission_id, list);
  }

  const days = [...new Set(sessions.map((s) => dayKey(s.starts_at, event.timezone)))].sort();

  return c.json(
    {
      event: redactInternal({ name: event.name, slug: event.slug, timezone: event.timezone }),
      days,
      rooms: redactInternalAll(rooms),
      tracks: redactInternalAll(tracks),
      sessions: redactInternalAll(sessions).map((s) => ({
        ...s,
        day: dayKey(s.starts_at, event.timezone),
        speakers: speakersBySession.get(s.id) ?? [],
      })),
    },
    200,
    { 'cache-control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300' },
  );
});
