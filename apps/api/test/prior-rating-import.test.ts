// Workplan 15 W7 (D11) — last year's attendee rating is *imported, never
// collected*: the importer's two new mappable columns (prior_rating,
// prior_rating_note on event_contacts, migration 0041) are the whole delivery
// mechanism, there is no capture UI. These tests exercise the commit path the
// same way import-export.test.ts does for the rest of the contacts importer.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff } from './fixtures-admin';

const ORIGIN = 'https://example.com';
const post = (path: string, cookie: string, body: unknown) =>
  SELF.fetch(`${ORIGIN}/app/api${path}`, jsonReq(cookie, body, 'POST'));

describe('contacts import — prior_rating / prior_rating_note (W7, D11)', () => {
  it('a new speaker: both columns land on event_contacts as a real number and free text', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const headers = ['Email', 'First Name', 'Last Name', 'Prior rating', 'Prior rating note'];
    const mapping = ['email', 'first_name', 'last_name', 'prior_rating', 'prior_rating_note'];
    const rows = [['dana@example.com', 'Dana', 'Kowalski', '3.1', 'bottom quartile, n=41']];

    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows, mapping,
    });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, applied: { create: 1 } });

    const row = await env.DB.prepare(
      `SELECT ec.prior_rating, ec.prior_rating_note
         FROM event_contacts ec JOIN contacts c ON c.id = ec.contact_id
        WHERE ec.event_id = ? AND c.email = 'dana@example.com'`,
    ).bind(eventId).first<{ prior_rating: number; prior_rating_note: string }>();
    expect(row?.prior_rating).toBe(3.1);
    expect(row?.prior_rating_note).toBe('bottom quartile, n=41');
  });

  it('a non-numeric rating is reported as a row error rather than half-applied', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const headers = ['Email', 'Prior rating'];
    const mapping = ['email', 'prior_rating'];
    const rows = [['bad@example.com', 'excellent']];

    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows, mapping,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { error: 1, total: 1 } });
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM contacts WHERE email = 'bad@example.com'`,
    ).first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('fills a blank prior_rating on an existing speaker but never clobbers one already set', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const contactId = await seedContact(eventId, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    await env.DB.prepare(
      `UPDATE event_contacts SET prior_rating = 4.5, prior_rating_note = 'top decile' WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventId, contactId).run();

    const headers = ['Email', 'Prior rating', 'Prior rating note'];
    const mapping = ['email', 'prior_rating', 'prior_rating_note'];
    const rows = [['ada@example.com', '1.0', 'reimported low value']];

    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows, mapping,
    });
    expect(res.status).toBe(200);
    // Nothing blank to fill: identical to any other already-populated column,
    // the merge is a no-op skip rather than a silent overwrite.
    expect(await res.json()).toMatchObject({ applied: { skip: 1 } });

    const row = await env.DB.prepare(
      `SELECT prior_rating, prior_rating_note FROM event_contacts WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventId, contactId).first<{ prior_rating: number; prior_rating_note: string }>();
    expect(row?.prior_rating).toBe(4.5);
    expect(row?.prior_rating_note).toBe('top decile');
  });

  it('attach: a speaker known elsewhere in the org gets this event\'s imported rating, not a seed from their prior event', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const admin = await seedStaff(eventB, 'admin');
    const contactId = await seedContact(eventA, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    await env.DB.prepare(
      `UPDATE event_contacts SET prior_rating = 4.5 WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventA, contactId).run();

    const headers = ['Email', 'First Name', 'Last Name', 'Prior rating'];
    const mapping = ['email', 'first_name', 'last_name', 'prior_rating'];
    const rows = [['ada@example.com', 'Ada', 'Lovelace', '2.7']];

    const res = await post('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventB, headers, rows, mapping,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: { attach: 1 } });

    const rowB = await env.DB.prepare(
      `SELECT prior_rating FROM event_contacts WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventB, contactId).first<{ prior_rating: number }>();
    // The sheet's value for THIS event, not eventA's 4.5 carried forward —
    // prior_rating is a fact about one event and is never seeded (unlike
    // biography/company/job_title).
    expect(rowB?.prior_rating).toBe(2.7);
    const rowA = await env.DB.prepare(
      `SELECT prior_rating FROM event_contacts WHERE event_id = ? AND contact_id = ?`,
    ).bind(eventA, contactId).first<{ prior_rating: number }>();
    expect(rowA?.prior_rating).toBe(4.5);
  });
});
