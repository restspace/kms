// F4 (workplan 14, Wave A): the speaker portal submission-detail page showed
// format/track/description/participants but never the room/time an accepted
// session had actually been scheduled for — even though starts_at/ends_at/
// room_id already sit on the submission row (the agenda-scheduling endpoint
// in agenda.ts writes them). This pins:
//   1. published agenda + scheduled accepted session -> time + room render;
//   2. accepted but not yet scheduled -> "Scheduling TBC", no time/room;
//   3. non-accepted status -> no scheduling line at all, even if scheduled
//      fields happen to be set (declined-after-scheduling edge case) or the
//      agenda isn't published yet.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { addParticipant, createSubmission } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let cookie: string;
let roomId: string;

beforeEach(async () => {
  slug = `sched-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug, timezone: 'UTC' });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Ada', last_name: 'Lovelace' });
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
  roomId = `room-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, ?, 0)')
    .bind(roomId, eventId, 'Main Hall')
    .run();
});

async function publishAgenda(): Promise<void> {
  await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();
}

async function scheduleSubmission(id: string): Promise<void> {
  await env.DB.prepare(
    'UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ? WHERE id = ?',
  )
    .bind('2026-10-01T14:00:00Z', '2026-10-01T14:30:00Z', roomId, id)
    .run();
}

describe('portal submission detail — scheduling info (F4)', () => {
  it('shows the scheduled time and room when the agenda is published and the session is scheduled', async () => {
    const id = await createSubmission(eventId, { status: 'accepted', title: 'Ada on Engines' });
    await addParticipant(id, speakerId);
    await scheduleSubmission(id);
    await publishAgenda();

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('<dt>When</dt>');
    expect(html).toContain('<dt>Room</dt>');
    expect(html).toContain('Main Hall');
    expect(html).not.toContain('Scheduling TBC');
  });

  it('shows "Scheduling TBC" for an accepted session that has not been scheduled yet', async () => {
    const id = await createSubmission(eventId, { status: 'accepted', title: 'Ada, unscheduled' });
    await addParticipant(id, speakerId);
    await publishAgenda();
    // No scheduleSubmission call: starts_at/ends_at/room_id stay null.

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Scheduling TBC');
    expect(html).not.toContain('Main Hall');
    expect(html).not.toContain('<dt>Room</dt>');
  });

  it('shows nothing scheduling-related for a non-accepted (pending) submission, even if scheduled and published', async () => {
    const id = await createSubmission(eventId, { status: 'pending', title: 'Ada, still pending' });
    await addParticipant(id, speakerId);
    await scheduleSubmission(id);
    await publishAgenda();

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).not.toContain('<dt>When</dt>');
    expect(html).not.toContain('<dt>Room</dt>');
    expect(html).not.toContain('Scheduling TBC');
    expect(html).not.toContain('Main Hall');
  });

  it('shows "Scheduling TBC" for an accepted+scheduled session when the agenda is not yet published', async () => {
    const id = await createSubmission(eventId, { status: 'accepted', title: 'Ada, unpublished agenda' });
    await addParticipant(id, speakerId);
    await scheduleSubmission(id);
    // agenda_published stays 0 (createEvent default) — no publishAgenda() call.

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/submissions/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain('Scheduling TBC');
    expect(html).not.toContain('Main Hall');
    expect(html).not.toContain('<dt>Room</dt>');
  });
});
