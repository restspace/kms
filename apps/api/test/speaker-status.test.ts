// SPK-04: settable speaker workflow status. PUT /contacts/:id writes
// event_contacts.speaker_status (vocabulary-checked against the built-ins
// plus this event's speaker_status_options), and the contacts resource's
// speaker_status column/filter reads it back with a fallback to the same
// confirmed/awaiting_reply derivation the (untouched) `confirmation` column
// already computes.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

const query = async (cookie: string, resource: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`https://example.com/app/api/${resource}/query`, jsonReq(cookie, body));
  return { status: res.status, body: (await res.json()) as { items: Array<Record<string, unknown>>; total: number } };
};

describe('PUT /app/api/contacts/:id — speaker_status', () => {
  it('sets speaker_status and records the prior value in a revision row', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, { email: 'a@example.com' });

    const first = await api(`/contacts/${contactId}`, admin.cookie, { speaker_status: 'invited' }, 'PUT');
    expect(first.status).toBe(200);
    expect((await first.json() as Record<string, unknown>).speaker_status).toBe('invited');

    const second = await api(`/contacts/${contactId}`, admin.cookie, { speaker_status: 'confirmed' }, 'PUT');
    expect(second.status).toBe(200);
    expect((await second.json() as Record<string, unknown>).speaker_status).toBe('confirmed');

    const revision = await env.DB.prepare(
      "SELECT payload FROM content_revisions WHERE entity_type = 'contact' AND entity_id = ? ORDER BY edited_at DESC LIMIT 1",
    )
      .bind(contactId)
      .first<{ payload: string }>();
    expect(revision).toBeTruthy();
    expect(JSON.parse(revision!.payload)).toMatchObject({ speaker_status: 'invited' });
  });

  it('rejects an unknown status', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, { email: 'b@example.com' });

    const res = await api(`/contacts/${contactId}`, admin.cookie, { speaker_status: 'bogus' }, 'PUT');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_speaker_status' });
  });

  it('accepts a custom option after POST /speaker-statuses', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, { email: 'c@example.com' });

    const optionRes = await api('/speaker-statuses', admin.cookie, { label: 'On the fence' });
    expect(optionRes.status).toBe(201);
    const option = (await optionRes.json()) as { key: string; label: string };
    expect(option.key).toBe('on_the_fence');

    const res = await api(`/contacts/${contactId}`, admin.cookie, { speaker_status: option.key }, 'PUT');
    expect(res.status).toBe(200);
    expect((await res.json() as Record<string, unknown>).speaker_status).toBe('on_the_fence');
  });

  it('rejects an empty label and a colliding key', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    expect((await api('/speaker-statuses', admin.cookie, { label: '  ' })).status).toBe(400);

    const first = await api('/speaker-statuses', admin.cookie, { label: 'Backup' });
    expect(first.status).toBe(201);
    const second = await api('/speaker-statuses', admin.cookie, { label: 'Backup' });
    expect(second.status).toBe(400);
    expect(await second.json()).toEqual({ error: 'key_exists' });
  });
});

describe('POST /app/api/contacts/query — speaker_status filter', () => {
  it('an explicit status beats the derivation', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });
    const contactId = await seedContact(eventId, { email: 'd@example.com' });
    await env.DB.prepare(
      'INSERT INTO submission_participants (submission_id, contact_id, role, confirmed_at) VALUES (?, ?, ?, ?)',
    )
      .bind(submissionId, contactId, 'speaker', '2026-08-01T00:00:00Z')
      .run();
    // Derivation would read 'confirmed'; the hand-set value overrides it.
    await api(`/contacts/${contactId}`, admin.cookie, { speaker_status: 'declined' }, 'PUT');

    const confirmedQuery = await query(admin.cookie, 'contacts', { size: 50, filters: { speaker_status: 'confirmed' } });
    expect(confirmedQuery.body.items.map((r) => r.email)).not.toContain('d@example.com');

    const declinedQuery = await query(admin.cookie, 'contacts', { size: 50, filters: { speaker_status: 'declined' } });
    expect(declinedQuery.body.items.map((r) => r.email)).toContain('d@example.com');
  });

  it('an unset speaker_status falls back to the derivation — confirmed participant reads confirmed', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });
    const contactId = await seedContact(eventId, { email: 'e@example.com' });
    await env.DB.prepare(
      'INSERT INTO submission_participants (submission_id, contact_id, role, confirmed_at) VALUES (?, ?, ?, ?)',
    )
      .bind(submissionId, contactId, 'speaker', '2026-08-01T00:00:00Z')
      .run();

    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { speaker_status: 'confirmed' } });
    expect(body.items.map((r) => r.email)).toContain('e@example.com');
  });

  it('a non-participant with no hand-set status matches nothing for the confirmed filter', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedContact(eventId, { email: 'f@example.com' });

    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { speaker_status: 'confirmed' } });
    expect(body.items.map((r) => r.email)).not.toContain('f@example.com');
  });
});
