// Workplan 14 Wave E (decision D8): content_revisions generalised beyond
// submissions (migration 0031). Contact profile fields (biography/company/
// job_title) and event settings record a PRE-edit snapshot into the same
// table, discriminated by entity_type, payload as JSON — snapshot only when a
// watched field actually changes, scoped to the event_contacts row the write
// actually targets.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  attachContactToEvent,
  createContact,
  createEvent,
  createEventUser,
  sessionCookieFor,
} from './fixtures';

const put = (cookie: string, body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

const patch = (cookie: string, body: unknown) => ({
  method: 'PATCH',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function adminSession(eventId: string, slug: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'admin' });
  return { contactId, cookie };
}

interface RevisionRow {
  entity_type: string;
  entity_id: string | null;
  event_id: string;
  payload: string | null;
  source: string;
  edited_by: string | null;
}

const revisionRows = async (entityType: string, entityId: string): Promise<RevisionRow[]> => {
  const { results } = await env.DB.prepare(
    `SELECT entity_type, entity_id, event_id, payload, source, edited_by
     FROM content_revisions WHERE entity_type = ? AND entity_id = ? ORDER BY edited_at ASC, id ASC`,
  )
    .bind(entityType, entityId)
    .all<RevisionRow>();
  return results ?? [];
};

describe('contact profile revisions (PUT /app/api/contacts/:id)', () => {
  it('snapshots the pre-edit bio/company/job_title when one changes, but not for a notes-only PUT', async () => {
    const eventId = await createEvent({ slug: `rb-contact-${crypto.randomUUID().slice(0, 8)}` });
    const { contactId: adminId, cookie } = await adminSession(eventId, eventId);
    const speakerId = await createContact(eventId, {
      email: `spk-${crypto.randomUUID()}@example.com`,
      biography: 'Original bio.',
      company: 'Original Co',
      job_title: 'Original title',
    });

    // notes is unwatched: no history row for an organiser-scratch edit.
    const notesOnly = await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, { notes: 'internal scribble' }),
    );
    expect(notesOnly.status).toBe(200);
    expect(await revisionRows('contact', speakerId)).toHaveLength(0);

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, { biography: 'New bio.', company: 'New Co' }),
    );
    expect(res.status).toBe(200);

    const rows = await revisionRows('contact', speakerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'contact', event_id: eventId, source: 'admin', edited_by: adminId });
    // Full watched-set snapshot of the PRE-edit values, job_title included
    // even though this edit didn't touch it — restore needs the whole set.
    expect(JSON.parse(rows[0]!.payload ?? '{}')).toEqual({
      biography: 'Original bio.',
      company: 'Original Co',
      job_title: 'Original title',
    });
  });

  it('records no row for a no-op save (same watched values re-sent)', async () => {
    const eventId = await createEvent({ slug: `rb-noop-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const speakerId = await createContact(eventId, {
      email: `spk-${crypto.randomUUID()}@example.com`,
      biography: 'Same bio.',
      company: 'Same Co',
    });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, { biography: 'Same bio.', company: 'Same Co' }),
    );
    expect(res.status).toBe(200);
    expect(await revisionRows('contact', speakerId)).toHaveLength(0);
  });

  it("scopes the snapshot to the row's own event when the PUT carries event_id", async () => {
    // Same defect class the contacts PUT was fixed for: a grid row from event B
    // edited under a session cookie pinned to event A. The snapshot must record
    // event B's pre-edit profile, under event B's id.
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await createEvent({ slug: `rb-xa-${crypto.randomUUID().slice(0, 8)}`, org_id: orgId });
    const eventB = await createEvent({ slug: `rb-xb-${crypto.randomUUID().slice(0, 8)}`, org_id: orgId });
    const { contactId: adminId, cookie } = await adminSession(eventA, eventA);
    await attachContactToEvent(eventB, adminId);
    await createEventUser(eventB, adminId, 'admin');

    const speakerId = await createContact(eventA, {
      email: `spk-${crypto.randomUUID()}@example.com`,
      biography: 'Bio on A.',
    });
    await attachContactToEvent(eventB, speakerId, { biography: 'Bio on B.', company: 'B Co' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, { biography: 'New bio on B.', event_id: eventB }),
    );
    expect(res.status).toBe(200);

    const rows = await revisionRows('contact', speakerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_id).toBe(eventB);
    expect(JSON.parse(rows[0]!.payload ?? '{}')).toMatchObject({ biography: 'Bio on B.', company: 'B Co' });
    // Event A's row is untouched.
    const rowA = await env.DB.prepare(
      'SELECT biography FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventA, speakerId).first<{ biography: string }>();
    expect(rowA?.biography).toBe('Bio on A.');
  });

  it('restore round-trip: GET the snapshot, PUT it back, contact reverts and the restore is itself snapshotted', async () => {
    const eventId = await createEvent({ slug: `rb-restore-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);
    const speakerId = await createContact(eventId, {
      email: `spk-${crypto.randomUUID()}@example.com`,
      biography: 'Original bio.',
      company: 'Original Co',
      job_title: 'Original title',
    });

    await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, { biography: 'Rewritten bio.', job_title: 'New title' }),
    );

    const list = await SELF.fetch(`https://example.com/app/api/contacts/${speakerId}/revisions`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ fields: Record<string, string | null> }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.fields).toEqual({
      biography: 'Original bio.',
      company: 'Original Co',
      job_title: 'Original title',
    });

    // Restore = the normal PUT with the snapshot's fields (self-snapshotting).
    const restore = await SELF.fetch(
      `https://example.com/app/api/contacts/${speakerId}`,
      put(cookie, body.items[0]!.fields),
    );
    expect(restore.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT biography, company, job_title FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, speakerId).first<Record<string, string | null>>();
    expect(row).toEqual({ biography: 'Original bio.', company: 'Original Co', job_title: 'Original title' });

    // The restore added its own snapshot (of the rewritten values), newest first.
    const after = (await (
      await SELF.fetch(`https://example.com/app/api/contacts/${speakerId}/revisions`, { headers: { cookie } })
    ).json()) as { items: Array<{ fields: Record<string, string | null> }> };
    expect(after.items).toHaveLength(2);
    expect(after.items[0]!.fields).toMatchObject({ biography: 'Rewritten bio.', job_title: 'New title' });
  });

  it('portal profile save snapshots the pre-edit profile with source=portal, and skips a no-op', async () => {
    const slug = `rb-portal-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    const speakerId = await createContact(eventId, {
      email: `spk-${crypto.randomUUID()}@example.com`,
      first_name: 'Grace',
      last_name: 'Hopper',
      biography: 'Portal bio.',
      company: 'Navy',
      job_title: 'RADM',
    });
    const cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });

    const postProfile = (fields: Record<string, string>) =>
      SELF.fetch(`https://example.com/portal/${slug}/profile`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
        redirect: 'manual',
      });

    // Identity-only change: names are contacts columns, not watched profile
    // fields — no history row.
    const noop = await postProfile({
      first_name: 'Grace',
      last_name: 'Hopper-Jones',
      biography: 'Portal bio.',
      company: 'Navy',
      job_title: 'RADM',
    });
    expect(noop.status).toBe(302);
    expect(await revisionRows('contact', speakerId)).toHaveLength(0);

    const res = await postProfile({
      first_name: 'Grace',
      last_name: 'Hopper-Jones',
      biography: 'New portal bio.',
      company: 'Navy',
      job_title: 'RADM',
    });
    expect(res.status).toBe(302);

    const rows = await revisionRows('contact', speakerId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ event_id: eventId, source: 'portal', edited_by: speakerId });
    expect(JSON.parse(rows[0]!.payload ?? '{}')).toEqual({
      biography: 'Portal bio.',
      company: 'Navy',
      job_title: 'RADM',
    });
  });
});

describe('event settings revisions (PATCH /app/api/events/:id)', () => {
  it('snapshots the full pre-edit settings when a watched field changes, skips no-ops and publish flips', async () => {
    const eventId = await createEvent({ slug: `rb-set-${crypto.randomUUID().slice(0, 8)}` });
    const { contactId: adminId, cookie } = await adminSession(eventId, eventId);

    // agenda_published is workflow, not settings content: no row.
    const flip = await SELF.fetch(
      `https://example.com/app/api/events/${eventId}`,
      patch(cookie, { agenda_published: true }),
    );
    expect(flip.status).toBe(200);
    expect(await revisionRows('settings', eventId)).toHaveLength(0);

    // Re-sending the stored name is a no-op: no row.
    const noop = await SELF.fetch(
      `https://example.com/app/api/events/${eventId}`,
      patch(cookie, { name: 'Test Event' }),
    );
    expect(noop.status).toBe(200);
    expect(await revisionRows('settings', eventId)).toHaveLength(0);

    const res = await SELF.fetch(
      `https://example.com/app/api/events/${eventId}`,
      patch(cookie, { name: 'Renamed Event', location: 'Lisbon' }),
    );
    expect(res.status).toBe(200);

    const rows = await revisionRows('settings', eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'settings', event_id: eventId, source: 'admin', edited_by: adminId });
    const payload = JSON.parse(rows[0]!.payload ?? '{}') as Record<string, string | null>;
    // Full pre-edit snapshot, keyed by the PATCH surface's field names.
    expect(payload).toMatchObject({ name: 'Test Event', location: null, timezone: 'UTC' });
    expect(payload).toHaveProperty('description');
    expect(payload).toHaveProperty('starts_at');
  });

  it('restore round-trip through GET /events/:id/revisions and the normal PATCH', async () => {
    const eventId = await createEvent({ slug: `rb-set-rt-${crypto.randomUUID().slice(0, 8)}` });
    const { cookie } = await adminSession(eventId, eventId);

    await SELF.fetch(
      `https://example.com/app/api/events/${eventId}`,
      patch(cookie, { name: 'Renamed Event' }),
    );

    const list = await SELF.fetch(`https://example.com/app/api/events/${eventId}/revisions`, {
      headers: { cookie },
    });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { items: Array<{ fields: Record<string, string | null> }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]!.fields.name).toBe('Test Event');

    const restore = await SELF.fetch(
      `https://example.com/app/api/events/${eventId}`,
      patch(cookie, body.items[0]!.fields),
    );
    expect(restore.status).toBe(200);

    const row = await env.DB.prepare('SELECT name FROM events WHERE id = ?')
      .bind(eventId)
      .first<{ name: string }>();
    expect(row?.name).toBe('Test Event');

    // The restore snapshotted the replaced ("Renamed Event") settings itself.
    const after = (await (
      await SELF.fetch(`https://example.com/app/api/events/${eventId}/revisions`, { headers: { cookie } })
    ).json()) as { items: Array<{ fields: Record<string, string | null> }> };
    expect(after.items).toHaveLength(2);
    expect(after.items[0]!.fields.name).toBe('Renamed Event');
  });

  it('a reviewer session cannot list settings or contact revisions (writer-only)', async () => {
    const eventId = await createEvent({ slug: `rb-forbid-${crypto.randomUUID().slice(0, 8)}` });
    const speakerId = await createContact(eventId, { email: `spk-${crypto.randomUUID()}@example.com` });
    const reviewerId = await createContact(eventId, { email: `rev-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, reviewerId, 'reviewer');
    const cookie = await sessionCookieFor({ contactId: reviewerId, eventId, eventSlug: eventId, role: 'reviewer' });

    const settings = await SELF.fetch(`https://example.com/app/api/events/${eventId}/revisions`, {
      headers: { cookie },
    });
    expect(settings.status).toBe(403);
    const contact = await SELF.fetch(`https://example.com/app/api/contacts/${speakerId}/revisions`, {
      headers: { cookie },
    });
    expect(contact.status).toBe(403);
  });
});
