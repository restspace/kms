// Idempotency-Key on POSTs (work item 3, docs/10 §1b): replay returns the
// exact stored response and never re-executes; a key reused with a different
// body is a client bug, surfaced as 422 rather than silently doing the wrong
// thing.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createEvent } from './fixtures';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

describe('Idempotency-Key', () => {
  it('replays the identical response and creates no duplicate row', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);
    const key = 'contact-create-1';

    const first = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'ada@example.com' }, 'POST', { 'Idempotency-Key': key }),
    );
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { id: string; email: string };
    expect(first.headers.get('Idempotency-Replayed')).toBeNull();

    const second = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'ada@example.com' }, 'POST', { 'Idempotency-Key': key }),
    );
    expect(second.status).toBe(201);
    expect(second.headers.get('Idempotency-Replayed')).toBe('true');
    const secondBody = await second.json() as { id: string; email: string };
    expect(secondBody).toEqual(firstBody);

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM contacts WHERE event_id = ?')
      .bind(eventId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('rejects the same key reused with a different body as 422 idempotency_mismatch', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);
    const key = 'contact-create-2';

    const first = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'first@example.com' }, 'POST', { 'Idempotency-Key': key }),
    );
    expect(first.status).toBe(201);

    const second = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts`,
      bearerReq(token, { email: 'second@example.com' }, 'POST', { 'Idempotency-Key': key }),
    );
    expect(second.status).toBe(422);
    const body = await second.json() as { error: { code: string } };
    expect(body.error.code).toBe('idempotency_mismatch');

    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM contacts WHERE event_id = ?')
      .bind(eventId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});
