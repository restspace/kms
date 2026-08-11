// Contact custom fields (SPK-15): per-event field definitions for the
// Speakers tab, plus the values the contacts endpoints read/write against
// them. Mirrors the rooms-tracks-crud.test.ts shape for the definitions CRUD,
// plus a values-round-trip suite for the contacts endpoints.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('contact-fields CRUD', () => {
  it('creates, lists, renames and deletes a field, auto-assigning position', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await api('/contact-fields', admin.cookie, { label: 'Travel preferences', type: 'select', options: ['Coach', 'Business'] });
    expect(first.status).toBe(201);
    const firstRow = (await first.json()) as Record<string, unknown>;
    expect(firstRow).toMatchObject({ label: 'Travel preferences', type: 'select', position: 0, event_id: eventId });
    expect(firstRow.key).toMatch(/^custom_travel_preferences_/);
    expect(JSON.parse(firstRow.options as string)).toEqual(['Coach', 'Business']);

    const second = await api('/contact-fields', admin.cookie, { label: 'Dietary notes', type: 'text' });
    const secondRow = (await second.json()) as Record<string, unknown>;
    expect(secondRow).toMatchObject({ label: 'Dietary notes', type: 'text', options: null, position: 1 });

    const list = await SELF.fetch('https://example.com/app/api/contact-fields', { headers: { cookie: admin.cookie } });
    const { items } = (await list.json()) as { items: Array<{ label: string }> };
    expect(items.map((f) => f.label)).toEqual(['Travel preferences', 'Dietary notes']);

    const renamed = await api(`/contact-fields/${firstRow.id}`, admin.cookie, { label: 'Travel class' }, 'PUT');
    expect(await renamed.json()).toMatchObject({ label: 'Travel class', type: 'select' });

    const deleted = await api(`/contact-fields/${firstRow.id}`, admin.cookie, undefined, 'DELETE');
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await api(`/contact-fields/${firstRow.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(404);
  });

  it('rejects an empty label and an invalid type', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const badLabel = await api('/contact-fields', admin.cookie, { label: '   ', type: 'text' });
    expect(badLabel.status).toBe(400);
    expect(await badLabel.json()).toEqual({ error: 'label_required' });

    const badType = await api('/contact-fields', admin.cookie, { label: 'Field', type: 'nope' });
    expect(badType.status).toBe(400);
    expect(await badType.json()).toEqual({ error: 'invalid_type' });
  });

  it('refuses reviewers', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await api('/contact-fields', reviewer.cookie, { label: 'Field', type: 'text' });
    expect(res.status).toBe(403);
  });

  it('reorders fields by the given id order', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const a = (await (await api('/contact-fields', admin.cookie, { label: 'A', type: 'text' })).json()) as { id: string };
    const b = (await (await api('/contact-fields', admin.cookie, { label: 'B', type: 'text' })).json()) as { id: string };
    const c = (await (await api('/contact-fields', admin.cookie, { label: 'C', type: 'text' })).json()) as { id: string };

    const reordered = await api('/contact-fields/reorder', admin.cookie, { ids: [c.id, a.id, b.id] });
    expect(reordered.status).toBe(200);
    const { items } = (await reordered.json()) as { items: Array<{ label: string }> };
    expect(items.map((f) => f.label)).toEqual(['C', 'A', 'B']);
  });

  it('scopes fields to the event — another event cannot rename or delete them', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const adminB = await seedStaff(eventB, 'admin');

    const created = await api('/contact-fields', adminA.cookie, { label: 'Field', type: 'text' });
    const { id: fieldId } = (await created.json()) as { id: string };

    expect((await api(`/contact-fields/${fieldId}`, adminB.cookie, { label: 'Hijacked' }, 'PUT')).status).toBe(404);
    expect((await api(`/contact-fields/${fieldId}`, adminB.cookie, undefined, 'DELETE')).status).toBe(404);

    const list = await SELF.fetch('https://example.com/app/api/contact-fields', { headers: { cookie: adminB.cookie } });
    expect(((await list.json()) as { items: unknown[] }).items).toEqual([]);
  });
});

describe('contacts custom-field values', () => {
  it('a travel-preferences select and a free-text field round-trip through create, update, and the resource query', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const travelField = (await (await api('/contact-fields', admin.cookie, {
      label: 'Travel preferences', type: 'select', options: ['Coach', 'Business', 'First'],
    })).json()) as { id: string; key: string };
    const notesField = (await (await api('/contact-fields', admin.cookie, {
      label: 'Dietary notes', type: 'multiline',
    })).json()) as { id: string; key: string };

    const created = await api('/contacts', admin.cookie, {
      email: 'speaker@example.com',
      first_name: 'Ada',
      custom_fields: { [travelField.key]: 'Business', [notesField.key]: 'No shellfish' },
    });
    expect(created.status).toBe(201);
    const createdRow = (await created.json()) as { id: string; custom_fields_json: string };
    expect(JSON.parse(createdRow.custom_fields_json)).toEqual({
      [travelField.key]: 'Business',
      [notesField.key]: 'No shellfish',
    });

    // Values land in the dedicated store, not on the contacts row itself.
    const stored = await env.DB.prepare(
      'SELECT field_id, value FROM contact_field_values WHERE contact_id = ? ORDER BY field_id',
    ).bind(createdRow.id).all();
    expect(stored.results.length).toBe(2);

    // Survives the resource query (the Speakers grid / detail read path).
    const queried = await SELF.fetch('https://example.com/app/api/contacts/query', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 0, size: 10, filters: { contact_id: createdRow.id } }),
    });
    const { items } = (await queried.json()) as { items: Array<{ custom_fields_json: string }> };
    expect(JSON.parse(items[0].custom_fields_json)).toEqual({
      [travelField.key]: 'Business',
      [notesField.key]: 'No shellfish',
    });

    // Update: change one value, clear the other.
    const updated = await api(`/contacts/${createdRow.id}`, admin.cookie, {
      custom_fields: { [travelField.key]: 'First', [notesField.key]: null },
    }, 'PUT');
    expect(updated.status).toBe(200);
    const updatedRow = (await updated.json()) as { custom_fields_json: string | null };
    expect(JSON.parse(updatedRow.custom_fields_json ?? '{}')).toEqual({ [travelField.key]: 'First' });
  });

  it('rejects an unknown custom-field key without creating the contact', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await api('/contacts', admin.cookie, {
      email: 'nope@example.com',
      custom_fields: { not_a_real_field: 'value' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_field', field: 'not_a_real_field' });

    // A create would have written both halves of a 0015 contact: the org-level
    // identity and this event's event_contacts row. Neither may exist.
    const row = await env.DB.prepare(
      `SELECT id FROM contacts
        WHERE org_id = (SELECT org_id FROM events WHERE id = ?) AND email = ?`,
    ).bind(eventId, 'nope@example.com').first();
    expect(row).toBeNull();
    const roster = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM event_contacts ec
         JOIN contacts c ON c.id = ec.contact_id
        WHERE ec.event_id = ? AND c.email = ?`,
    ).bind(eventId, 'nope@example.com').first<{ n: number }>();
    expect(roster?.n).toBe(0);
  });

  it('rejects a value outside a select field\'s options', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const travelField = (await (await api('/contact-fields', admin.cookie, {
      label: 'Travel preferences', type: 'select', options: ['Coach', 'Business'],
    })).json()) as { key: string };

    const res = await api('/contacts', admin.cookie, {
      email: 'speaker2@example.com',
      custom_fields: { [travelField.key]: 'First class, private jet' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_option', field: travelField.key });
  });

  it('rejects an unknown key on update, and scopes values to the event', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const adminA = await seedStaff(eventA, 'admin');
    const contactId = await seedContact(eventA);

    const fieldB = (await (await api('/contact-fields', (await seedStaff(eventB, 'admin')).cookie, {
      label: 'Only in B', type: 'text',
    })).json()) as { key: string };

    const res = await api(`/contacts/${contactId}`, adminA.cookie, {
      custom_fields: { [fieldB.key]: 'value' },
    }, 'PUT');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_field', field: fieldB.key });
  });

  it('deleting a field definition cascades its values without touching the contact', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const field = (await (await api('/contact-fields', admin.cookie, { label: 'Field', type: 'text' })).json()) as { id: string; key: string };
    const contactId = await seedContact(eventId);
    await api(`/contacts/${contactId}`, admin.cookie, { custom_fields: { [field.key]: 'value' } }, 'PUT');

    expect((await api(`/contact-fields/${field.id}`, admin.cookie, undefined, 'DELETE')).status).toBe(200);

    const values = await env.DB.prepare('SELECT * FROM contact_field_values WHERE contact_id = ?').bind(contactId).all();
    expect(values.results).toEqual([]);
    const contact = await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(contactId).first();
    expect(contact).toBeTruthy();
  });
});
