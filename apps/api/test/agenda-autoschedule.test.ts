// Auto-schedule assist (AIA-08), server side: POST /agenda/auto-schedule
// places the tray *pencilled*, /confirm-placements accepts the lot, and
// /schedule-batch is the one-call write the client's undo uses. The point of
// the pencilled column is that nothing is promised until an organiser says
// so, so these also pin what a placement does NOT touch.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';
const SLOT = { starts_at: '2026-10-01T09:00:00.000Z', ends_at: '2026-10-01T10:00:00.000Z' };

const post = (cookie: string, path: string, body: unknown = {}) =>
  SELF.fetch(`https://example.com/app/api/agenda/${path}`, jsonReq(cookie, body));

async function seedRoom(eventId: string, name: string, capacity: number | null = 100): Promise<string> {
  const id = `room-${crypto.randomUUID()}`;
  await env.DB.prepare('INSERT INTO rooms (id, event_id, name, capacity, position) VALUES (?, ?, ?, ?, 0)')
    .bind(id, eventId, name, capacity)
    .run();
  return id;
}

/** An accepted submission sitting in the tray. */
async function seedTraySession(eventId: string, format: string | null = null): Promise<string> {
  const id = await seedSubmission(eventId, { status: 'accepted' });
  if (format) await env.DB.prepare('UPDATE submissions SET format = ? WHERE id = ?').bind(format, id).run();
  return id;
}

const rowOf = (id: string) =>
  env.DB
    .prepare('SELECT starts_at, ends_at, room_id, pencilled_at FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ starts_at: string | null; ends_at: string | null; room_id: string | null; pencilled_at: string | null }>();

interface AutoResponse {
  ok: boolean;
  placed: number;
  placements: Array<{ id: string; starts_at: string; ends_at: string; room_id: string }>;
  skipped: Array<{ id: string; reason: string }>;
  sessions: Array<{ id: string; pencilled_at: string | null; starts_at: string | null }>;
}

describe('POST /agenda/auto-schedule', () => {
  it('places every tray session pencilled and leaves scheduled sessions alone', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, 'Hall A', 200);
    await seedRoom(eventId, 'Hall B', 80);

    const fixed = await seedTraySession(eventId);
    await env.DB.prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ? WHERE id = ?')
      .bind(SLOT.starts_at, SLOT.ends_at, roomA, fixed)
      .run();
    const tray = [
      await seedTraySession(eventId, 'workshop'),
      await seedTraySession(eventId, 'Lightning Talk (10 min)'),
      await seedTraySession(eventId),
    ];

    const res = await post(admin.cookie, 'auto-schedule');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoResponse;
    expect(body.ok).toBe(true);
    expect(body.placed).toBe(3);
    expect(body.placements).toHaveLength(3);
    expect(body.skipped).toEqual([]);
    // The whole agenda payload rides back, so the client never refetches.
    expect(body.sessions.length).toBeGreaterThanOrEqual(4);

    for (const id of tray) {
      const row = await rowOf(id);
      expect(row?.starts_at).not.toBeNull();
      expect(row?.ends_at).not.toBeNull();
      expect(row?.room_id).not.toBeNull();
      expect(row?.pencilled_at).not.toBeNull();
    }
    // Durations follow the format (10-minute lightning talk stays 10 minutes).
    const lightning = await rowOf(tray[1] as string);
    expect(
      (Date.parse(lightning?.ends_at as string) - Date.parse(lightning?.starts_at as string)) / 60_000,
    ).toBe(10);

    const untouched = await rowOf(fixed);
    expect(untouched).toEqual({
      starts_at: SLOT.starts_at,
      ends_at: SLOT.ends_at,
      room_id: roomA,
      pencilled_at: null,
    });
  });

  it('never double-books the only room', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedRoom(eventId, 'The Only Room');
    for (let i = 0; i < 4; i++) await seedTraySession(eventId, 'keynote');

    const res = await post(admin.cookie, 'auto-schedule');
    const body = (await res.json()) as AutoResponse;
    expect(body.placed).toBe(4);

    const slots = body.placements
      .map((p) => ({ start: Date.parse(p.starts_at), end: Date.parse(p.ends_at) }))
      .sort((a, b) => a.start - b.start);
    for (let i = 1; i < slots.length; i++) {
      expect((slots[i] as { start: number }).start).toBeGreaterThanOrEqual((slots[i - 1] as { end: number }).end);
    }
  });

  it('is a no-op when the tray is empty', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedRoom(eventId, 'Hall A');

    const res = await post(admin.cookie, 'auto-schedule');
    expect(res.status).toBe(200);
    const body = (await res.json()) as AutoResponse;
    expect(body.placed).toBe(0);
    expect(body.placements).toEqual([]);
  });

  it('skips every session with no_rooms when the event has no rooms', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const id = await seedTraySession(eventId);

    const body = (await (await post(admin.cookie, 'auto-schedule')).json()) as AutoResponse;
    expect(body.placed).toBe(0);
    expect(body.skipped).toEqual([{ id, reason: 'no_rooms' }]);
    expect((await rowOf(id))?.starts_at).toBeNull();
  });
});

describe('POST /agenda/confirm-placements', () => {
  it('clears pencilled_at for the whole event', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedRoom(eventId, 'Hall A');
    const ids = [await seedTraySession(eventId), await seedTraySession(eventId)];
    await post(admin.cookie, 'auto-schedule');

    const res = await post(admin.cookie, 'confirm-placements');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; confirmed: number };
    expect(body.confirmed).toBe(2);
    for (const id of ids) {
      const row = await rowOf(id);
      expect(row?.pencilled_at).toBeNull();
      expect(row?.starts_at).not.toBeNull();
    }

    // Idempotent: nothing left to confirm.
    const again = (await (await post(admin.cookie, 'confirm-placements')).json()) as { confirmed: number };
    expect(again.confirmed).toBe(0);
  });
});

describe('POST /agenda/schedule-batch', () => {
  it('reverts a whole auto-placement in one call, preserving a preset room', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, 'Hall A');
    const plain = await seedTraySession(eventId);
    const preset = await seedTraySession(eventId);
    await env.DB.prepare('UPDATE submissions SET room_id = ? WHERE id = ?').bind(roomA, preset).run();

    await post(admin.cookie, 'auto-schedule');
    expect((await rowOf(plain))?.pencilled_at).not.toBeNull();

    const res = await post(admin.cookie, 'schedule-batch', {
      items: [
        { id: plain, starts_at: null, ends_at: null, room_id: null },
        { id: preset, starts_at: null, ends_at: null, room_id: roomA },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; updated: number };
    expect(body.updated).toBe(2);
    expect(await rowOf(plain)).toEqual({ starts_at: null, ends_at: null, room_id: null, pencilled_at: null });
    expect(await rowOf(preset)).toEqual({
      starts_at: null,
      ends_at: null,
      room_id: roomA,
      pencilled_at: null,
    });
  });

  it('rejects half-set times, a foreign room, an oversized batch and an unknown id', async () => {
    const eventId = await seedEvent();
    const otherEventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, 'Hall A');
    const foreignRoom = await seedRoom(otherEventId, 'Someone else’s hall');
    const id = await seedTraySession(eventId);

    const cases: Array<{ body: unknown; status: number; error: string }> = [
      { body: { items: [{ id, starts_at: SLOT.starts_at, ends_at: null, room_id: roomA }] }, status: 400, error: 'invalid_time' },
      {
        body: { items: [{ id, starts_at: SLOT.ends_at, ends_at: SLOT.starts_at, room_id: roomA }] },
        status: 400,
        error: 'invalid_time',
      },
      { body: { items: [{ id, ...SLOT, room_id: foreignRoom }] }, status: 400, error: 'invalid_room' },
      {
        body: { items: Array.from({ length: 201 }, () => ({ id, ...SLOT, room_id: roomA })) },
        status: 400,
        error: 'too_many_items',
      },
      { body: { items: [{ id: 'nope', ...SLOT, room_id: roomA }] }, status: 404, error: 'not_found' },
    ];
    for (const c of cases) {
      const res = await post(admin.cookie, 'schedule-batch', c.body);
      expect(res.status).toBe(c.status);
      expect((await res.json()) as { error: string }).toMatchObject({ error: c.error });
    }
    // Nothing was written by any of the refused calls.
    expect((await rowOf(id))?.starts_at).toBeNull();
  });

  it('refuses the whole batch when any session holds a live calendar invite (FR-COMM-6)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, 'Hall A');
    const invitedId = await seedTraySession(eventId);
    const otherId = await seedTraySession(eventId);
    await env.DB.prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ? WHERE id = ?')
      .bind(SLOT.starts_at, SLOT.ends_at, roomA, invitedId)
      .run();

    const speakerId = await seedContact(eventId, { email: `sp-${crypto.randomUUID().slice(0, 8)}@example.com` });
    await env.DB.prepare(
      `INSERT INTO calendar_invites (id, session_id, contact_id, uid, sequence, method, last_sent_at)
       VALUES (?, ?, ?, ?, 0, 'REQUEST', ?)`,
    ).bind(`ci-${crypto.randomUUID()}`, invitedId, speakerId, `${invitedId}@test`, ts).run();

    const res = await post(admin.cookie, 'schedule-batch', {
      items: [
        { id: invitedId, starts_at: null, ends_at: null, room_id: null },
        { id: otherId, ...SLOT, room_id: roomA },
      ],
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invite_notify_required', ids: [invitedId] });
    expect((await rowOf(invitedId))?.starts_at).toBe(SLOT.starts_at);
    expect((await rowOf(otherId))?.starts_at).toBeNull();
  });
});

describe('a manual schedule write confirms the placement', () => {
  it('PUT /agenda/sessions/:id/schedule clears pencilled_at', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const roomA = await seedRoom(eventId, 'Hall A');
    const id = await seedTraySession(eventId);
    await post(admin.cookie, 'auto-schedule');
    expect((await rowOf(id))?.pencilled_at).not.toBeNull();

    const res = await SELF.fetch(
      `https://example.com/app/api/agenda/sessions/${id}/schedule`,
      jsonReq(admin.cookie, { ...SLOT, room_id: roomA }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const row = await rowOf(id);
    expect(row?.pencilled_at).toBeNull();
    expect(row?.starts_at).toBe(SLOT.starts_at);
  });
});
