// Workspace query endpoint: cross-event scoping (event-as-filter) and keyset
// pagination (sweep item P2-18).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff, seedSubmission } from './fixtures-admin';
import { attachContactToEvent } from './fixtures';

interface QueryResponse {
  items: Array<Record<string, unknown>>;
  total: number;
  next_cursor: string | null;
}

const query = async (cookie: string, resource: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch(`https://example.com/app/api/${resource}/query`, jsonReq(cookie, body));
  return { status: res.status, body: (await res.json()) as QueryResponse & { error?: string } };
};

/** One admin email holding seats in two events of the same org, plus a third
 * event in an unrelated org that the same email also administers. */
async function seedWorkspace() {
  const tag = crypto.randomUUID().slice(0, 8);
  const eventA = await seedEvent({ org_id: `org-a-${tag}`, name: "Event A", slug: `event-a-${tag}` });
  const eventB = await seedEvent({ org_id: `org-a-${tag}`, name: "Event B", slug: `event-b-${tag}` });
  const eventC = await seedEvent({ org_id: `org-z-${tag}`, name: "Event C", slug: `event-c-${tag}` });

  const admin = await seedStaff(eventA, 'admin', 'admin@example.com');
  // Since 0015 a person is one contact per ORG, so the Event B seat is the same
  // contact with a second event_contacts row — not a second contact record.
  // Event C is a different org, so there the email is genuinely a separate person.
  await attachContactToEvent(eventB, admin.contactId);
  await seedEventUser(eventB, admin.contactId, 'admin');
  await seedEventUser(eventC, await seedContact(eventC, { email: 'admin@example.com' }), 'admin');

  await seedContact(eventA, { email: 'a-speaker@example.com', last_name: 'Aardvark' });
  await seedContact(eventB, { email: 'b-speaker@example.com', last_name: 'Baboon' });
  await seedContact(eventC, { email: 'c-speaker@example.com', last_name: 'Coyote' });

  return { eventA, eventB, eventC, admin };
}

describe('POST /app/api/:resource/query — event scope', () => {
  it('spans every event in the org by default and carries event_name', async () => {
    const { eventA, eventB, admin } = await seedWorkspace();
    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: {} });

    const emails = body.items.map((r) => r.email);
    expect(emails).toContain('a-speaker@example.com');
    expect(emails).toContain('b-speaker@example.com');
    // A different organisation is never in scope, seat or no seat.
    expect(emails).not.toContain('c-speaker@example.com');

    const rowA = body.items.find((r) => r.email === 'a-speaker@example.com');
    const rowB = body.items.find((r) => r.email === 'b-speaker@example.com');
    expect(rowA).toMatchObject({ event_id: eventA, event_name: 'Event A' });
    expect(rowB).toMatchObject({ event_id: eventB, event_name: 'Event B' });
  });

  it('narrows to one event through filters.event_id', async () => {
    const { eventB, admin } = await seedWorkspace();
    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { event_id: eventB } });
    expect(body.items.every((r) => r.event_id === eventB)).toBe(true);
    expect(body.items.map((r) => r.email)).toContain('b-speaker@example.com');
    expect(body.total).toBe(body.items.length);
  });

  it('refuses an event_id outside the accessible set', async () => {
    const { eventC, admin } = await seedWorkspace();
    const { status, body } = await query(admin.cookie, 'contacts', { filters: { event_id: eventC } });
    expect(status).toBe(403);
    expect(body.error).toBe('event_not_accessible');
  });
});

describe('POST /app/api/:resource/query — keyset pagination', () => {
  it('walks pages without duplicates or skips when a row is inserted mid-iteration', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    for (const n of [1, 2, 3, 4, 5, 6]) {
      await seedSubmission(eventId, {
        code: `SESS-${n}`,
        title: `Talk ${n}`,
        created_at: `2026-07-0${n}T00:00:00Z`,
      });
    }

    const seen: string[] = [];
    let cursor: string | null = '';
    for (let page = 0; page < 3; page++) {
      const { body }: { body: QueryResponse } = await query(admin.cookie, 'submissions', {
        size: 2,
        filters: {},
        sort: { field: 'code', direction: 'asc' },
        cursor,
      });
      seen.push(...body.items.map((r) => String(r.code)));
      cursor = body.next_cursor;
      // A concurrent create between pages must not shift the window.
      if (page === 0) {
        await seedSubmission(eventId, { code: 'SESS-0', title: 'Inserted', created_at: '2026-07-09T00:00:00Z' });
      }
    }

    expect(new Set(seen).size).toBe(seen.length); // no duplicates
    expect(seen).toEqual(['SESS-1', 'SESS-2', 'SESS-3', 'SESS-4', 'SESS-5', 'SESS-6']);
  });

  it('rejects a tampered cursor', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const { status, body } = await query(admin.cookie, 'contacts', { size: 2, filters: {}, cursor: 'not-a-cursor!!' });
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_cursor');
  });

  it('keeps offset mode working and reports next_cursor: null there', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedContact(eventId, { email: 'one@example.com' });
    await seedContact(eventId, { email: 'two@example.com' });

    const { body } = await query(admin.cookie, 'contacts', { from: 0, size: 1, filters: {} });
    expect(body.items).toHaveLength(1);
    expect(body.total).toBeGreaterThanOrEqual(3); // two speakers + the admin
    expect(body.next_cursor).toBeNull();
  });

  it('sorts submissions by the cached rating, not a correlated aggregate', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const plan = `plan-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
    ).bind(plan, eventId, '2026-08-01T00:00:00Z').run();
    const low = await seedSubmission(eventId, { code: 'SESS-LOW' });
    const high = await seedSubmission(eventId, { code: 'SESS-HIGH' });
    for (const [id, value] of [[low, 2.5], [high, 4.75]] as const) {
      await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ?, rating_cache = ? WHERE id = ?')
        .bind(plan, JSON.stringify({ [plan]: value }), id)
        .run();
    }

    const { body } = await query(admin.cookie, 'submissions', {
      size: 10,
      filters: {},
      sort: { field: 'rating', direction: 'desc' },
    });
    expect(body.items.map((r) => r.code)).toEqual(['SESS-HIGH', 'SESS-LOW']);
  });

  it('sorts an unscored submission last on rating, in both directions', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const plan = `plan-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
    ).bind(plan, eventId, '2026-08-01T00:00:00Z').run();
    const low = await seedSubmission(eventId, { code: 'SESS-LOW' });
    const high = await seedSubmission(eventId, { code: 'SESS-HIGH' });
    const unscored = await seedSubmission(eventId, { code: 'SESS-NONE' });
    for (const [id, value] of [[low, 2.5], [high, 4.75]] as const) {
      await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ?, rating_cache = ? WHERE id = ?')
        .bind(plan, JSON.stringify({ [plan]: value }), id)
        .run();
    }
    // The unscored submission still carries the plan (so `rating` resolves via
    // json_extract) but has no rating_cache entry for it — NULL, not zero.
    await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ? WHERE id = ?').bind(plan, unscored).run();

    const asc = await query(admin.cookie, 'submissions', {
      size: 10,
      filters: {},
      sort: { field: 'rating', direction: 'asc' },
    });
    expect(asc.body.items.map((r) => r.code)).toEqual(['SESS-LOW', 'SESS-HIGH', 'SESS-NONE']);

    const desc = await query(admin.cookie, 'submissions', {
      size: 10,
      filters: {},
      sort: { field: 'rating', direction: 'desc' },
    });
    expect(desc.body.items.map((r) => r.code)).toEqual(['SESS-HIGH', 'SESS-LOW', 'SESS-NONE']);
  });
});

describe('POST /app/api/:resource/query — contacts confirmation (SPK-04)', () => {
  /** Three contacts: one with a confirmed submission_participants row, one
   * with only an unconfirmed row, and one that is not a participant at all. */
  async function seedRoster() {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submission = await seedSubmission(eventId);

    const tag = crypto.randomUUID().slice(0, 8);
    const confirmed = await seedContact(eventId, { email: 'confirmed@example.com', last_name: 'Aardvark' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, confirmed_at)
       VALUES (?, ?, ?, 'speaker', 0, '2026-08-01T00:00:00Z')`,
    ).bind(`sp-confirmed-${tag}`, submission, confirmed).run();

    const awaiting = await seedContact(eventId, { email: 'awaiting@example.com', last_name: 'Baboon' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position)
       VALUES (?, ?, ?, 'co-speaker', 1)`,
    ).bind(`sp-awaiting-${tag}`, submission, awaiting).run();

    const bystander = await seedContact(eventId, { email: 'bystander@example.com', last_name: 'Coyote' });

    return { admin, confirmed, awaiting, bystander };
  }

  it('reports the confirmation column: confirmed / awaiting / none', async () => {
    const { admin } = await seedRoster();
    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: {} });

    const byEmail = new Map(body.items.map((r) => [r.email, r.confirmation]));
    expect(byEmail.get('confirmed@example.com')).toBe('confirmed');
    expect(byEmail.get('awaiting@example.com')).toBe('awaiting');
    expect(byEmail.get('bystander@example.com')).toBeNull();
  });

  it('filters to confirmed only', async () => {
    const { admin } = await seedRoster();
    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { confirmation: 'confirmed' } });

    const emails = body.items.map((r) => r.email);
    expect(emails).toEqual(['confirmed@example.com']);
  });

  it('filters to awaiting only, excluding confirmed and non-participants', async () => {
    const { admin } = await seedRoster();
    const { body } = await query(admin.cookie, 'contacts', { size: 50, filters: { confirmation: 'awaiting' } });

    const emails = body.items.map((r) => r.email);
    expect(emails).toEqual(['awaiting@example.com']);
  });
});

describe('POST /app/api/switch-event', () => {
  it('refuses an event outside the accessible set', async () => {
    const { eventC, admin } = await seedWorkspace();
    const res = await SELF.fetch('https://example.com/app/api/switch-event', jsonReq(admin.cookie, { event_id: eventC }));
    expect(res.status).toBe(403);
  });

  it('switches to a sibling event in the same org', async () => {
    const { eventB, admin } = await seedWorkspace();
    const res = await SELF.fetch('https://example.com/app/api/switch-event', jsonReq(admin.cookie, { event_id: eventB }));
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('kms_session=');
  });

  it('lists every accessible event on /me', async () => {
    const { admin } = await seedWorkspace();
    const res = await SELF.fetch('https://example.com/app/api/me', { headers: { cookie: admin.cookie } });
    const body = (await res.json()) as { events: Array<{ name: string }> };
    expect(body.events.map((e) => e.name).sort()).toEqual(['Event A', 'Event B']);
  });
});
