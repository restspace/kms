// EMB-15 (major defect): the embed builder's "Sessions list" widget handed
// out the agenda feed URL for every output format. GET /e/:slug/sessions.json
// (and .xml/.ics) is the fix — same published-session payload as agenda.json
// (landing.tsx's `loadAgendaFeed`), under a URL that says what it is. This
// covers the plumbing the admin Embeds screen now points at.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

async function seedPublishedSession(eventId: string): Promise<string> {
  await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();

  const roomId = `room-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, capacity, position) VALUES (?, ?, ?, ?, 0)')
    .bind(roomId, eventId, 'Main Stage', 200)
    .run();

  const sessionId = await seedSubmission(eventId, { status: 'accepted', title: 'Streaming Function Calls' });
  await env.DB.prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ? WHERE id = ?')
    .bind('2026-10-01T17:00:00.000Z', '2026-10-01T17:30:00.000Z', roomId, sessionId)
    .run();

  const speakerId = await seedContact(eventId, { first_name: 'Ada', last_name: 'Lovelace' });
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, 1)`,
  ).bind(`sp-${crypto.randomUUID()}`, sessionId, speakerId).run();

  return sessionId;
}

describe('GET /e/:slug/sessions.json', () => {
  it('returns the published session (same shape as agenda.json) under the sessions URL', async () => {
    const eventId = await seedEvent({ slug: `sessfeed-${crypto.randomUUID().slice(0, 8)}` });
    await seedPublishedSession(eventId);
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}/sessions.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: { title: string; speakers: string[] }[] };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]?.title).toBe('Streaming Function Calls');
    expect(body.sessions[0]?.speakers).toEqual(['Ada Lovelace']);
  });

  it('lists every day the event spans, including a day with zero sessions scheduled yet', async () => {
    // Default seedEvent span is 2026-10-01T08:00Z .. 2026-10-02T18:00Z (UTC
    // timezone) — two calendar days — but the only session seeded below lands
    // on the first day. `days` must still report both, not just the one with
    // a session on it.
    const eventId = await seedEvent({ slug: `sessfeed-days-${crypto.randomUUID().slice(0, 8)}` });
    await seedPublishedSession(eventId);
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}/sessions.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { days: string[] };
    expect(body.days).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('404s when the agenda is not published, same as agenda.json', async () => {
    const eventId = await seedEvent({ slug: `sessfeed-unpub-${crypto.randomUUID().slice(0, 8)}` });
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}/sessions.json`);
    expect(res.status).toBe(404);
  });
});

describe('GET /e/:slug (event root)', () => {
  it('redirects to the agenda page instead of 404ing, preserving the query string', async () => {
    const eventId = await seedEvent({ slug: `root-${crypto.randomUUID().slice(0, 8)}` });
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}?track=platform`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/e/${slug}/agenda?track=platform`);
  });

  it('404s for an unknown slug', async () => {
    const res = await SELF.fetch('https://example.com/e/no-such-event', { redirect: 'manual' });
    expect(res.status).toBe(404);
  });
});

describe('GET /e/:slug/sessions.xml and sessions.ics', () => {
  it('returns well-formed XML with the session title', async () => {
    const eventId = await seedEvent({ slug: `sessxml-${crypto.randomUUID().slice(0, 8)}` });
    await seedPublishedSession(eventId);
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}/sessions.xml`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const text = await res.text();
    expect(text).toContain('<sessions-feed');
    expect(text).toContain('Streaming Function Calls');
  });

  it('returns a VCALENDAR with the session as a VEVENT, filename says sessions', async () => {
    const eventId = await seedEvent({ slug: `sessics-${crypto.randomUUID().slice(0, 8)}` });
    await seedPublishedSession(eventId);
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const res = await SELF.fetch(`https://example.com/e/${slug}/sessions.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`${slug}-sessions.ics`);
    const text = await res.text();
    expect(text).toContain('BEGIN:VEVENT');
    expect(text).toContain('SUMMARY:Streaming Function Calls');
  });
});

// AIA-08: the auto-schedule assistant writes real times and rooms, so every
// public feed's "scheduled" predicate would publish its guesses. `pencilled_at`
// is the extra condition that keeps a provisional slot off the website (and
// out of the bulk invite send) until an organiser confirms it.
describe('pencilled auto-placements are excluded from every public feed', () => {
  it('hides the session from agenda.json, sessions.json, speakers.json and the ICS until confirmed', async () => {
    const eventId = await seedEvent({ slug: `pencil-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await seedStaff(eventId, 'admin');
    await seedPublishedSession(eventId); // the confirmed one — always visible
    const slug = (await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>())!.slug;

    const roomId = (await env.DB.prepare('SELECT id FROM rooms WHERE event_id = ?').bind(eventId).first<{ id: string }>())!.id;
    const pencilled = await seedSubmission(eventId, { status: 'accepted', title: 'Pencilled In Talk' });
    await env.DB
      .prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ?, pencilled_at = ? WHERE id = ?')
      .bind('2026-10-01T18:00:00.000Z', '2026-10-01T18:30:00.000Z', roomId, '2026-08-12T10:00:00.000Z', pencilled)
      .run();
    const speakerId = await seedContact(eventId, { first_name: 'Grace', last_name: 'Hopper' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, pencilled, speakerId).run();

    const titlesOf = async (path: string) => {
      const body = (await (await SELF.fetch(`https://example.com/e/${slug}/${path}`)).json()) as {
        sessions: { title: string }[];
      };
      return body.sessions.map((s) => s.title);
    };
    const speakerNames = async () => {
      const body = (await (await SELF.fetch(`https://example.com/e/${slug}/speakers.json`)).json()) as {
        speakers: { name: string }[];
      };
      return body.speakers.map((s) => s.name);
    };

    expect(await titlesOf('agenda.json')).toEqual(['Streaming Function Calls']);
    expect(await titlesOf('sessions.json')).toEqual(['Streaming Function Calls']);
    expect(await speakerNames()).toEqual(['Ada Lovelace']);
    const ics = await (await SELF.fetch(`https://example.com/e/${slug}/agenda.ics`)).text();
    expect(ics).not.toContain('Pencilled In Talk');

    // The invite send ignores it too — nobody is emailed about a guess.
    const send = await SELF.fetch(
      'https://example.com/app/api/agenda/send-confirmations',
      jsonReq(admin.cookie, {}),
    );
    expect(send.status).toBe(202);
    expect(((await send.json()) as { sent_sessions: number }).sent_sessions).toBe(1);

    // Confirm, and the same session becomes public with no other change.
    const confirm = await SELF.fetch(
      'https://example.com/app/api/agenda/confirm-placements',
      jsonReq(admin.cookie, {}),
    );
    expect(confirm.status).toBe(200);
    expect(((await confirm.json()) as { confirmed: number }).confirmed).toBe(1);

    expect(await titlesOf('agenda.json')).toContain('Pencilled In Talk');
    expect(await titlesOf('sessions.json')).toContain('Pencilled In Talk');
    expect(await speakerNames()).toContain('Grace Hopper');
    expect(await (await SELF.fetch(`https://example.com/e/${slug}/agenda.ics`)).text()).toContain('Pencilled In Talk');
  });
});
