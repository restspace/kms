// Rooms & tracks CRUD (deferred-gap item): the tables existed with event_id +
// position but were only ever SELECTed — a freshly created event offered
// nothing but "No room" / "No track" in the agenda builder's Add Session
// dialog. Mirrors the tasks-CRUD test shape in adminapi-crud.test.ts.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('rooms CRUD', () => {
  it('creates, lists, renames and deletes a room, auto-assigning position', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await api('/rooms', admin.cookie, { name: 'Hall A', capacity: 200 });
    expect(first.status).toBe(201);
    const firstRow = (await first.json()) as Record<string, unknown>;
    expect(firstRow).toMatchObject({ name: 'Hall A', capacity: 200, position: 0, event_id: eventId });

    const second = await api('/rooms', admin.cookie, { name: 'Hall B' });
    const secondRow = (await second.json()) as Record<string, unknown>;
    expect(secondRow).toMatchObject({ name: 'Hall B', capacity: null, position: 1 });

    const list = await SELF.fetch('https://example.com/app/api/rooms', { headers: { cookie: admin.cookie } });
    const { items } = (await list.json()) as { items: Array<{ name: string }> };
    expect(items.map((r) => r.name)).toEqual(['Hall A', 'Hall B']);

    const renamed = await api(`/rooms/${firstRow.id}`, admin.cookie, { name: 'Main Hall', capacity: 250 }, 'PUT');
    expect(await renamed.json()).toMatchObject({ name: 'Main Hall', capacity: 250 });

    const deleted = await api(`/rooms/${firstRow.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/rooms/${firstRow.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('rejects an empty name', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/rooms', admin.cookie, { name: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name_required' });
  });

  it('rejects a negative capacity', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/rooms', admin.cookie, { name: 'Hall', capacity: -5 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_capacity' });
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await api('/rooms', reviewer.cookie, { name: 'Hall A' });
    expect(res.status).toBe(403);
  });

  it('deleting a room nulls the reference on sessions scheduled in it, not the session', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const room = await api('/rooms', admin.cookie, { name: 'Hall A' });
    const { id: roomId } = (await room.json()) as { id: string };
    await env.DB.prepare('UPDATE submissions SET room_id = ? WHERE id = ?').bind(roomId, submissionId).run();

    const deleted = await api(`/rooms/${roomId}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);

    const row = await env.DB.prepare('SELECT room_id FROM submissions WHERE id = ?').bind(submissionId).first<{ room_id: string | null }>();
    expect(row?.room_id).toBeNull();
    const submissionStillThere = await env.DB.prepare('SELECT id FROM submissions WHERE id = ?').bind(submissionId).first();
    expect(submissionStillThere).toBeTruthy();
  });

  it('scopes rooms to the event — another event cannot rename or delete them', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');

    const created = await api('/rooms', adminA.cookie, { name: 'Hall A' });
    const { id: roomId } = (await created.json()) as { id: string };

    expect((await api(`/rooms/${roomId}`, adminB.cookie, { name: 'Hijacked' }, 'PUT')).status).toBe(404);
    expect((await api(`/rooms/${roomId}`, adminB.cookie, undefined, 'DELETE')).status).toBe(404);

    const list = await SELF.fetch('https://example.com/app/api/rooms', { headers: { cookie: adminB.cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('tracks CRUD', () => {
  it('creates, lists, renames and deletes a track, auto-assigning position', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await api('/tracks', admin.cookie, { name: 'Frontend', color: '#2563eb' });
    expect(first.status).toBe(201);
    const firstRow = (await first.json()) as Record<string, unknown>;
    expect(firstRow).toMatchObject({ name: 'Frontend', color: '#2563eb', position: 0 });

    const second = await api('/tracks', admin.cookie, { name: 'Backend' });
    const secondRow = (await second.json()) as Record<string, unknown>;
    expect(secondRow).toMatchObject({ name: 'Backend', color: null, position: 1 });

    const renamed = await api(`/tracks/${firstRow.id}`, admin.cookie, { name: 'Platform' }, 'PUT');
    expect(await renamed.json()).toMatchObject({ name: 'Platform', color: '#2563eb' });

    const deleted = await api(`/tracks/${firstRow.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/tracks/${firstRow.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('deleting a track nulls submissions.track_id and clears submission_tracks rows', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const track = await api('/tracks', admin.cookie, { name: 'Frontend' });
    const { id: trackId } = (await track.json()) as { id: string };
    await env.DB.prepare('UPDATE submissions SET track_id = ? WHERE id = ?').bind(trackId, submissionId).run();
    await env.DB.prepare('INSERT INTO submission_tracks (submission_id, track_id) VALUES (?, ?)').bind(submissionId, trackId).run();

    const deleted = await api(`/tracks/${trackId}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);

    const row = await env.DB.prepare('SELECT track_id FROM submissions WHERE id = ?').bind(submissionId).first<{ track_id: string | null }>();
    expect(row?.track_id).toBeNull();
    const junction = await env.DB.prepare('SELECT * FROM submission_tracks WHERE track_id = ?').bind(trackId).first();
    expect(junction).toBeNull();
  });

  it('rejects an empty name', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tracks', admin.cookie, { name: '' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name_required' });
  });
});

describe('POST /app/api/events with rooms + tracks', () => {
  it('creates the event and its rooms/tracks in one batch', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const slug = `evt-with-rooms-${crypto.randomUUID().slice(0, 8)}`;

    const res = await api('/events', admin.cookie, {
      name: 'DevFlow 2027',
      slug,
      starts_at: '2027-05-01T09:00:00Z',
      ends_at: '2027-05-02T18:00:00Z',
      rooms: [{ name: 'Hall A', capacity: 300 }, { name: '  ' }, { name: 'Hall B' }],
      tracks: [{ name: 'Frontend', color: '#f59e0b' }, { name: 'Backend' }],
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const rooms = await env.DB.prepare('SELECT name, capacity, position FROM rooms WHERE event_id = ? ORDER BY position').bind(id).all();
    expect(rooms.results).toEqual([
      { name: 'Hall A', capacity: 300, position: 0 },
      { name: 'Hall B', capacity: null, position: 1 },
    ]);

    const tracks = await env.DB.prepare('SELECT name, color, position FROM tracks WHERE event_id = ? ORDER BY position').bind(id).all();
    expect(tracks.results).toEqual([
      { name: 'Frontend', color: '#f59e0b', position: 0 },
      { name: 'Backend', color: null, position: 1 },
    ]);
  });

  it('a fresh room is immediately usable on the Add Session path (invalid_room otherwise)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const room = await api('/rooms', admin.cookie, { name: 'Hall A' });
    const { id: roomId } = (await room.json()) as { id: string };

    const session = await api('/agenda/sessions', admin.cookie, { title: 'Opening Keynote', room_id: roomId });
    expect(session.status).toBe(201);
    const body = (await session.json()) as { ok: boolean; rooms: Array<{ id: string; name: string }> };
    expect(body.rooms.map((r) => r.id)).toContain(roomId);
  });
});

// Replay defect #3's back door: the SPA's Settings card mutates through
// /agenda/rooms|tracks (which record settings history), but these legacy
// routes stayed mutation-capable with no history — an external/API caller
// could change the lists without leaving a trail. They now batch the same
// pre-edit 'settings' content_revisions snapshot as the agenda routes.
describe('legacy rooms/tracks mutations record settings history', () => {
  const settingsRevisions = async (eventId: string) => {
    const { results } = await env.DB
      .prepare(
        `SELECT payload FROM content_revisions
         WHERE event_id = ? AND entity_type = 'settings' AND entity_id = ?
         ORDER BY edited_at, id`,
      )
      .bind(eventId, eventId)
      .all<{ payload: string }>();
    return results.map((r) => JSON.parse(r.payload) as Record<string, unknown>);
  };

  it('room add / rename / delete each snapshot the pre-edit lists', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/rooms', admin.cookie, { name: 'Main Hall', capacity: 120 });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { id: string };
    let revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(1);
    expect(revs[0]).toEqual({ rooms: null, tracks: null });

    const renamed = await api(`/rooms/${room.id}`, admin.cookie, { name: 'Great Hall' }, 'PUT');
    expect(renamed.status).toBe(200);
    revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(2);
    expect(revs[1]?.rooms).toBe('Main Hall (capacity 120)');

    // An unchanged write records nothing (same discipline as the agenda PUT).
    const noop = await api(`/rooms/${room.id}`, admin.cookie, { name: 'Great Hall' }, 'PUT');
    expect(noop.status).toBe(200);
    expect((await settingsRevisions(eventId)).length).toBe(2);

    const deleted = await api(`/rooms/${room.id}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);
    revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(3);
    expect(revs[2]?.rooms).toBe('Great Hall (capacity 120)');

    // A 404 delete leaves no phantom history row.
    expect((await api(`/rooms/${room.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
    expect((await settingsRevisions(eventId)).length).toBe(3);
  });

  it('track add and delete record history too', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/tracks', admin.cookie, { name: 'AI', color: 'green' });
    expect(created.status).toBe(201);
    const track = (await created.json()) as { id: string };

    const deleted = await api(`/tracks/${track.id}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);

    const revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(2);
    expect(revs[0]?.tracks).toBeNull();
    expect(revs[1]?.tracks).toBe('AI (green)');
  });
});
