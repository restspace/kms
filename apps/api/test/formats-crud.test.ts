// Session formats CRUD (spec-gap CFP-S1): formats used to be option literals
// on the per-event `format` field definition plus a hardcoded list in the
// agenda dialog. Now a managed per-event table, mirroring tracks — except
// nothing references a format by id (submissions.format stores the name), so
// delete performs no cleanup and existing submissions keep their string.
// Mirrors rooms-tracks-crud.test.ts.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('formats CRUD', () => {
  it('creates, lists, renames and deletes a format, auto-assigning position', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await api('/formats', admin.cookie, { name: 'Talk (30 min)' });
    expect(first.status).toBe(201);
    const firstRow = (await first.json()) as Record<string, unknown>;
    expect(firstRow).toMatchObject({ name: 'Talk (30 min)', position: 0, event_id: eventId });

    const second = await api('/formats', admin.cookie, { name: 'Workshop (120 min)' });
    const secondRow = (await second.json()) as Record<string, unknown>;
    expect(secondRow).toMatchObject({ name: 'Workshop (120 min)', position: 1 });

    const list = await SELF.fetch('https://example.com/app/api/formats', { headers: { cookie: admin.cookie } });
    const { items } = (await list.json()) as { items: Array<{ name: string }> };
    expect(items.map((f) => f.name)).toEqual(['Talk (30 min)', 'Workshop (120 min)']);

    const renamed = await api(`/formats/${firstRow.id}`, admin.cookie, { name: 'Session (30 min)' }, 'PUT');
    expect(await renamed.json()).toMatchObject({ name: 'Session (30 min)' });

    const deleted = await api(`/formats/${firstRow.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/formats/${firstRow.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('rejects an empty name', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await api('/formats', admin.cookie, { name: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'name_required' });
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await api('/formats', reviewer.cookie, { name: 'Talk' });
    expect(res.status).toBe(403);
  });

  it('deleting a format leaves submissions.format untouched — the recorded name is the answer', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const created = await api('/formats', admin.cookie, { name: 'Panel (45 min)' });
    const { id: formatId } = (await created.json()) as { id: string };
    await env.DB.prepare('UPDATE submissions SET format = ? WHERE id = ?').bind('Panel (45 min)', submissionId).run();

    const deleted = await api(`/formats/${formatId}`, admin.cookie, undefined, 'DELETE');
    expect(deleted.status).toBe(200);

    const row = await env.DB.prepare('SELECT format FROM submissions WHERE id = ?')
      .bind(submissionId)
      .first<{ format: string | null }>();
    expect(row?.format).toBe('Panel (45 min)');
  });

  it('scopes formats to the event — another event cannot rename or delete them', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');

    const created = await api('/formats', adminA.cookie, { name: 'Talk' });
    const { id: formatId } = (await created.json()) as { id: string };

    expect((await api(`/formats/${formatId}`, adminB.cookie, { name: 'Hijacked' }, 'PUT')).status).toBe(404);
    expect((await api(`/formats/${formatId}`, adminB.cookie, undefined, 'DELETE')).status).toBe(404);

    const list = await SELF.fetch('https://example.com/app/api/formats', { headers: { cookie: adminB.cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('POST /app/api/events seeds the default formats', () => {
  it('a new event starts with the five duration-labelled defaults and a derivable format field', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const slug = `evt-with-formats-${crypto.randomUUID().slice(0, 8)}`;

    const res = await api('/events', admin.cookie, {
      name: 'DevFlow 2027',
      slug,
      starts_at: '2027-05-01T09:00:00Z',
      ends_at: '2027-05-02T18:00:00Z',
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const formats = await env.DB.prepare('SELECT name, position FROM formats WHERE event_id = ? ORDER BY position')
      .bind(id)
      .all();
    expect(formats.results).toEqual([
      { name: 'Keynote (45 min)', position: 0 },
      { name: 'Talk (30 min)', position: 1 },
      { name: 'Lightning Talk (10 min)', position: 2 },
      { name: 'Workshop (120 min)', position: 3 },
      { name: 'Panel (45 min)', position: 4 },
    ]);

    // The field definition carries no stored options — the dropdown derives
    // from the rows above (formsAdmin.ts FORMAT_FIELD_KEY).
    const field = await env.DB.prepare(
      "SELECT options FROM field_definitions WHERE event_id = ? AND key = 'format'",
    )
      .bind(id)
      .first<{ options: string | null }>();
    expect(field?.options).toBeNull();
  });
});
