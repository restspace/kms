// The org-level contact directory: POST /app/api/contacts/query with a
// top-level `scope: 'org'`, and its write-side counterpart, an org-only
// POST /app/api/contacts (`no_event: true`).
//
// The distinction under test throughout is roster vs directory. The registry's
// contacts resource is a roster — one row per event_contacts membership, and a
// person on nobody's roster is invisible. Org mode answers the other question,
// "who does this organisation know", so the assertions that matter are the ones
// no roster query could pass: a membership-less contact present, a two-event
// person collapsed to ONE row, and the profile columns resolved to the most
// recent membership rather than an arbitrary one.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { attachContactToEvent } from './fixtures';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff } from './fixtures-admin';

interface QueryResponse {
  items: Array<Record<string, unknown>>;
  total: number;
  next_cursor: string | null;
  error?: string;
}

const query = async (cookie: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch('https://example.com/app/api/contacts/query', jsonReq(cookie, body));
  return { status: res.status, body: (await res.json()) as QueryResponse };
};

const orgQuery = (cookie: string, body: Record<string, unknown> = {}) =>
  query(cookie, { size: 200, filters: {}, ...body, scope: 'org' });

const row = (res: QueryResponse, id: string) => res.items.find((r) => r.id === id);

/** event_contacts.added_at is what "most recent membership" means; the fixtures
 * stamp every row with the same timestamp, so the tests that care set it. */
const setAddedAt = (eventId: string, contactId: string, addedAt: string) =>
  env.DB.prepare('UPDATE event_contacts SET added_at = ? WHERE event_id = ? AND contact_id = ?')
    .bind(addedAt, eventId, contactId)
    .run();

/**
 * One org, two events (the admin seated on the first only), and four kinds of
 * person: on both events, on one, on none, and merged away.
 */
async function seedDirectory() {
  const orgId = `org-${crypto.randomUUID()}`;
  const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
  const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
  const admin = await seedStaff(eventA, 'admin');

  // On both events. Beta is the more recent membership, so ITS profile is the
  // one the directory row must show.
  const twice = await seedContact(eventA, {
    email: 'twice@example.com', first_name: 'Ada', last_name: 'Lovelace',
    company: 'Alpha Corp', job_title: 'Engineer', biography: 'Alpha bio', notes: 'Alpha notes',
  });
  await attachContactToEvent(eventB, twice, {
    company: 'Beta Corp', job_title: 'CTO', biography: 'Beta bio', notes: 'Beta notes',
  });
  await setAddedAt(eventA, twice, '2026-01-01T00:00:00Z');
  await setAddedAt(eventB, twice, '2026-06-01T00:00:00Z');

  const onlyB = await seedContact(eventB, {
    email: 'only-b@example.com', last_name: 'Babbage', company: 'Beta Corp',
  });

  // No event_contacts row at all — org-level only. Invisible to every roster
  // query in the codebase, which is exactly the point of the directory.
  const orphan = `con-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at)
     VALUES (?, ?, 'orphan@example.com', 'Grace', 'Hopper', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).bind(orphan, orgId).run();

  // A merge tombstone (0030) also has no memberships, so it would resurface
  // here for exactly the same reason the orphan does — unless filtered.
  const tombstone = await seedContact(eventA, { email: 'merged@example.com', last_name: 'Ghost' });
  await env.DB.prepare('DELETE FROM event_contacts WHERE contact_id = ?').bind(tombstone).run();
  await env.DB.prepare('UPDATE contacts SET merged_into = ? WHERE id = ?').bind(twice, tombstone).run();

  return { orgId, eventA, eventB, admin, twice, onlyB, orphan, tombstone };
}

describe('POST /app/api/contacts/query — scope: org', () => {
  it('returns one row per person for the whole org, memberships folded in', async () => {
    const { eventA, eventB, admin, twice, onlyB, orphan, tombstone } = await seedDirectory();
    const { status, body } = await orgQuery(admin.cookie);
    expect(status, JSON.stringify(body)).toBe(200);

    // One row per contact, not per membership.
    expect(body.items.filter((r) => r.id === twice)).toHaveLength(1);
    expect(body.total).toBe(body.items.length);

    const both = row(body, twice)!;
    expect(both.event_count).toBe(2);
    expect(JSON.parse(both.events_json as string)).toEqual(['Beta Summit', 'Alpha Conf']);
    // Most-recent-membership wins across every profile column.
    expect(both).toMatchObject({
      company: 'Beta Corp', job_title: 'CTO', biography: 'Beta bio', notes: 'Beta notes',
    });
    // The row is a person, not a membership, so it names no event of its own;
    // `confirmation` is a cross-submission tally with no org-level answer.
    expect(both.event_id).toBeNull();
    expect(both.event_name).toBeNull();
    expect(both.confirmation).toBeNull();
    // SPK-15: speaker_status and custom_fields_json are the most-recent
    // membership's answer (like company/job_title/biography above), and the
    // row says which membership that was — reading them as NULL is what made
    // the directory panel show "Status —" for a speaker who has one.
    expect(both.profile_event_id).toBe(eventB);
    expect(both.profile_event_name).toBe('Beta Summit');
    expect(both.custom_fields_json).toBe('{}');
    // Identity columns still come straight off `contacts`.
    expect(both).toMatchObject({ email: 'twice@example.com', first_name: 'Ada', last_name: 'Lovelace' });

    // Present despite the caller holding no seat on Event B: the directory is
    // the ORGANISATION's, and its rows name no event the caller cannot see.
    const single = row(body, onlyB)!;
    expect(single.event_count).toBe(1);
    expect(single.company).toBe('Beta Corp');
    expect(JSON.parse(single.events_json as string)).toEqual(['Beta Summit']);

    // The row no roster query can produce.
    const none = row(body, orphan)!;
    expect(none.event_count).toBe(0);
    expect(JSON.parse(none.events_json as string)).toEqual([]);
    expect(none.company).toBeNull();
    expect(none.job_title).toBeNull();

    // Membership-less, like the orphan — but merged away, so still gone.
    expect(row(body, tombstone)).toBeUndefined();

    void eventA;
    void eventB;
  });

  // Eval defect #6b: event_count previously counted bare event_contacts rows
  // while events_json required a live `events` row via an inner join. A
  // membership left behind by a deleted event (orphaned event_contacts) then
  // counted in event_count but not events_json, so the directory grid showed
  // "N events" while the detail panel's "Events:" line, built from
  // events_json, said "On no event yet" for the very same person. Both
  // columns must now agree.
  it('keeps event_count and events_json in agreement when a membership points at a deleted event', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const home = await seedEvent({ org_id: orgId, name: 'Home Conf' });
    const doomed = await seedEvent({ org_id: orgId, name: 'Doomed Conf' });
    const admin = await seedStaff(home, 'admin');
    const contactId = await seedContact(doomed, { email: 'orphan-membership@example.com' });

    // Simulate a deleted event: the event_contacts row survives, the events
    // row does not (the admin's own home event is untouched, so their
    // session/org lookup stays valid).
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(doomed).run();

    const { body } = await orgQuery(admin.cookie);
    const found = row(body, contactId);
    expect(found).toBeDefined();
    expect(found!.event_count).toBe(0);
    expect(JSON.parse(found!.events_json as string)).toEqual([]);
  });

  it('never crosses the organisation boundary', async () => {
    const { admin } = await seedDirectory();
    const otherOrgEvent = await seedEvent();
    const stranger = await seedContact(otherOrgEvent, { email: 'stranger@example.com', last_name: 'Ger' });

    const { body } = await orgQuery(admin.cookie);
    expect(row(body, stranger)).toBeUndefined();
    // Not through the search box either.
    expect(row((await orgQuery(admin.cookie, { filters: { q: 'Ger' } })).body, stranger)).toBeUndefined();
  });

  it('keeps q, the sortable keys and the default sort working', async () => {
    const { admin, twice, orphan } = await seedDirectory();

    // Name, email and the coalesced company all feed q.
    expect(row((await orgQuery(admin.cookie, { filters: { q: 'Lovelace' } })).body, twice)).toBeDefined();
    expect(row((await orgQuery(admin.cookie, { filters: { q: 'orphan@example' } })).body, orphan)).toBeDefined();
    const byCompany = (await orgQuery(admin.cookie, { filters: { q: 'Beta Corp' } })).body;
    expect(row(byCompany, twice)).toBeDefined();
    expect(row(byCompany, orphan)).toBeUndefined();

    // Default sort is last_name, first_name ascending — same as event mode.
    const names = (await orgQuery(admin.cookie)).body.items.map((r) => r.last_name as string);
    expect(names).toEqual([...names].sort());

    // company sorts against the coalesced expression, not a per-event column.
    const sorted = (await orgQuery(admin.cookie, { sort: { field: 'company', direction: 'asc' } })).body.items;
    const companies = sorted.map((r) => r.company).filter((v): v is string => typeof v === 'string');
    expect(companies).toEqual([...companies].sort());
    // NULL companies (the orphan) sort last, as everywhere else in the grid.
    expect(sorted.findIndex((r) => r.id === orphan)).toBeGreaterThan(sorted.findIndex((r) => r.company !== null));
  });

  it('filters on company, job_title and events', async () => {
    const { eventB, admin, twice, onlyB, orphan } = await seedDirectory();

    const byCompany = (await orgQuery(admin.cookie, { filters: { company: 'Beta' } })).body;
    expect(byCompany.items.map((r) => r.id).sort()).toEqual([twice, onlyB].sort());

    const byTitle = (await orgQuery(admin.cookie, { filters: { job_title: 'CTO' } })).body;
    expect(byTitle.items.map((r) => r.id)).toEqual([twice]);

    const unattached = (await orgQuery(admin.cookie, { filters: { events: 'none' } })).body;
    expect(unattached.items.map((r) => r.id)).toEqual([orphan]);
    expect(unattached.total).toBe(1);

    const attached = (await orgQuery(admin.cookie, { filters: { events: 'any' } })).body;
    expect(attached.items.map((r) => r.id)).toContain(twice);
    expect(attached.items.map((r) => r.id)).not.toContain(orphan);

    const onB = (await orgQuery(admin.cookie, { filters: { events: eventB } })).body;
    expect(onB.items.map((r) => r.id).sort()).toEqual([twice, onlyB].sort());

    // An event id from another organisation matches nobody rather than leaking.
    const foreign = await seedEvent();
    expect((await orgQuery(admin.cookie, { filters: { events: foreign } })).body.items).toEqual([]);
  });

  it('is refused to a reviewer seat', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const { status, body } = await orgQuery(reviewer.cookie);
    expect(status).toBe(403);
    expect(body.error).toBe('forbidden');
  });
});

describe('POST /app/api/contacts/query — event scope is unchanged', () => {
  it('still returns one row per membership and hides the membership-less', async () => {
    const { eventA, eventB, admin, twice, onlyB, orphan } = await seedDirectory();
    // Seat the same admin email on B so both memberships are in scope.
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'admin');

    const { body } = await query(admin.cookie, { size: 200, filters: {} });
    const rows = body.items.filter((r) => r.id === twice);
    expect(rows.map((r) => r.event_id).sort()).toEqual([eventA, eventB].sort());
    // Each row carries ITS event's profile, not the most recent one.
    expect(rows.find((r) => r.event_id === eventA)).toMatchObject({
      company: 'Alpha Corp', job_title: 'Engineer', event_name: 'Alpha Conf',
    });
    expect(rows.find((r) => r.event_id === eventB)).toMatchObject({
      company: 'Beta Corp', job_title: 'CTO', event_name: 'Beta Summit',
    });
    // The directory-only columns belong to org mode alone.
    expect(rows[0]).not.toHaveProperty('event_count');
    expect(row(body, orphan)).toBeUndefined();
    expect(row(body, onlyB)).toBeDefined();
  });

  it('applies the new company/job_title filters per event, and ignores `events`', async () => {
    const { eventA, admin, twice } = await seedDirectory();

    const alpha = await query(admin.cookie, { size: 200, filters: { company: 'Alpha' } });
    expect(alpha.body.items.map((r) => r.id)).toEqual([twice]);
    expect(alpha.body.items[0]).toMatchObject({ event_id: eventA });
    // Beta Corp is another event's answer and the caller holds no seat there.
    expect((await query(admin.cookie, { size: 200, filters: { company: 'Beta' } })).body.items).toEqual([]);
    expect((await query(admin.cookie, { size: 200, filters: { job_title: 'Engineer' } })).body.items.map((r) => r.id))
      .toEqual([twice]);

    // `events` is org-mode-only: a no-op here, never a narrowing.
    const withEvents = await query(admin.cookie, { size: 200, filters: { events: 'none' } });
    const without = await query(admin.cookie, { size: 200, filters: {} });
    expect(withEvents.body.items.map((r) => r.id)).toEqual(without.body.items.map((r) => r.id));
  });
});

describe('POST /app/api/contacts — org-level creation', () => {
  const create = (cookie: string, body: Record<string, unknown>) =>
    SELF.fetch('https://example.com/app/api/contacts', jsonReq(cookie, body));

  it('creates the identity and skips the membership under no_event', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await create(admin.cookie, {
      email: 'Directory@Example.com', first_name: 'Dir', last_name: 'Ectory', no_event: true,
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ email: 'directory@example.com', first_name: 'Dir', last_name: 'Ectory' });
    // Same keys as the event-scoped response, membership-owned ones null.
    expect(body.event_id).toBeNull();
    expect(body.company).toBeNull();
    expect(body.custom_fields_json).toBeNull();

    const id = body.id as string;
    const memberships = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?',
    ).bind(id).first<{ n: number }>();
    expect(memberships?.n).toBe(0);

    // Findable in the directory, absent from the roster.
    expect(row((await orgQuery(admin.cookie)).body, id)).toMatchObject({ event_count: 0 });
    expect(row((await query(admin.cookie, { size: 200, filters: {} })).body, id)).toBeUndefined();
  });

  it('accepts event_id: null as the same signal, and 409s a duplicate identity', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await create(admin.cookie, { email: 'dupe@example.com', event_id: null });
    expect(first.status).toBe(201);
    const id = ((await first.json()) as { id: string }).id;
    expect(
      (await env.DB.prepare('SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?')
        .bind(id).first<{ n: number }>())?.n,
    ).toBe(0);

    const again = await create(admin.cookie, { email: 'dupe@example.com', no_event: true });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'email_exists', existing_id: id });
  });

  it('refuses membership-owned fields it would have to drop', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await create(admin.cookie, {
      email: 'stranded@example.com', company: 'Acme', biography: 'Bio', no_event: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; fields: string[] };
    expect(body.error).toBe('event_required_for_profile');
    expect(body.fields.sort()).toEqual(['biography', 'company']);
    expect(
      await env.DB.prepare('SELECT id FROM contacts WHERE email = ?').bind('stranded@example.com').first(),
    ).toBeNull();
  });

  it('leaves the default event-scoped create untouched', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await create(admin.cookie, {
      email: 'roster@example.com', first_name: 'Ros', company: 'Acme',
    });
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(body)).toBe(201);
    expect(body).toMatchObject({ event_id: eventId, company: 'Acme' });
    const memberships = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?',
    ).bind(body.id as string).first<{ n: number }>();
    expect(memberships?.n).toBe(1);
  });
});

describe('the non-SPA surfaces never see org mode', () => {
  it('exports the roster shape, scope or no scope', async () => {
    const { admin, orphan } = await seedDirectory();
    // The export is a GET with query params — there is no body to carry
    // `scope`, and a stray param is not a registry filter, so it is ignored.
    const res = await SELF.fetch(
      'https://example.com/app/api/contacts/export?format=csv&scope=org',
      jsonReq(admin.cookie, undefined, 'GET'),
    );
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain('event_id');
    expect(csv).not.toContain('event_count');
    expect(csv).not.toContain(orphan);
  });
});
