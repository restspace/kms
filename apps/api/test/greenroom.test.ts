// Green room / run-of-show routes (workplan 12): revision-first ETag caching,
// the scheduled-session payload, speaker check-in, and the single-speaker
// nudge with day-keyed idempotency.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bumpEventRevision } from '../src/revision';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission, seedTask } from './fixtures-admin';

const getGreenroom = (cookie: string, etag?: string) =>
  SELF.fetch('https://example.com/app/api/greenroom', {
    headers: { cookie, accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  });

async function seedRoom(eventId: string, name = 'Main Stage', position = 0): Promise<string> {
  const id = `room-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, ?, ?)')
    .bind(id, eventId, name, position)
    .run();
  return id;
}

async function addParticipant(submissionId: string, contactId: string, position = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', ?, 1)`,
  ).bind(`sp-${crypto.randomUUID().slice(0, 8)}`, submissionId, contactId, position).run();
}

async function scheduleSubmission(id: string, roomId: string, startsAt: string, endsAt: string): Promise<void> {
  await env.DB.prepare('UPDATE submissions SET room_id = ?, starts_at = ?, ends_at = ? WHERE id = ?')
    .bind(roomId, startsAt, endsAt, id)
    .run();
}

interface GreenRoomBody {
  now: string;
  event: { id: string; timezone: string };
  rooms: Array<{ id: string; name: string }>;
  sessions: Array<{ id: string; room_id: string; starts_at: string; speaker_ids: string[]; track_name: string | null }>;
  speakers: Record<string, {
    name: string; email: string; mobile_phone: string | null; arrived_at: string | null;
    on_roster: boolean; missing_bio: number; missing_headshot: number; missing_slides: number; outstanding: number;
  }>;
}

describe('GET /app/api/greenroom', () => {
  it('answers 304 from the revision alone, and re-issues an ETag after a bump', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await getGreenroom(admin.cookie);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"r/);

    const second = await getGreenroom(admin.cookie, etag!);
    expect(second.status).toBe(304);

    await bumpEventRevision(env, eventId);
    const third = await getGreenroom(admin.cookie, etag!);
    expect(third.status).toBe(200);
    expect(third.headers.get('etag')).not.toBe(etag);
  });

  it('returns scheduled sessions with rooms, speakers, phone and readiness flags', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);
    const speaker = await seedContact(eventId, { email: 'onstage@example.com', first_name: 'Ada', last_name: 'On' });
    await env.DB.prepare('UPDATE contacts SET mobile_phone = ? WHERE id = ?')
      .bind('+1 (555)123-4567', speaker).run();

    const scheduled = await seedSubmission(eventId, { status: 'accepted', title: 'The talk' });
    await scheduleSubmission(scheduled, room, '2026-10-01T16:00:00Z', '2026-10-01T17:00:00Z');
    await addParticipant(scheduled, speaker);
    // Accepted but unscheduled: must not appear on the run of show.
    const unscheduled = await seedSubmission(eventId, { status: 'accepted', title: 'Homeless talk' });
    await addParticipant(unscheduled, speaker);

    // An incomplete file_upload assignment reads as missing slides.
    const slides = await seedTask(eventId, { title: 'Upload slides', action_type: 'file_upload' });
    await env.DB.prepare(
      "INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'not_started')",
    ).bind(`ta-${crypto.randomUUID().slice(0, 8)}`, slides, speaker).run();

    const res = await getGreenroom(admin.cookie);
    const body = (await res.json()) as GreenRoomBody;
    expect(body.rooms).toHaveLength(1);
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({ id: scheduled, room_id: room, speaker_ids: [speaker] });
    expect(body.speakers[speaker]).toMatchObject({
      name: 'Ada On',
      mobile_phone: '+1 (555)123-4567',
      arrived_at: null,
      on_roster: true,
      missing_bio: 1,
      missing_headshot: 1,
      missing_slides: 1,
    });
    expect(body.speakers[speaker].outstanding).toBe(1);
  });

  it('agrees with the dashboard about missing slides (shared helper)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);
    const speaker = await seedContact(eventId, { email: 'parity@example.com', biography: 'Wrote a bio' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await scheduleSubmission(submission, room, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z');
    await addParticipant(submission, speaker);
    const slides = await seedTask(eventId, { title: 'Slides', action_type: 'file_upload' });
    await env.DB.prepare(
      "INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'complete')",
    ).bind(`ta-${crypto.randomUUID().slice(0, 8)}`, slides, speaker).run();

    const green = (await (await getGreenroom(admin.cookie)).json()) as GreenRoomBody;
    const dash = (await (
      await SELF.fetch('https://example.com/app/api/dashboard', { headers: { cookie: admin.cookie } })
    ).json()) as { tracking: { assets: Array<{ contact_id: string }> } };

    // A completed file_upload counts as slides-present on both surfaces; the
    // speaker has a bio but no headshot, so the dashboard's assets list still
    // carries them for the headshot while the green room says slides are in.
    expect(green.speakers[speaker].missing_slides).toBe(0);
    expect(green.speakers[speaker].missing_bio).toBe(0);
    const dashRow = dash.tracking.assets.find((a) => a.contact_id === speaker);
    expect(dashRow).toMatchObject({ missing_slides: 0, missing_bio: 0, missing_headshot: 1 });
  });
});

describe('POST /app/api/greenroom/checkin', () => {
  it('sets and clears arrival, stamping who marked it', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const room = await seedRoom(eventId);
    const speaker = await seedContact(eventId, { email: 'arriving@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await scheduleSubmission(submission, room, '2026-10-01T10:00:00Z', '2026-10-01T11:00:00Z');
    await addParticipant(submission, speaker);

    const before = await getGreenroom(admin.cookie);
    const beforeEtag = before.headers.get('etag');

    const res = await SELF.fetch(
      'https://example.com/app/api/greenroom/checkin',
      jsonReq(admin.cookie, { contact_id: speaker, arrived: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as GreenRoomBody & { ok: boolean; etag: string };
    expect(body.ok).toBe(true);
    expect(body.speakers[speaker].arrived_at).toBeTruthy();
    // The write bumped the revision: the response's etag is fresh.
    expect(body.etag).toMatch(/^"r/);
    expect(body.etag).not.toBe(beforeEtag);

    const row = await env.DB.prepare(
      'SELECT arrived_at, arrival_marked_by FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, speaker).first<{ arrived_at: string | null; arrival_marked_by: string | null }>();
    expect(row?.arrived_at).toBeTruthy();
    expect(row?.arrival_marked_by).toBe(admin.contactId);

    const undo = await SELF.fetch(
      'https://example.com/app/api/greenroom/checkin',
      jsonReq(admin.cookie, { contact_id: speaker, arrived: false }),
    );
    expect(undo.status).toBe(200);
    const cleared = await env.DB.prepare(
      'SELECT arrived_at, arrival_marked_by FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, speaker).first<{ arrived_at: string | null; arrival_marked_by: string | null }>();
    expect(cleared?.arrived_at).toBeNull();
    expect(cleared?.arrival_marked_by).toBeNull();
  });

  it("404s a contact on another event's roster", async () => {
    const mine = await seedEvent();
    const theirs = await seedEvent();
    const admin = await seedStaff(mine, 'admin');
    const foreign = await seedContact(theirs, { email: 'elsewhere@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/greenroom/checkin',
      jsonReq(admin.cookie, { contact_id: foreign, arrived: true }),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /app/api/greenroom/nudge', () => {
  it('sends one reminder per incomplete task and dedupes a same-day repeat', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'nudged@example.com' });
    const slides = await seedTask(eventId, { title: 'Upload slides', action_type: 'file_upload' });
    await env.DB.prepare(
      "INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'not_started')",
    ).bind(`ta-${crypto.randomUUID().slice(0, 8)}`, slides, speaker).run();

    const first = await SELF.fetch(
      'https://example.com/app/api/greenroom/nudge',
      jsonReq(admin.cookie, { contact_id: speaker }),
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, sent: 1, duplicates: 0 });

    const messages = await env.DB.prepare(
      "SELECT idempotency_key FROM message_log WHERE event_id = ? AND template_key = 'task_reminder'",
    ).bind(eventId).all<{ idempotency_key: string }>();
    expect(messages.results).toHaveLength(1);
    // Day-keyed idempotency: the version segment carries the event-local day.
    expect(messages.results[0].idempotency_key).toMatch(/:vmanual-\d{4}-\d{2}-\d{2}$/);

    const second = await SELF.fetch(
      'https://example.com/app/api/greenroom/nudge',
      jsonReq(admin.cookie, { contact_id: speaker }),
    );
    expect(await second.json()).toMatchObject({ ok: true, sent: 0, duplicates: 1 });
  });

  it('400s when the speaker has nothing incomplete', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'done@example.com' });
    const task = await seedTask(eventId, { title: 'Bio', action_type: 'portal_form' });
    await env.DB.prepare(
      "INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'complete')",
    ).bind(`ta-${crypto.randomUUID().slice(0, 8)}`, task, speaker).run();

    const res = await SELF.fetch(
      'https://example.com/app/api/greenroom/nudge',
      jsonReq(admin.cookie, { contact_id: speaker }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'nothing_to_nudge' });
  });

  it('404s a contact from another event', async () => {
    const mine = await seedEvent();
    const theirs = await seedEvent();
    const admin = await seedStaff(mine, 'admin');
    const foreign = await seedContact(theirs, { email: 'other@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/greenroom/nudge',
      jsonReq(admin.cookie, { contact_id: foreign }),
    );
    expect(res.status).toBe(404);
  });
});
