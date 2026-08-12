// Admin notifications (sweep item 14) and the public agenda feed the
// `agenda_published` flag gates. Both live on the submission/agenda lane, so
// they share a file.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { countRows, createRoom, createTrack, seedForm, submitBody } from './fixtures-submission';

const json = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function adminSession(eventId: string, slug: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'admin' });
  return { contactId, cookie };
}

describe('admin notifications on submit', () => {
  it('queues exactly one admin notification per create, and drops foreign recipients', async () => {
    const form = await seedForm();
    const admin = await adminSession(form.eventId, form.eventSlug);
    const otherEvent = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const foreign = await createContact(otherEvent, { email: 'foreign@example.com' });
    await env.DB.prepare('UPDATE submission_forms SET notify_admins_on_create = ? WHERE id = ?')
      .bind(JSON.stringify([admin.contactId, foreign]), form.formId)
      .run();

    const draft = (await (
      await SELF.fetch(`https://example.com${form.basePath}/draft`, json(form.cookie, { answers: {} }))
    ).json()) as { submission_id: string };

    // Two identical submits: the notification is keyed on the submission, so
    // the replay is a duplicate, not a second email.
    for (let i = 0; i < 2; i += 1) {
      const res = await SELF.fetch(
        `https://example.com${form.basePath}/submit`,
        json(form.cookie, { ...submitBody(form), submission_id: draft.submission_id }),
      );
      expect(res.status).toBe(200);
    }

    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'submission_received_admin' AND event_id = ?`,
        form.eventId,
      ),
    ).toBe(1);
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'submission_received_admin' AND to_email = 'foreign@example.com'`,
      ),
    ).toBe(0);
  });
});

describe('POST /app/api/agenda/sessions', () => {
  it('rejects a room or track belonging to another event', async () => {
    const eventId = await createEvent({ slug: `ev-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const otherEvent = await createEvent({ slug: `ev-${crypto.randomUUID().slice(0, 8)}` });
    const foreignRoom = await createRoom(otherEvent, 'Foreign hall');
    const foreignTrack = await createTrack(otherEvent, 'Foreign track');

    const roomRes = await SELF.fetch(
      'https://example.com/app/api/agenda/sessions',
      json(cookie, { title: 'Keynote', room_id: foreignRoom }),
    );
    expect(roomRes.status).toBe(400);
    expect(await roomRes.json()).toMatchObject({ error: 'invalid_room' });

    const trackRes = await SELF.fetch(
      'https://example.com/app/api/agenda/sessions',
      json(cookie, { title: 'Keynote', track_id: foreignTrack }),
    );
    expect(trackRes.status).toBe(400);
    expect(await trackRes.json()).toMatchObject({ error: 'invalid_track' });

    expect(await countRows('SELECT COUNT(*) AS n FROM submissions WHERE event_id = ?', eventId)).toBe(0);
  });

  it('persists capacity and allocates a SESS code from the shared allocator', async () => {
    const eventId = await createEvent({ slug: `ev-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const res = await SELF.fetch(
      'https://example.com/app/api/agenda/sessions',
      json(cookie, { title: 'Workshop', capacity: 42 }),
    );
    expect(res.status).toBe(201);
    const row = await env.DB.prepare('SELECT code, capacity FROM submissions WHERE event_id = ?')
      .bind(eventId)
      .first<{ code: string; capacity: number }>();
    expect(row).toMatchObject({ code: 'SESS-1', capacity: 42 });
  });

  it('turns send-confirmations into a queued bulk job', async () => {
    const eventId = await createEvent({ slug: `ev-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const res = await SELF.fetch('https://example.com/app/api/agenda/send-confirmations', json(cookie, {}));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; job_id: string; queued: number };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(0);
    const job = await env.DB.prepare('SELECT kind, status FROM bulk_jobs WHERE id = ?')
      .bind(body.job_id)
      .first<{ kind: string; status: string }>();
    expect(job).toMatchObject({ kind: 'send-confirmations', status: 'pending' });
  });
});

describe('GET /e/:slug/agenda.json', () => {
  it('404s until the agenda is published, then serves scheduled sessions only', async () => {
    const slug = `pub-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    const speaker = await createContact(eventId, { email: 'sp@example.com', first_name: 'Ada', last_name: 'L' });
    const room = await createRoom(eventId, 'Main hall');

    const ts = '2026-09-01T00:00:00Z';
    const insert = async (id: string, code: string, scheduled: boolean, status = 'accepted') =>
      env.DB.prepare(
        `INSERT INTO submissions (id, event_id, code, kind, title, status, room_id, starts_at, ends_at, source, created_at, updated_at)
         VALUES (?, ?, ?, 'session', ?, ?, ?, ?, ?, 'manual', ?, ?)`,
      )
        .bind(
          id,
          eventId,
          code,
          `Talk ${code}`,
          status,
          scheduled ? room : null,
          scheduled ? '2026-10-01T09:00:00Z' : null,
          scheduled ? '2026-10-01T10:00:00Z' : null,
          ts,
          ts,
        )
        .run();
    await insert('sub-live', 'SESS-1', true);
    await insert('sub-unscheduled', 'SESS-2', false);
    await insert('sub-pending', 'SESS-3', true, 'pending');
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES ('sp-1', 'sub-live', ?, 'speaker', 1, 1)`,
    )
      .bind(speaker)
      .run();

    const before = await SELF.fetch(`https://example.com/e/${slug}/agenda.json`);
    expect(before.status).toBe(404);

    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventId).run();
    const after = await SELF.fetch(`https://example.com/e/${slug}/agenda.json`);
    expect(after.status).toBe(200);
    const payload = (await after.json()) as {
      event: { slug: string };
      days: string[];
      rooms: Array<{ name: string }>;
      sessions: Array<{ code: string; speakers: string[] }>;
    };
    expect(payload.event.slug).toBe(slug);
    expect(payload.sessions.map((s) => s.code)).toEqual(['SESS-1']);
    expect(payload.sessions[0]!.speakers).toEqual(['Ada L']);
    // Event spans 2026-10-01..2026-10-02; both days are listed even though
    // only the first has a scheduled session (days come from the event's
    // date range, not just from days that happen to have sessions).
    expect(payload.days).toEqual(['2026-10-01', '2026-10-02']);
    expect(payload.rooms.map((r) => r.name)).toContain('Main hall');
    expect(JSON.stringify(payload)).not.toContain('sp@example.com');
  });
});
