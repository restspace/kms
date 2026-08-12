// EMB-15 (major defect): the embed builder's "Sessions list" widget handed
// out the agenda feed URL for every output format. GET /e/:slug/sessions.json
// (and .xml/.ics) is the fix — same published-session payload as agenda.json
// (landing.tsx's `loadAgendaFeed`), under a URL that says what it is. This
// covers the plumbing the admin Embeds screen now points at.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedSubmission } from './fixtures-admin';

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
