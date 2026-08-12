// Embed surfaces (lane W3-A, rubric EMB-15):
//   GET /embed.js            the cross-origin loader script
//   GET /e/:slug/agenda.xml  the XML mirror of agenda.json
//   framing headers          public pages opt *in*, /app opts out
//
// Storage persists across it() blocks in this pool version, so every event
// slug here is unique per describe and all assertions are scoped to it.

import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { addParticipant, createSubmission } from './fixtures-portal';
import { tokensCss } from '@kms/theme';

/** The light-theme accent, read from the token layer so it cannot go stale. */
const THEME_ACCENT = /:root\{[^}]*?--accent:(#[0-9a-f]{6})/.exec(tokensCss)![1];

const ORIGIN = 'https://kms.test';

async function publishAgenda(eventId: string): Promise<void> {
  await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();
}

async function schedule(submissionId: string, startsAt: string, endsAt: string, roomId?: string, trackId?: string) {
  await env.DB
    .prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ?, track_id = ?, status = ? WHERE id = ?')
    .bind(startsAt, endsAt, roomId ?? null, trackId ?? null, 'accepted', submissionId)
    .run();
}

describe('GET /embed.js', () => {
  it('serves a cacheable, cross-origin-readable loader script', async () => {
    const res = await SELF.fetch(`${ORIGIN}/embed.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    // Third-party pages load it from another origin.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toContain('max-age');
  });

  it('reads its configuration off its own <script> tag and injects an iframe', async () => {
    const js = await (await SELF.fetch(`${ORIGIN}/embed.js`)).text();
    expect(js).toContain('document.currentScript');
    expect(js).toContain("createElement('iframe')");
    expect(js).toContain("d.event");
    expect(js).toContain("d.widget");
    // Every option the admin generator can emit must be honoured here.
    for (const attr of [
      'header',
      'accent',
      'track',
      'day',
      'height',
      'showAbstract',
      'showSpeakers',
      'showRoom',
      'showTrack',
      'font',
      'radius',
      'spacing',
      'muted',
    ]) {
      expect(js).toContain(`d.${attr}`);
    }
    // The embedded page is asked for embed mode and nothing else.
    expect(js).toContain("params.set('embed', '1')");
    expect(js).toContain("'/e/'");
  });

  it('resizes only on same-origin height messages from its own frame', async () => {
    const js = await (await SELF.fetch(`${ORIGIN}/embed.js`)).text();
    expect(js).toContain('kms:embed:height');
    expect(js).toContain('event.origin !== origin');
    expect(js).toContain('event.source !== frame.contentWindow');
  });
});

describe('GET /e/:slug/agenda.xml', () => {
  let eventId: string;
  let slug: string;
  let trackId: string;
  let roomId: string;

  beforeAll(async () => {
    slug = `xml-${crypto.randomUUID().slice(0, 8)}`;
    eventId = await createEvent({ slug, name: 'XML & Friends', timezone: 'UTC' });
    trackId = `trk-${crypto.randomUUID()}`;
    roomId = `room-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(trackId, eventId, 'Platform')
      .run();
    await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(roomId, eventId, 'Main Hall')
      .run();

    const speaker = await createContact(eventId, {
      email: 'xml-speaker@example.com',
      first_name: 'Ada',
      last_name: 'Lovelace',
    });
    const day1 = await createSubmission(eventId, { title: 'Tabs & <Spaces>', code: 'X-1' });
    await schedule(day1, '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', roomId, trackId);
    await addParticipant(day1, speaker);
    const day2 = await createSubmission(eventId, { title: 'Second day talk', code: 'X-2' });
    await schedule(day2, '2026-10-02T09:00:00.000Z', '2026-10-02T10:00:00.000Z', roomId);
  });

  it('404s (as XML) until the agenda is published', async () => {
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('xml');
    expect(await res.text()).toContain('not_found');
  });

  it('404s for an unknown slug', async () => {
    const res = await SELF.fetch(`${ORIGIN}/e/no-such-event/agenda.xml`);
    expect(res.status).toBe(404);
  });

  it('serves well-formed XML over the same sessions as agenda.json once published', async () => {
    await publishAgenda(eventId);
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();

    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain(`<slug>${slug}</slug>`);
    // Markup and ampersands in organiser text are escaped, not emitted raw.
    expect(xml).toContain('<name>XML &amp; Friends</name>');
    expect(xml).toContain('<title>Tabs &amp; &lt;Spaces&gt;</title>');
    expect(xml).not.toContain('<Spaces>');
    expect(xml).toContain('<room id=');
    expect(xml).toContain('Main Hall');
    expect(xml).toContain('<speaker><name>Ada Lovelace</name></speaker>');
    expect(xml).toContain('<day>2026-10-01</day>');
    expect(xml).toContain('<day>2026-10-02</day>');

    // Every element opened is closed, in order — a cheap well-formedness proof
    // in a runtime with no XML parser of its own.
    const stack: string[] = [];
    for (const m of xml.matchAll(/<(\/?)([a-z_]+)([^>]*?)(\/?)>/g)) {
      const [, closing, name, , selfClosing] = m;
      if (name === 'xml') continue;
      if (closing) expect(stack.pop()).toBe(name);
      else if (!selfClosing) stack.push(name as string);
    }
    expect(stack).toEqual([]);

    // The JSON feed and the XML feed describe the same session set.
    const json = (await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.json`)).json()) as {
      sessions: { id: string }[];
    };
    for (const s of json.sessions) expect(xml).toContain(`<session id="${s.id}">`);
    expect(xml.match(/<session id=/g)?.length).toBe(json.sessions.length);
  });

  it('honours ?track= by id and by name, and ?day=', async () => {
    await publishAgenda(eventId);
    const byId = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml?track=${trackId}`)).text();
    expect(byId).toContain('X-1');
    expect(byId).not.toContain('X-2');

    const byName = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml?track=platform`)).text();
    expect(byName).toContain('X-1');
    expect(byName).not.toContain('X-2');

    const byDay = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml?day=2026-10-02`)).text();
    expect(byDay).toContain('X-2');
    expect(byDay).not.toContain('X-1');

    const nonsense = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml?track=nope`)).text();
    expect(nonsense).toContain('<sessions></sessions>');
  });

  it('honours ?track= by readable slug (what generated embed links now carry)', async () => {
    // A multi-word, punctuated name whose slug differs from its lowercase
    // form — "data-ai" only matches through the slug rule, not name equality.
    const slugEvent = `xmlslug-${crypto.randomUUID().slice(0, 8)}`;
    const slugEventId = await createEvent({ slug: slugEvent, timezone: 'UTC' });
    const aiTrack = `trk-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(aiTrack, slugEventId, 'Data & AI')
      .run();
    const talk = await createSubmission(slugEventId, { title: 'Vectors', code: 'AI-1' });
    await schedule(talk, '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', undefined, aiTrack);
    const other = await createSubmission(slugEventId, { title: 'Untracked', code: 'AI-2' });
    await schedule(other, '2026-10-01T11:00:00.000Z', '2026-10-01T12:00:00.000Z');
    await publishAgenda(slugEventId);

    const bySlug = await (await SELF.fetch(`${ORIGIN}/e/${slugEvent}/agenda.xml?track=data-ai`)).text();
    expect(bySlug).toContain('AI-1');
    expect(bySlug).not.toContain('AI-2');
    // UUID links generated before the slug change keep working.
    const byUuid = await (await SELF.fetch(`${ORIGIN}/e/${slugEvent}/agenda.xml?track=${aiTrack}`)).text();
    expect(byUuid).toContain('AI-1');
    expect(byUuid).not.toContain('AI-2');
  });

  it('sessions.xml honours the same ?track= / ?day= filters as agenda.xml', async () => {
    await publishAgenda(eventId);
    const byName = await (await SELF.fetch(`${ORIGIN}/e/${slug}/sessions.xml?track=platform`)).text();
    expect(byName).toContain('X-1');
    expect(byName).not.toContain('X-2');
    const byDay = await (await SELF.fetch(`${ORIGIN}/e/${slug}/sessions.xml?day=2026-10-02`)).text();
    expect(byDay).toContain('X-2');
    expect(byDay).not.toContain('X-1');
  });
});

// AIA-08: an auto-placed session is provisional. It has a time and a room, so
// every "is it scheduled?" predicate would happily publish it — the XML mirror
// has to exclude it exactly like agenda.json does, or a slot nobody confirmed
// shows up on somebody's website.
describe('GET /e/:slug/agenda.xml — pencilled placements stay private', () => {
  it('hides an unconfirmed auto-placement and publishes it once confirmed', async () => {
    const slug = `xml-pencil-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug, timezone: 'UTC' });
    const roomId = `room-${crypto.randomUUID()}`;
    await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(roomId, eventId, 'Main Hall')
      .run();
    const speaker = await createContact(eventId, {
      email: `pencil-speaker-${crypto.randomUUID().slice(0, 8)}@example.com`,
      first_name: 'Grace',
      last_name: 'Hopper',
    });
    const sessionId = await createSubmission(eventId, { title: 'Provisionally Placed', code: 'P-1' });
    await schedule(sessionId, '2026-10-01T09:00:00.000Z', '2026-10-01T10:00:00.000Z', roomId);
    await addParticipant(sessionId, speaker);
    await env.DB.prepare('UPDATE submissions SET pencilled_at = ? WHERE id = ?')
      .bind('2026-08-12T10:00:00.000Z', sessionId)
      .run();
    await publishAgenda(eventId);

    const hidden = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml`)).text();
    expect(hidden).not.toContain('Provisionally Placed');
    expect(hidden).not.toContain('Grace Hopper');

    // Confirming is what `POST /agenda/confirm-placements` does to the row.
    await env.DB.prepare('UPDATE submissions SET pencilled_at = NULL WHERE id = ?').bind(sessionId).run();
    const shown = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda.xml`)).text();
    expect(shown).toContain('Provisionally Placed');
    expect(shown).toContain('Grace Hopper');
  });
});

describe('framing headers', () => {
  let slug: string;

  beforeAll(async () => {
    slug = `frame-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    await publishAgenda(eventId);
  });

  const PAGES = ['sessions', 'speakers', 'agenda', 'schedule', 'gallery'];

  it('lets every public event page be framed cross-origin', async () => {
    for (const path of PAGES) {
      const res = await SELF.fetch(`${ORIGIN}/e/${slug}/${path}`);
      expect(res.status).toBe(200);
      // No X-Frame-Options at all, and a CSP that explicitly permits framing.
      expect(res.headers.get('x-frame-options')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBe('frame-ancestors *');
    }
  });

  it('keeps the admin SPA un-frameable', async () => {
    // The public pages opting in must not have quietly opted /app in too.
    const eventId = await createEvent({ slug: `frame-admin-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await createContact(eventId, { email: 'frame-admin@example.com' });
    await createEventUser(eventId, admin, 'admin');
    const cookie = await sessionCookieFor({ contactId: admin, eventId, role: 'admin' });
    const res = await SELF.fetch(`${ORIGIN}/app`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

describe('public page query parameters', () => {
  let slug: string;

  beforeAll(async () => {
    slug = `params-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    await publishAgenda(eventId);
  });

  it('carries accent/header/embed/track/day into the bootstrap', async () => {
    const res = await SELF.fetch(
      `${ORIGIN}/e/${slug}/agenda?accent=%23ff0055&header=0&embed=1&track=Platform&day=2026-10-01`,
    );
    const html = await res.text();
    expect(html).toContain('"accent":"#ff0055"');
    expect(html).toContain('"header":false');
    expect(html).toContain('"embed":true');
    expect(html).toContain('"track":"Platform"');
    expect(html).toContain('"day":"2026-10-01"');
    // Embed mode ships the height reporter and drops the event header/nav.
    expect(html).toContain('kms:embed:height');
    expect(html).toContain(':root{--accent:#ff0055;}');
    // The class name also occurs in the shell stylesheet — assert on the element.
    expect(html).not.toContain('aria-label="Event sections"');
  });

  it('falls back to the theme accent when the host supplies none', async () => {
    // Widgets render on customers' own sites and must keep taking the host's
    // colour (asserted above). With no data-accent, the frame inherits the
    // app's own accent from the shared token layer rather than a second
    // hardcoded default that could drift from it.
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?embed=1`);
    const html = await res.text();
    expect(html).not.toContain(':root{--accent:');
    expect(html).toContain(`--accent:${THEME_ACCENT}`);
  });

  it('drops an accent that is not a plain hex colour, so nothing escapes the CSS rule', async () => {
    const res = await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?accent=red;}body{display:none`);
    const html = await res.text();
    expect(html).not.toContain('display:none');
    expect(html).not.toContain('"accent"');
  });

  it('ignores a malformed day and page-level filters on non-filterable pages', async () => {
    const bad = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?day=tomorrow`)).text();
    expect(bad).not.toContain('"day"');
    const speakers = await (await SELF.fetch(`${ORIGIN}/e/${slug}/speakers?track=Platform`)).text();
    expect(speakers).not.toContain('"track"');
  });

  it('renders the plain page unchanged when no parameters are given', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda`)).text();
    expect(html).not.toContain('"options"');
    expect(html).toContain('aria-label="Event sections"');
  });

  it('carries field-visibility toggles into the bootstrap, defaulting to shown', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?show_abstract=0&show_speakers=0&show_room=0&show_track=0`)
    ).text();
    expect(html).toContain('"show":{"abstract":false,"speakers":false,"room":false,"track":false}');
  });

  it('omits `show` entirely when every toggle is left at its default', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda`)).text();
    expect(html).not.toContain('"show"');
  });

  it('ignores field-visibility toggles on a non-filterable page', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/speakers?show_abstract=0`)).text();
    expect(html).not.toContain('"show"');
  });

  it('accepts allowlisted theme tokens and drops everything else', async () => {
    const html = await (
      await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?font=serif&radius=8&spacing=roomy&muted=%23667788`)
    ).text();
    expect(html).toContain('"theme":{"font":"serif","radius":8,"spacing":"roomy","muted":"#667788"}');
    expect(html).toContain('--font-ui:');
    expect(html).toContain('--radius:8px;');
    expect(html).toContain('--text-muted:#667788;');
  });

  it('rejects a font not in the preset list', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?font=ComicSans`)).text();
    // Trailing colon: the JSON key form, not the substring "font" that also
    // appears (unquoted) inside CSS property names like font-family.
    expect(html).not.toContain('"font":');
    expect(html).not.toContain('ComicSans');
  });

  it('rejects a spacing preset not on the allowlist', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?spacing=huge`)).text();
    expect(html).not.toContain('"spacing":');
  });

  it('rejects an out-of-range or non-numeric radius', async () => {
    const tooBig = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?radius=999`)).text();
    expect(tooBig).not.toContain('"radius":');
    const nonNumeric = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?radius=8px;}body{display:none`)).text();
    expect(nonNumeric).not.toContain('"radius":');
    expect(nonNumeric).not.toContain('display:none');
  });

  it('rejects a muted colour that is not a plain hex, so nothing escapes the CSS rule', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?muted=red;}body{display:none`)).text();
    // Trailing colon: the JSON key form, not the substring `"muted"` that also
    // appears (as an unrelated CSS class) in `<p class="muted">`.
    expect(html).not.toContain('"muted":');
    expect(html).not.toContain('display:none');
  });

  it('keeps only the valid theme tokens when the request mixes good and bad ones', async () => {
    const html = await (await SELF.fetch(`${ORIGIN}/e/${slug}/agenda?font=serif&spacing=bogus&radius=1000`)).text();
    expect(html).toContain('"theme":{"font":"serif"}');
  });
});
