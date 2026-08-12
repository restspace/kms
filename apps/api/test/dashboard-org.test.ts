// Org-wide dashboard (GET /app/api/dashboard/org): KPI correctness across the
// whole organisation, most-recent-company grouping, per-event rows, the
// revision-first cache, and the writer-only guard.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bumpEventRevision } from '../src/revision';
import { createOrg, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const uid = (p: string) => `${p}-${crypto.randomUUID()}`;

const getOrgDashboard = (cookie: string, etag?: string) =>
  SELF.fetch('https://example.com/app/api/dashboard/org', {
    headers: { cookie, accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  });

interface OrgBody {
  org: { id: string; name: string };
  kpis: {
    total_contacts: number;
    new_contacts_30d: number;
    contacts_on_events: number;
    contacts_no_event: number;
    returning_speakers: number;
    events: number;
  };
  top_companies: Array<{ company: string; n: number }>;
  events: Array<{
    id: string; name: string; slug: string; starts_at: string; ends_at: string;
    agenda_published: number; submissions: number; accepted: number; scheduled: number;
  }>;
}

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString();

/** A second event_contacts membership for a contact already seeded elsewhere. */
const addMembership = (eventId: string, contactId: string, company: string | null, addedAt: string) =>
  env.DB.prepare(
    `INSERT INTO event_contacts (event_id, contact_id, company, added_at, source)
     VALUES (?, ?, ?, ?, 'admin')`,
  ).bind(eventId, contactId, company, addedAt).run();

const addParticipant = (submissionId: string, contactId: string) =>
  env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, 1)`,
  ).bind(uid('sp'), submissionId, contactId).run();

/** Org + two events in it, plus an admin seated on the first. */
async function seedOrgWithTwoEvents() {
  const orgId = await createOrg(uid('org'), 'Contoso Events');
  const eventA = await seedEvent({ org_id: orgId, name: 'Spring Summit', starts_at: '2026-04-01T08:00:00Z', ends_at: '2026-04-02T18:00:00Z' });
  const eventB = await seedEvent({ org_id: orgId, name: 'Autumn Summit', starts_at: '2026-10-01T08:00:00Z', ends_at: '2026-10-02T18:00:00Z' });
  const admin = await seedStaff(eventA, 'admin');
  return { orgId, eventA, eventB, admin };
}

describe('GET /app/api/dashboard/org', () => {
  it('reports org-wide contact KPIs: no-event contacts, a cross-event contact counted once, returning speakers', async () => {
    const { orgId, eventA, eventB, admin } = await seedOrgWithTwoEvents();

    // Alice sits on BOTH events — she must still count once in total_contacts.
    const alice = await seedContact(eventA, { email: 'alice@example.com' });
    await addMembership(eventB, alice, null, '2026-06-01T00:00:00Z');
    const bob = await seedContact(eventA, { email: 'bob@example.com' });

    // Org-only contact: a row in the org with no membership anywhere.
    const carol = uid('con');
    await env.DB.prepare(
      `INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at)
       VALUES (?, ?, 'carol@example.com', 'Carol', 'Nomember', ?, ?)`,
    ).bind(carol, orgId, iso(1), iso(1)).run();

    // A merge tombstone must not inflate anything.
    const ghost = uid('con');
    await env.DB.prepare(
      `INSERT INTO contacts (id, org_id, email, merged_into, created_at, updated_at)
       VALUES (?, ?, 'ghost@example.com', ?, ?, ?)`,
    ).bind(ghost, orgId, alice, iso(1), iso(1)).run();

    // Creation dates are explicit so the 30-day window doesn't depend on the
    // fixture's fixed timestamp being near today.
    await env.DB.prepare('UPDATE contacts SET created_at = ? WHERE org_id = ?').bind(iso(1), orgId).run();
    await env.DB.prepare('UPDATE contacts SET created_at = ? WHERE id = ?').bind(iso(400), bob).run();

    // Alice is a returning speaker: submitter at A, participant at B.
    await seedSubmission(eventA, { status: 'accepted', submitter_contact_id: alice });
    const subB = await seedSubmission(eventB, { status: 'pending' });
    await addParticipant(subB, alice);
    // Bob speaks at one event only — not returning.
    const subA2 = await seedSubmission(eventA, { status: 'pending' });
    await addParticipant(subA2, bob);

    const res = await getOrgDashboard(admin.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as OrgBody;

    expect(body.org).toMatchObject({ id: orgId, name: 'Contoso Events' });
    // admin + alice + bob + carol; the tombstone is excluded.
    expect(body.kpis.total_contacts).toBe(4);
    expect(body.kpis.contacts_on_events).toBe(3);
    expect(body.kpis.contacts_no_event).toBe(1);
    expect(body.kpis.new_contacts_30d).toBe(3); // everyone but Bob
    expect(body.kpis.returning_speakers).toBe(1);
    expect(body.kpis.events).toBe(2);
  });

  it('groups top_companies by each contact\'s most recent membership', async () => {
    const { orgId, eventA, eventB, admin } = await seedOrgWithTwoEvents();

    // Alice changed employer: OldCo at the earlier event, NewCo at the later one.
    const alice = await seedContact(eventA, { email: 'alice2@example.com', company: 'OldCo' });
    await env.DB.prepare('UPDATE event_contacts SET added_at = ? WHERE event_id = ? AND contact_id = ?')
      .bind('2026-01-01T00:00:00Z', eventA, alice).run();
    await addMembership(eventB, alice, 'NewCo', '2026-06-01T00:00:00Z');

    await seedContact(eventB, { email: 'bob2@example.com', company: 'NewCo' });
    await seedContact(eventA, { email: 'dana@example.com', company: 'Initech' });
    // Blank company must not become a bucket.
    await seedContact(eventA, { email: 'blank@example.com', company: '   ' });

    const body = (await (await getOrgDashboard(admin.cookie)).json()) as OrgBody;
    expect(body.top_companies).toEqual([
      { company: 'NewCo', n: 2 },
      { company: 'Initech', n: 1 },
    ]);
    expect(body.top_companies.some((r) => r.company === 'OldCo')).toBe(false);
  });

  it('returns one row per event, newest first, with per-event pipeline counts', async () => {
    const { eventA, eventB, admin } = await seedOrgWithTwoEvents();
    const other = await seedEvent(); // different org entirely — must not appear
    await seedSubmission(other, { status: 'accepted' });

    await seedSubmission(eventB, { status: 'draft' });
    await seedSubmission(eventB, { status: 'pending' });
    const acceptedUnscheduled = await seedSubmission(eventB, { status: 'accepted' });
    const acceptedScheduled = await seedSubmission(eventB, { status: 'accepted' });
    const roomId = uid('room');
    await env.DB.prepare('INSERT INTO rooms (id, event_id, name, position) VALUES (?, ?, \'Main Hall\', 0)')
      .bind(roomId, eventB).run();
    await env.DB.prepare('UPDATE submissions SET starts_at = ?, room_id = ? WHERE id = ?')
      .bind('2026-10-01T09:00:00Z', roomId, acceptedScheduled).run();
    // Accepted but only half-scheduled (slot, no room) does not count.
    await env.DB.prepare('UPDATE submissions SET starts_at = ? WHERE id = ?')
      .bind('2026-10-01T10:00:00Z', acceptedUnscheduled).run();
    await env.DB.prepare('UPDATE events SET agenda_published = 1 WHERE id = ?').bind(eventB).run();

    const body = (await (await getOrgDashboard(admin.cookie)).json()) as OrgBody;
    expect(body.events.map((e) => e.id)).toEqual([eventB, eventA]); // starts_at DESC
    expect(body.events[0]).toMatchObject({
      name: 'Autumn Summit',
      agenda_published: 1,
      submissions: 3, // the draft is excluded
      accepted: 2,
      scheduled: 1,
    });
    expect(body.events[1]).toMatchObject({ name: 'Spring Summit', submissions: 0, accepted: 0, scheduled: 0 });
  });

  it('answers 304 on an unchanged ETag and re-issues after any event in the org bumps', async () => {
    const { eventB, admin } = await seedOrgWithTwoEvents();

    const first = await getOrgDashboard(admin.cookie);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"o/);

    expect((await getOrgDashboard(admin.cookie, etag!)).status).toBe(304);

    // A bump on the *other* event in the org still invalidates the roll-up.
    await bumpEventRevision(env, eventB);
    const third = await getOrgDashboard(admin.cookie, etag!);
    expect(third.status).toBe(200);
    expect(third.headers.get('etag')).not.toBe(etag);
  });

  it('403s a reviewer seat', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');

    const res = await getOrgDashboard(reviewer.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
  });
});
