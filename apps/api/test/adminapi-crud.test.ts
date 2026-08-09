// Admin write surfaces added by the fix batch: internal notes, tasks CRUD and
// event create/patch (FR-EVT-1/2, FR-AGENDA-9).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('PUT /app/api/submissions/:id/notes', () => {
  it('round-trips organiser notes', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);

    const res = await api(`/submissions/${submissionId}/notes`, admin.cookie, { notes: '  AV rider outstanding  ' }, 'PUT');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, notes: 'AV rider outstanding' });

    const row = await env.DB.prepare('SELECT notes FROM submissions WHERE id = ?').bind(submissionId).first<{ notes: string }>();
    expect(row?.notes).toBe('AV rider outstanding');

    const cleared = await api(`/submissions/${submissionId}/notes`, admin.cookie, { notes: null }, 'PUT');
    expect(await cleared.json()).toEqual({ ok: true, notes: null });
  });

  it('caps the note at 10000 characters', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);
    await api(`/submissions/${submissionId}/notes`, admin.cookie, { notes: 'x'.repeat(12_000) }, 'PUT');
    const row = await env.DB.prepare('SELECT LENGTH(notes) AS n FROM submissions WHERE id = ?')
      .bind(submissionId).first<{ n: number }>();
    expect(row?.n).toBe(10_000);
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const res = await api(`/submissions/${submissionId}/notes`, reviewer.cookie, { notes: 'nope' }, 'PUT');
    expect(res.status).toBe(403);
  });

  it('404s across events', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const foreign = await seedSubmission(eventB);
    const res = await api(`/submissions/${foreign}/notes`, admin.cookie, { notes: 'peek' }, 'PUT');
    expect(res.status).toBe(404);
  });
});

describe('tasks CRUD', () => {
  it('creates, updates and deletes a task', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/tasks', admin.cookie, {
      title: 'Upload slides',
      description: 'PDF or Keynote',
      target: 'contact',
      assignment_mode: 'automatic',
      trigger: 'on_accept',
      action_type: 'file_upload',
      due_at: '2026-09-01T12:00:00Z',
      reminder_offsets_days: [7, 1],
      required: true,
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(row).toMatchObject({
      title: 'Upload slides',
      trigger: 'on_accept',
      action_type: 'file_upload',
      required: 1,
      event_id: eventId,
    });
    expect(row.reminder_offsets_days).toBe('[7,1]');

    const updated = await api(`/tasks/${row.id}`, admin.cookie, { title: 'Upload final slides', required: false }, 'PUT');
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ title: 'Upload final slides', required: 0 });

    const deleted = await api(`/tasks/${row.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect(await api(`/tasks/${row.id}`, admin.cookie, undefined, 'DELETE')).toMatchObject({ status: 404 });
  });

  it('rejects an unknown action_type', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tasks', admin.cookie, { title: 'Bad', action_type: 'telepathy' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_action_type' });
  });

  it('rejects a portal_form_id from another event', async () => {
    const eventId = await seedEvent();
    const other = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await env.DB.prepare(
      `INSERT INTO portal_forms (id, event_id, name, type, created_at) VALUES ('pf-foreign', ?, 'Foreign', 'contacts', ?)`,
    ).bind(other, '2026-08-01T00:00:00Z').run();

    const res = await api('/tasks', admin.cookie, {
      title: 'Fill the form', action_type: 'portal_form', portal_form_id: 'pf-foreign',
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'reference_not_in_event' });
  });

  it('requires a non-empty title', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/tasks', admin.cookie, { title: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'title_required' });
  });
});

describe('events create + patch', () => {
  it('creates an event the creator can immediately switch to and query', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const slug = `new-event-${crypto.randomUUID().slice(0, 8)}`;
    const res = await api('/events', admin.cookie, {
      name: 'Brand New Event',
      slug,
      type: 'summit',
      website_url: 'https://example.com/summit',
      location: 'Berlin',
      timezone: 'Europe/Berlin',
      starts_at: '2027-03-01T09:00:00Z',
      ends_at: '2027-03-02T18:00:00Z',
      description: 'A summit about summits.',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { ok: boolean; id: string };

    const row = await env.DB.prepare('SELECT name, slug, type, timezone, theme, org_id FROM events WHERE id = ?')
      .bind(id).first<Record<string, string>>();
    expect(row).toMatchObject({ name: 'Brand New Event', slug, type: 'summit', timezone: 'Europe/Berlin', theme: 'A summit about summits.' });

    // The creator owns it, through a contacts row in the new event.
    const seat = await env.DB.prepare(
      `SELECT eu.role FROM event_users eu JOIN contacts c ON c.id = eu.contact_id
       WHERE eu.event_id = ? AND c.email = ?`,
    ).bind(id, admin.email).first<{ role: string }>();
    expect(seat?.role).toBe('owner');

    // …and it shows up in the workspace immediately.
    const me = await SELF.fetch('https://example.com/app/api/me', { headers: { cookie: admin.cookie } });
    const body = (await me.json()) as { events: Array<{ id: string }> };
    expect(body.events.map((e) => e.id)).toContain(id);

    const switched = await api('/switch-event', admin.cookie, { event_id: id });
    expect(switched.status).toBe(200);
  });

  it('409s on a duplicate slug', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const slug = `dupe-${crypto.randomUUID().slice(0, 8)}`;
    const payload = { name: 'One', slug, starts_at: '2027-03-01T09:00:00Z', ends_at: '2027-03-02T18:00:00Z' };
    expect((await api('/events', admin.cookie, payload)).status).toBe(201);
    const second = await api('/events', admin.cookie, payload);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'slug_taken' });
  });

  it('validates slug shape and the date range', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const bad = await api('/events', admin.cookie, {
      name: 'Bad', slug: 'Not A Slug', starts_at: '2027-03-01T09:00:00Z', ends_at: '2027-03-02T18:00:00Z',
    });
    expect(await bad.json()).toEqual({ error: 'invalid_slug' });

    const backwards = await api('/events', admin.cookie, {
      name: 'Bad', slug: 'ok-slug', starts_at: '2027-03-05T09:00:00Z', ends_at: '2027-03-02T18:00:00Z',
    });
    expect(await backwards.json()).toEqual({ error: 'ends_before_starts' });
  });

  it('flips agenda_published through PATCH', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    expect((await api(`/events/${eventId}`, admin.cookie, { agenda_published: true }, 'PATCH')).status).toBe(200);
    let row = await env.DB.prepare('SELECT agenda_published FROM events WHERE id = ?').bind(eventId).first<{ agenda_published: number }>();
    expect(row?.agenda_published).toBe(1);

    await api(`/events/${eventId}`, admin.cookie, { agenda_published: false }, 'PATCH');
    row = await env.DB.prepare('SELECT agenda_published FROM events WHERE id = ?').bind(eventId).first<{ agenda_published: number }>();
    expect(row?.agenda_published).toBe(0);
  });

  it('refuses to patch an event outside the accessible set', async () => {
    const mine = await seedEvent({ org_id: `org-mine-${crypto.randomUUID().slice(0, 8)}` });
    const theirs = await seedEvent({ org_id: `org-theirs-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await seedStaff(mine, 'admin');
    await seedEventUser(theirs, await seedContact(theirs, { email: 'someone@example.com' }), 'owner');

    const res = await api(`/events/${theirs}`, admin.cookie, { agenda_published: true }, 'PATCH');
    expect(res.status).toBe(403);
    const row = await env.DB.prepare('SELECT agenda_published FROM events WHERE id = ?').bind(theirs).first<{ agenda_published: number }>();
    expect(row?.agenda_published).toBe(0);
  });
});
