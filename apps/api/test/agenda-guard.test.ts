// FR-COMM-6 server guard (manual-review "invited session may move silently"):
// PUT /app/api/agenda/sessions/:id/schedule refuses to move a session that
// has a live METHOD:REQUEST calendar invite unless the caller decided about
// the notification email. The client prompt is UX; this is the guarantee.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';
const SLOT = { starts_at: '2026-10-01T09:00:00.000Z', ends_at: '2026-10-01T10:00:00.000Z' };
const MOVED = { starts_at: '2026-10-01T11:00:00.000Z', ends_at: '2026-10-01T12:00:00.000Z' };

const schedule = (cookie: string, id: string, body: unknown) =>
  SELF.fetch(`https://example.com/app/api/agenda/sessions/${id}/schedule`, jsonReq(cookie, body, 'PUT'));

/** An accepted, scheduled session in a room, with one speaker attached. */
async function seedScheduledSession(eventId: string): Promise<{ sessionId: string; roomId: string; speakerId: string }> {
  const roomId = `room-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO rooms (id, event_id, name, capacity, position) VALUES (?, ?, ?, ?, 0)',
  ).bind(roomId, eventId, 'Hall A', 100).run();

  const sessionId = await seedSubmission(eventId, { status: 'accepted' });
  await env.DB.prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ? WHERE id = ?')
    .bind(SLOT.starts_at, SLOT.ends_at, roomId, sessionId)
    .run();

  const speakerId = await seedContact(eventId, { email: `speaker-${crypto.randomUUID().slice(0, 8)}@example.com` });
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, 1)`,
  ).bind(`sp-${crypto.randomUUID()}`, sessionId, speakerId).run();

  return { sessionId, roomId, speakerId };
}

/** The row `invited` is derived from — what a real send writes. */
async function seedLiveInvite(sessionId: string, contactId: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO calendar_invites (id, session_id, contact_id, uid, sequence, method, last_sent_at)
     VALUES (?, ?, ?, ?, 0, 'REQUEST', ?)`,
  ).bind(`ci-${crypto.randomUUID()}`, sessionId, contactId, `${sessionId}@test`, ts).run();
}

const startsAtOf = (id: string) =>
  env.DB.prepare('SELECT starts_at FROM submissions WHERE id = ?').bind(id).first<{ starts_at: string | null }>();

describe('PUT /agenda/sessions/:id/schedule — invited sessions never move silently', () => {
  it('refuses a move with no notify decision and leaves the slot untouched', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId, speakerId } = await seedScheduledSession(eventId);
    await seedLiveInvite(sessionId, speakerId);

    const res = await schedule(admin.cookie, sessionId, { ...MOVED, room_id: roomId });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'invite_notify_required', invited: 1 });
    expect((await startsAtOf(sessionId))?.starts_at).toBe(SLOT.starts_at);
  });

  it("accepts the same move with notify:'changed' and queues the invite mail", async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId, speakerId } = await seedScheduledSession(eventId);
    await seedLiveInvite(sessionId, speakerId);

    const res = await schedule(admin.cookie, sessionId, { ...MOVED, room_id: roomId, notify: 'changed' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; notified: number };
    expect(body.ok).toBe(true);
    expect(body.notified).toBeGreaterThan(0);
    expect((await startsAtOf(sessionId))?.starts_at).toBe(MOVED.starts_at);

    const mail = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'schedule_changed' AND contact_id = ?")
      .bind(speakerId)
      .first<{ n: number }>();
    expect(mail?.n).toBe(1);
  });

  it('accepts the move when the operator was asked and declined the email (notify_ack)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId, speakerId } = await seedScheduledSession(eventId);
    await seedLiveInvite(sessionId, speakerId);

    const res = await schedule(admin.cookie, sessionId, { ...MOVED, room_id: roomId, notify_ack: true });
    expect(res.status).toBe(200);
    expect((await startsAtOf(sessionId))?.starts_at).toBe(MOVED.starts_at);

    const mail = await env.DB
      .prepare("SELECT COUNT(*) AS n FROM message_log WHERE contact_id = ?")
      .bind(speakerId)
      .first<{ n: number }>();
    expect(mail?.n).toBe(0);
  });

  it('lets a no-op write through: re-saving the same slot is not a change', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId, speakerId } = await seedScheduledSession(eventId);
    await seedLiveInvite(sessionId, speakerId);

    const res = await schedule(admin.cookie, sessionId, { ...SLOT, room_id: roomId });
    expect(res.status).toBe(200);
    expect((await startsAtOf(sessionId))?.starts_at).toBe(SLOT.starts_at);
  });

  it('moves a session with no live invite freely', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId } = await seedScheduledSession(eventId);

    const res = await schedule(admin.cookie, sessionId, { ...MOVED, room_id: roomId });
    expect(res.status).toBe(200);
    expect((await startsAtOf(sessionId))?.starts_at).toBe(MOVED.starts_at);
  });

  it('still guards the unschedule path (all-null time)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, speakerId } = await seedScheduledSession(eventId);
    await seedLiveInvite(sessionId, speakerId);

    const res = await schedule(admin.cookie, sessionId, { starts_at: null, ends_at: null, room_id: null });
    expect(res.status).toBe(409);
    expect((await startsAtOf(sessionId))?.starts_at).toBe(SLOT.starts_at);
  });

  it('a CANCEL-only invite row no longer counts as invited', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { sessionId, roomId, speakerId } = await seedScheduledSession(eventId);
    await env.DB.prepare(
      `INSERT INTO calendar_invites (id, session_id, contact_id, uid, sequence, method, last_sent_at)
       VALUES (?, ?, ?, ?, 1, 'CANCEL', ?)`,
    ).bind(`ci-${crypto.randomUUID()}`, sessionId, speakerId, `${sessionId}@test`, ts).run();

    const res = await schedule(admin.cookie, sessionId, { ...MOVED, room_id: roomId });
    expect(res.status).toBe(200);
  });
});
