// Settings-history recording for room/track edits (eval defect: after adding
// a room, adding a track and deleting a room, the Settings history panel still
// read "No settings edits recorded"). The mutation surface the Settings card
// calls now lives at /app/api/agenda/rooms|tracks and batches one 'settings'
// content_revisions row (pre-edit rooms+tracks snapshot) with every change —
// which is exactly what GET /app/api/events/:id/revisions lists. The room
// DELETE additionally hands back an undo payload, and POST /rooms/:id/restore
// is the Undo toast's way back.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (cookie: string, path: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

interface RevisionRow {
  entity_type: string;
  payload: string;
  edited_by: string | null;
  source: string;
}

const settingsRevisions = async (eventId: string): Promise<Array<RevisionRow & { fields: Record<string, unknown> }>> => {
  const { results } = await env.DB
    .prepare(
      `SELECT entity_type, payload, edited_by, source FROM content_revisions
       WHERE event_id = ? AND entity_type = 'settings' AND entity_id = ?
       ORDER BY edited_at, id`,
    )
    .bind(eventId, eventId)
    .all<RevisionRow>();
  return results.map((r) => ({ ...r, fields: JSON.parse(r.payload) as Record<string, unknown> }));
};

describe('rooms/tracks mutations record settings history', () => {
  it('room add / rename / delete each snapshot the pre-edit lists', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    // Add — the pre-edit snapshot is an empty board.
    const created = await api(admin.cookie, '/agenda/rooms', { name: 'Main Hall', capacity: 120 });
    expect(created.status).toBe(201);
    const room = (await created.json()) as { id: string; name: string };
    let revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(1);
    expect(revs[0]?.fields).toEqual({ rooms: null, tracks: null });
    expect(revs[0]?.edited_by).toBe(admin.contactId);

    // Rename — the snapshot carries the OLD name (and the capacity).
    const renamed = await api(admin.cookie, `/agenda/rooms/${room.id}`, { name: 'Great Hall' }, 'PUT');
    expect(renamed.status).toBe(200);
    revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(2);
    expect(revs[1]?.fields.rooms).toBe('Main Hall (capacity 120)');

    // A no-op blur write (same name) records nothing.
    const noop = await api(admin.cookie, `/agenda/rooms/${room.id}`, { name: 'Great Hall' }, 'PUT');
    expect(noop.status).toBe(200);
    expect((await settingsRevisions(eventId)).length).toBe(2);

    // Delete — snapshot carries the room as it was just before it vanished.
    const deleted = await api(admin.cookie, `/agenda/rooms/${room.id}`, undefined, 'DELETE');
    expect(deleted.status).toBe(200);
    revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(3);
    expect(revs[2]?.fields.rooms).toBe('Great Hall (capacity 120)');

    // And the panel's own listing endpoint serves all three rows.
    const listed = await api(admin.cookie, `/events/${eventId}/revisions`, undefined, 'GET');
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: Array<{ fields: Record<string, unknown> }> };
    expect(items.length).toBe(3);
  });

  it('track add and delete record history too', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api(admin.cookie, '/agenda/tracks', { name: 'AI', color: 'green' });
    expect(created.status).toBe(201);
    const track = (await created.json()) as { id: string };

    const deleted = await api(admin.cookie, `/agenda/tracks/${track.id}`, undefined, 'DELETE');
    expect(deleted.status).toBe(200);

    const revs = await settingsRevisions(eventId);
    expect(revs.length).toBe(2);
    expect(revs[0]?.fields.tracks).toBeNull();
    expect(revs[1]?.fields.tracks).toBe('AI (green)');
  });

  it('reviewers cannot mutate rooms through the agenda surface', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await api(reviewer.cookie, '/agenda/rooms', { name: 'Sneaky' });
    // The /app/api guard already refuses reviewers outside their surface.
    expect([401, 403]).toContain(res.status);
  });
});

describe('room delete safety: usage count, undo payload, restore', () => {
  /** A room plus one accepted, scheduled session inside it. */
  async function seedRoomWithSession(cookie: string, eventId: string) {
    const created = await api(cookie, '/agenda/rooms', { name: 'Hall B', capacity: 50 });
    const room = (await created.json()) as { id: string; name: string; capacity: number | null; position: number; notes: string | null };
    const sessionId = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB
      .prepare("UPDATE submissions SET starts_at = '2026-10-01T09:00:00Z', ends_at = '2026-10-01T10:00:00Z', room_id = ? WHERE id = ?")
      .bind(room.id, sessionId)
      .run();
    return { room, sessionId };
  }

  it('usage reports the scheduled sessions a delete would detach', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { room } = await seedRoomWithSession(admin.cookie, eventId);

    const res = await api(admin.cookie, `/agenda/rooms/${room.id}/usage`, undefined, 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ session_count: 1, scheduled_count: 1 });
  });

  it('delete detaches sessions (slot kept) and returns the undo payload', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { room, sessionId } = await seedRoomWithSession(admin.cookie, eventId);

    const res = await api(admin.cookie, `/agenda/rooms/${room.id}`, undefined, 'DELETE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      room: { id: string; name: string };
      detached_session_ids: string[];
    };
    expect(body.room.name).toBe('Hall B');
    expect(body.detached_session_ids).toEqual([sessionId]);

    const session = await env.DB
      .prepare('SELECT room_id, starts_at FROM submissions WHERE id = ?')
      .bind(sessionId)
      .first<{ room_id: string | null; starts_at: string | null }>();
    expect(session?.room_id).toBeNull();
    expect(session?.starts_at).toBe('2026-10-01T09:00:00Z');
  });

  it('restore reinstates the room under its old id and re-points the sessions', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { room, sessionId } = await seedRoomWithSession(admin.cookie, eventId);
    const del = await api(admin.cookie, `/agenda/rooms/${room.id}`, undefined, 'DELETE');
    const undoPayload = (await del.json()) as { room: typeof room; detached_session_ids: string[] };

    const res = await api(admin.cookie, `/agenda/rooms/${room.id}/restore`, {
      name: undoPayload.room.name,
      capacity: undoPayload.room.capacity,
      notes: undoPayload.room.notes,
      position: undoPayload.room.position,
      session_ids: undoPayload.detached_session_ids,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; room: { id: string }; restored_sessions: number };
    expect(body.room.id).toBe(room.id);
    expect(body.restored_sessions).toBe(1);

    const session = await env.DB
      .prepare('SELECT room_id FROM submissions WHERE id = ?')
      .bind(sessionId)
      .first<{ room_id: string | null }>();
    expect(session?.room_id).toBe(room.id);
  });

  it('restore leaves a session alone if it was re-homed during the undo window', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { room, sessionId } = await seedRoomWithSession(admin.cookie, eventId);
    const del = await api(admin.cookie, `/agenda/rooms/${room.id}`, undefined, 'DELETE');
    const undoPayload = (await del.json()) as { room: typeof room; detached_session_ids: string[] };

    // The operator moved the session into another room before hitting Undo.
    const other = await api(admin.cookie, '/agenda/rooms', { name: 'Hall C' });
    const otherRoom = (await other.json()) as { id: string };
    await env.DB.prepare('UPDATE submissions SET room_id = ? WHERE id = ?').bind(otherRoom.id, sessionId).run();

    const res = await api(admin.cookie, `/agenda/rooms/${room.id}/restore`, {
      name: undoPayload.room.name,
      capacity: undoPayload.room.capacity,
      notes: undoPayload.room.notes,
      position: undoPayload.room.position,
      session_ids: undoPayload.detached_session_ids,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { restored_sessions: number }).restored_sessions).toBe(0);

    const session = await env.DB
      .prepare('SELECT room_id FROM submissions WHERE id = ?')
      .bind(sessionId)
      .first<{ room_id: string | null }>();
    expect(session?.room_id).toBe(otherRoom.id);
  });
});
