// Two fixes: F13 (duplicate-contact recovery — the 409 now echoes the
// existing contact's id) and F14/ABS-11 (submission edit gains track/room/
// participant fields, and the participant role vocabulary grows two roles).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('F13: POST/PUT /app/api/contacts duplicate email', () => {
  it('POST returns the existing contact id alongside email_exists', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const existingId = await seedContact(eventId, { email: 'dup@example.com' });

    const res = await api('/contacts', admin.cookie, { email: 'dup@example.com', first_name: 'New' }, 'POST');
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; existing_id: string };
    expect(body.error).toBe('email_exists');
    expect(body.existing_id).toBe(existingId);
  });

  it('matches case-insensitively (the store lower-cases email on write)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const existingId = await seedContact(eventId, { email: 'mixed@example.com' });

    const res = await api('/contacts', admin.cookie, { email: 'MIXED@EXAMPLE.COM' }, 'POST');
    expect(res.status).toBe(409);
    const body = await res.json() as { existing_id: string };
    expect(body.existing_id).toBe(existingId);
  });

  it('PUT returns the existing contact id when the new email collides with another contact', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const targetId = await seedContact(eventId, { email: 'mine@example.com' });
    const otherId = await seedContact(eventId, { email: 'taken@example.com' });

    const res = await api(`/contacts/${targetId}`, admin.cookie, { email: 'taken@example.com' }, 'PUT');
    expect(res.status).toBe(409);
    const body = await res.json() as { error: string; existing_id: string };
    expect(body.error).toBe('email_exists');
    expect(body.existing_id).toBe(otherId);
  });

  it('does not resolve an existing_id across events (event-scoped lookup)', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    await seedContact(eventB, { email: 'other-event@example.com' });

    // No collision inside eventA, so this actually succeeds — the point is
    // just that a same-email contact in a *different* event doesn't false-positive.
    const res = await api('/contacts', admin.cookie, { email: 'other-event@example.com' }, 'POST');
    expect(res.status).toBe(201);
  });
});

describe('F14/ABS-11: PUT /app/api/submissions/:id', () => {
  it('updates title/description/format/level/language/track/room', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { title: 'Old title' });
    const trackId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name) VALUES (?, ?, ?)').bind(trackId, eventId, 'Track A').run();
    const roomId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO rooms (id, event_id, name) VALUES (?, ?, ?)').bind(roomId, eventId, 'Room A').run();

    const res = await api(`/submissions/${submissionId}`, admin.cookie, {
      title: 'New title',
      description: 'A fuller abstract',
      format: 'workshop',
      level: 'intermediate',
      language: 'en',
      track_id: trackId,
      room_id: roomId,
    }, 'PUT');
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(submissionId)
      .first<Record<string, unknown>>();
    expect(row?.title).toBe('New title');
    expect(row?.description).toBe('A fuller abstract');
    expect(row?.format).toBe('workshop');
    expect(row?.level).toBe('intermediate');
    expect(row?.language).toBe('en');
    expect(row?.track_id).toBe(trackId);
    expect(row?.room_id).toBe(roomId);
  });

  it('rejects a track_id from another event', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const submissionId = await seedSubmission(eventA);
    const foreignTrack = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name) VALUES (?, ?, ?)').bind(foreignTrack, eventB, 'Foreign').run();

    const res = await api(`/submissions/${submissionId}`, admin.cookie, { track_id: foreignTrack }, 'PUT');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_track');
  });

  it('clears the title on an empty string rather than accepting it', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const res = await api(`/submissions/${submissionId}`, admin.cookie, { title: '   ' }, 'PUT');
    expect(res.status).toBe(400);
  });

  it('404s across events', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const foreign = await seedSubmission(eventB);
    const res = await api(`/submissions/${foreign}`, admin.cookie, { title: 'peek' }, 'PUT');
    expect(res.status).toBe(404);
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const res = await api(`/submissions/${submissionId}`, reviewer.cookie, { title: 'nope' }, 'PUT');
    expect(res.status).toBe(403);
  });
});

describe('F14/ABS-11: submission participants', () => {
  it('adds an existing contact as a co-speaker', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId, { email: 'cospeaker@example.com' });

    const res = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'co-speaker',
    }, 'POST');
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT role FROM submission_participants WHERE submission_id = ? AND contact_id = ?',
    ).bind(submissionId, contactId).first<{ role: string }>();
    expect(row?.role).toBe('co-speaker');
  });

  it('accepts the two new roles: co-author and co-presenter', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);

    for (const role of ['co-author', 'co-presenter']) {
      const contactId = await seedContact(eventId, { email: `${role}@example.com` });
      const res = await api(`/submissions/${submissionId}/participants`, admin.cookie, { contact_id: contactId, role }, 'POST');
      expect(res.status).toBe(201);
    }
    const { results } = await env.DB.prepare(
      'SELECT role FROM submission_participants WHERE submission_id = ? ORDER BY role',
    ).bind(submissionId).all<{ role: string }>();
    expect(results.map((r) => r.role).sort()).toEqual(['co-author', 'co-presenter']);
  });

  it('rejects an invalid role', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const res = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'keynote-headliner',
    }, 'POST');
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe('invalid_role');
  });

  it('rejects a contact from another event', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const submissionId = await seedSubmission(eventA);
    const foreignContact = await seedContact(eventB);
    const res = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: foreignContact,
      role: 'speaker',
    }, 'POST');
    expect(res.status).toBe(404);
  });

  it('changes an existing participant role', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const res = await api(`/submissions/${submissionId}/participants/${participantId}`, admin.cookie, { role: 'co-author' }, 'PUT');
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT role FROM submission_participants WHERE id = ?').bind(participantId)
      .first<{ role: string }>();
    expect(row?.role).toBe('co-author');
  });

  it('removes a participant', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const res = await api(`/submissions/${submissionId}/participants/${participantId}`, admin.cookie, undefined, 'DELETE');
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT id FROM submission_participants WHERE id = ?').bind(participantId).first();
    expect(row).toBeNull();
  });

  it('GET .../detail includes participant_id for each participant', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    await api(`/submissions/${submissionId}/participants`, admin.cookie, { contact_id: contactId, role: 'speaker' }, 'POST');

    const res = await api(`/submissions/${submissionId}/detail`, admin.cookie, undefined, 'GET');
    expect(res.status).toBe(200);
    const body = await res.json() as { participants: Array<{ participant_id: string; role: string }> };
    expect(body.participants).toHaveLength(1);
    expect(body.participants[0].role).toBe('speaker');
    expect(typeof body.participants[0].participant_id).toBe('string');
  });
});

// SPK-04/w2: confirmed_at (submission_participants) previously only got set
// once, automatically, at submit time (submit.tsx) — the dashboard's
// "Confirmed N / Awaiting confirmation M" stat (routes/dashboard.ts) read it
// but nothing ever wrote to it again. PUT .../participants/:id/confirm is
// the organiser-facing control that closes that gap.
describe('SPK-04/w2: PUT /app/api/submissions/:id/participants/:id/confirm', () => {
  it('is null (awaiting) by default when an organiser adds a participant', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const row = await env.DB.prepare('SELECT confirmed_at FROM submission_participants WHERE id = ?')
      .bind(participantId).first<{ confirmed_at: string | null }>();
    expect(row?.confirmed_at).toBeNull();
  });

  it('sets confirmed_at when confirmed: true, and it round-trips through GET .../detail', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const res = await api(`/submissions/${submissionId}/participants/${participantId}/confirm`, admin.cookie, { confirmed: true }, 'PUT');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, confirmed: true });

    const row = await env.DB.prepare('SELECT confirmed_at FROM submission_participants WHERE id = ?')
      .bind(participantId).first<{ confirmed_at: string | null }>();
    expect(typeof row?.confirmed_at).toBe('string');

    const detail = await api(`/submissions/${submissionId}/detail`, admin.cookie, undefined, 'GET');
    const body = await detail.json() as { participants: Array<{ participant_id: string; confirmed_at: string | null }> };
    expect(body.participants[0].confirmed_at).not.toBeNull();
  });

  it('clears confirmed_at when confirmed: false (reversible, not one-way)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };
    await api(`/submissions/${submissionId}/participants/${participantId}/confirm`, admin.cookie, { confirmed: true }, 'PUT');

    const res = await api(`/submissions/${submissionId}/participants/${participantId}/confirm`, admin.cookie, { confirmed: false }, 'PUT');
    expect(res.status).toBe(200);
    const row = await env.DB.prepare('SELECT confirmed_at FROM submission_participants WHERE id = ?')
      .bind(participantId).first<{ confirmed_at: string | null }>();
    expect(row?.confirmed_at).toBeNull();
  });

  it('404s for a participant on another event\'s submission', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const submissionB = await seedSubmission(eventB);
    const contactB = await seedContact(eventB);
    const staffB = await seedStaff(eventB, 'admin');
    const added = await api(`/submissions/${submissionB}/participants`, staffB.cookie, {
      contact_id: contactB,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const res = await api(`/submissions/${submissionB}/participants/${participantId}/confirm`, adminA.cookie, { confirmed: true }, 'PUT');
    expect(res.status).toBe(404);
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const contactId = await seedContact(eventId);
    const added = await api(`/submissions/${submissionId}/participants`, admin.cookie, {
      contact_id: contactId,
      role: 'speaker',
    }, 'POST');
    const { id: participantId } = await added.json() as { id: string };

    const res = await api(`/submissions/${submissionId}/participants/${participantId}/confirm`, reviewer.cookie, { confirmed: true }, 'PUT');
    expect(res.status).toBe(403);
  });
});
