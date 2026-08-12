// Saved embeds CRUD (spec-gap EMB-15): the Embeds screen persists named
// configurations. The API validates the envelope (name, widget, format
// against the loader's allowlists) and stores `options` as an opaque JSON
// blob the SPA rebuilds snippets from.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

const OPTIONS = {
  accent: '#2c4a73',
  useAccent: true,
  showHeader: false,
  track: 'ai-engineering',
  day: '',
  height: '600',
  toggles: { showAbstract: true, showSpeakers: true, showRoom: false, showTrack: true },
  theme: { font: 'sans', radius: '8', spacing: 'compact', useMuted: false, muted: '#6b6259' },
};

describe('saved embeds CRUD', () => {
  it('creates, lists, updates and deletes a saved embed, options round-tripping as JSON', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/embeds', admin.cookie, {
      name: 'Homepage agenda',
      widget: 'agenda',
      format: 'script',
      options: OPTIONS,
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(row).toMatchObject({ name: 'Homepage agenda', widget: 'agenda', format: 'script', event_id: eventId });
    expect(row.options).toEqual(OPTIONS);

    const list = await SELF.fetch('https://example.com/app/api/embeds', { headers: { cookie: admin.cookie } });
    const { items } = (await list.json()) as { items: Array<Record<string, unknown>> };
    expect(items).toHaveLength(1);
    expect(items[0]!.options).toEqual(OPTIONS);

    const updated = await api(
      `/embeds/${row.id}`,
      admin.cookie,
      { name: 'Homepage agenda v2', options: { ...OPTIONS, showHeader: true } },
      'PUT',
    );
    const updatedRow = (await updated.json()) as Record<string, unknown>;
    expect(updatedRow).toMatchObject({ name: 'Homepage agenda v2', widget: 'agenda' });
    expect((updatedRow.options as Record<string, unknown>).showHeader).toBe(true);

    const deleted = await api(`/embeds/${row.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/embeds/${row.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('rejects unknown widgets and formats, a missing name, and non-object options', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const base = { name: 'X', widget: 'agenda', format: 'script', options: OPTIONS };

    expect((await api('/embeds', admin.cookie, { ...base, widget: 'tickets' })).status).toBe(400);
    expect(await (await api('/embeds', admin.cookie, { ...base, widget: 'tickets' })).json()).toEqual({
      error: 'invalid_widget',
    });
    expect((await api('/embeds', admin.cookie, { ...base, format: 'pdf' })).status).toBe(400);
    expect((await api('/embeds', admin.cookie, { ...base, name: '  ' })).status).toBe(400);
    expect((await api('/embeds', admin.cookie, { ...base, options: 'not-an-object' })).status).toBe(400);
    expect((await api('/embeds', admin.cookie, { ...base, options: null })).status).toBe(400);
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await api('/embeds', reviewer.cookie, { name: 'X', widget: 'agenda', format: 'script', options: OPTIONS });
    expect(res.status).toBe(403);
  });

  it('scopes saved embeds to the event', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');

    const created = await api('/embeds', adminA.cookie, { name: 'A', widget: 'sessions', format: 'json', options: OPTIONS });
    const { id } = (await created.json()) as { id: string };

    expect((await api(`/embeds/${id}`, adminB.cookie, { name: 'Hijacked' }, 'PUT')).status).toBe(404);
    expect((await api(`/embeds/${id}`, adminB.cookie, undefined, 'DELETE')).status).toBe(404);

    const list = await SELF.fetch('https://example.com/app/api/embeds', { headers: { cookie: adminB.cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});
