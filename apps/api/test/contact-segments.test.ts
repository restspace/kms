// CRM-09: saved Speaker-roster segments — CRUD plus the segment_id / contact_ids
// contacts-resource filters that make a segment actually narrow the roster.
// Mirrors rooms-tracks-crud.test.ts's shape.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

const query = async (cookie: string, resource: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`https://example.com/app/api/${resource}/query`, jsonReq(cookie, body));
  return { status: res.status, body: (await res.json()) as { items: Array<Record<string, unknown>>; total: number } };
};

describe('contact segments CRUD', () => {
  it('creates, lists, renames and deletes a segment', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/contact-segments', admin.cookie, {
      name: 'VIP speakers',
      kind: 'dynamic',
      filters: { confirmation: 'confirmed' },
    });
    expect(created.status).toBe(201);
    const row = (await created.json()) as Record<string, unknown>;
    expect(row).toMatchObject({ name: 'VIP speakers', kind: 'dynamic', event_id: eventId, created_by: admin.contactId });
    expect(JSON.parse(row.filters as string)).toEqual({ confirmation: 'confirmed' });

    const list = await SELF.fetch('https://example.com/app/api/contact-segments', { headers: { cookie: admin.cookie } });
    const { items } = (await list.json()) as { items: Array<{ name: string }> };
    expect(items.map((s) => s.name)).toEqual(['VIP speakers']);

    const renamed = await api(`/contact-segments/${row.id}`, admin.cookie, { name: 'VIPs' }, 'PUT');
    expect((await renamed.json())).toMatchObject({ name: 'VIPs' });

    const deleted = await api(`/contact-segments/${row.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/contact-segments/${row.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('refuses reviewers on write', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    expect((await api('/contact-segments', reviewer.cookie, { name: 'X' })).status).toBe(403);
  });

  it('scopes segments to the event — another event 404s on PUT/DELETE', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');

    const created = await api('/contact-segments', adminA.cookie, { name: 'A segment' });
    const { id } = (await created.json()) as { id: string };

    expect((await api(`/contact-segments/${id}`, adminB.cookie, { name: 'Hijacked' }, 'PUT')).status).toBe(404);
    expect((await api(`/contact-segments/${id}`, adminB.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('rejects an empty name, invalid kind, non-object filters, and a non-string-array member_ids', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    expect((await api('/contact-segments', admin.cookie, { name: '  ' })).status).toBe(400);
    expect((await api('/contact-segments', admin.cookie, { name: 'X', kind: 'bogus' })).status).toBe(400);
    expect((await api('/contact-segments', admin.cookie, { name: 'X', filters: 'not-an-object' })).status).toBe(400);
    expect((await api('/contact-segments', admin.cookie, { name: 'X', filters: ['a'] })).status).toBe(400);
    expect((await api('/contact-segments', admin.cookie, { name: 'X', member_ids: 'nope' })).status).toBe(400);
    expect((await api('/contact-segments', admin.cookie, { name: 'X', member_ids: [1, 2] })).status).toBe(400);
  });
});

describe('POST /app/api/contacts/query with segment_id / contact_ids filters', () => {
  it('segment_id returns exactly the curated segment members', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const alice = await seedContact(eventId, { email: 'alice@example.com', last_name: 'Alpha' });
    const bob = await seedContact(eventId, { email: 'bob@example.com', last_name: 'Beta' });
    await seedContact(eventId, { email: 'carol@example.com', last_name: 'Gamma' });

    const created = await api('/contact-segments', admin.cookie, {
      name: 'Curated pair',
      kind: 'curated',
      member_ids: [alice, bob],
    });
    const { id: segmentId } = (await created.json()) as { id: string };

    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { segment_id: segmentId } });
    expect(body.items.map((r) => r.email).sort()).toEqual(['alice@example.com', 'bob@example.com']);
  });

  it('contact_ids returns exactly those contacts', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const alice = await seedContact(eventId, { email: 'alice2@example.com' });
    await seedContact(eventId, { email: 'bob2@example.com' });

    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { contact_ids: [alice] } });
    expect(body.items.map((r) => r.email)).toEqual(['alice2@example.com']);
  });

  it('a segment from another event matches nothing', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');
    const bobInB = await seedContact(eventB, { email: 'bob-b@example.com' });

    const created = await api('/contact-segments', adminB.cookie, { name: 'B segment', kind: 'curated', member_ids: [bobInB] });
    const { id: segmentId } = (await created.json()) as { id: string };

    // Querying event A's roster with event B's segment id — no membership row
    // in this event's scope, so it matches nothing.
    const { body } = await query(adminA.cookie, 'contacts', { size: 50, filters: { segment_id: segmentId } });
    expect(body.items).toEqual([]);
  });
});
