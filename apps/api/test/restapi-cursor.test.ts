// Cursor pagination on the generic list endpoint (work item 1, docs/10 §1a).
// Stability under concurrent inserts is the whole point of keyset pagination
// over offset — this asserts it holds, and that a tampered cursor is a 400.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent } from './fixtures';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

// Since 0015 a contact is org-level and its event membership is a separate
// event_contacts row, so seeding is the shared fixture's job rather than a
// single local INSERT. The listing this file paginates reads event_contacts.
const seedContact = (eventId: string, email: string): Promise<string> =>
  createContact(eventId, { email });

describe('GET /events/:event_id/:resource — cursor pagination', () => {
  it('iterates every pre-existing row exactly once, even with an insert mid-iteration', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const preExisting: string[] = [];
    for (let i = 0; i < 6; i++) {
      preExisting.push(await seedContact(eventId, `pre-${i}@example.com`));
    }

    const seen: string[] = [];
    let cursor = '';
    let page = 0;
    while (page < 10) {
      const res = await SELF.fetch(
        `https://example.com/api/v1/events/${eventId}/contacts?limit=2&cursor=${encodeURIComponent(cursor)}`,
        bearerReq(token),
      );
      expect(res.status).toBe(200);
      const body = await res.json() as { data: { id: string }[]; next_cursor: string | null };
      for (const row of body.data) seen.push(row.id);
      page++;

      // Insert an extra row after the first page — it must not disturb the
      // pages already iterated, nor cause a pre-existing row to repeat.
      if (page === 1) await seedContact(eventId, 'mid-iteration@example.com');

      if (!body.next_cursor) break;
      cursor = body.next_cursor;
    }

    // Every pre-existing contact was seen exactly once; no duplicates.
    expect(seen.length).toBe(new Set(seen).size);
    for (const id of preExisting) expect(seen).toContain(id);
  });

  it('rejects an invalid cursor with 400 invalid_cursor', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/contacts?cursor=not-a-valid-cursor!!`,
      bearerReq(token),
    );
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_cursor');
  });

  it('offset mode (no cursor param) still works and is unaffected', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);
    await seedContact(eventId, 'a@example.com');
    await seedContact(eventId, 'b@example.com');

    const res = await SELF.fetch(`https://example.com/api/v1/events/${eventId}/contacts?limit=1`, bearerReq(token));
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; total: number; offset: number; next_cursor: null };
    expect(body.total).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.next_cursor).toBeNull();
  });
});
