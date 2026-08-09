// Core CRUD (work item 2): contact round-trip incl. the email_exists 409, and
// a cross-event track_id on submission create surfacing as 400 validation
// (never a silent cross-tenant write or a DB-level FK error).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createEvent } from './fixtures';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

describe('Contacts CRUD (/api/v1)', () => {
  it('creates, updates, and deletes a contact', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const create = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'ADA@Example.com', first_name: 'Ada' }, 'POST'),
    );
    expect(create.status).toBe(201);
    const created = await create.json() as { id: string; email: string; first_name: string };
    expect(created.email).toBe('ada@example.com'); // lowercased on write

    const update = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts/${created.id}`,
      bearerReq(token, { last_name: 'Lovelace' }, 'PUT'),
    );
    expect(update.status).toBe(200);
    const updated = await update.json() as { last_name: string; email: string };
    expect(updated.last_name).toBe('Lovelace');
    expect(updated.email).toBe('ada@example.com'); // untouched fields survive a partial update

    const del = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts/${created.id}`,
      bearerReq(token, undefined, 'DELETE'),
    );
    expect(del.status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(created.id).first()).toBeNull();
  });

  it('rejects a duplicate email in the same event with 409 email_exists', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const first = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'dup@example.com' }, 'POST'),
    );
    expect(first.status).toBe(201);

    const second = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'dup@example.com' }, 'POST'),
    );
    expect(second.status).toBe(409);
    const body = await second.json() as { error: { code: string } };
    expect(body.error.code).toBe('email_exists');
  });

  it('requires a valid email on create', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const missing = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { first_name: 'No Email' }, 'POST'),
    );
    expect(missing.status).toBe(400);

    const malformed = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'not-an-email' }, 'POST'),
    );
    expect(malformed.status).toBe(400);
    const body = await malformed.json() as { error: { code: string } };
    expect(body.error.code).toBe('validation');
  });
});

describe('Submissions create (/api/v1)', () => {
  it('rejects a track_id that belongs to a different event with 400', async () => {
    const eventId = await createEvent();
    const otherEventId = await createEvent({ id: 'evt-other', org_id: 'org-test-1' });
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const foreignTrack = 'trk-foreign';
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(foreignTrack, otherEventId, 'Foreign track')
      .run();

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/submissions`,
      bearerReq(token, { title: 'A talk', track_id: foreignTrack }, 'POST'),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string; details: { field: string }[] } };
    expect(body.error.code).toBe('validation');
    expect(body.error.details.some((d) => d.field === 'track_id')).toBe(true);
  });

  it('creates a manual submission with an in-event track_id and an allocated code', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const trackId = 'trk-in-event';
    await env.DB.prepare('INSERT INTO tracks (id, event_id, name, position) VALUES (?, ?, ?, 0)')
      .bind(trackId, eventId, 'Agents')
      .run();

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/submissions`,
      bearerReq(token, { title: 'Shipping agents that don\'t melt', track_id: trackId }, 'POST'),
    );
    expect(res.status).toBe(201);
    const body = await res.json() as { code: string; status: string; source: string; track_id: string };
    expect(body.code).toMatch(/^SESS-\d+$/);
    expect(body.status).toBe('pending');
    expect(body.source).toBe('manual');
    expect(body.track_id).toBe(trackId);
  });
});
