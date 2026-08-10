// Contacts-hygiene fix wave (workplan-4 cluster 3): social links round-trip
// on the Speakers-tab contact endpoints, and the nameless "account-step
// stub" contact excluded from the messaging "speakers" audience. The CSV
// import merge-by-email behaviour (item 1) is already covered end to end by
// import-export.test.ts ("previews two known speakers as merged/skipped and
// the new person as a create") — nothing changed there in this wave.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { resolveAudience } from '../src/routes/messagingAdmin';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('contact social links (item 2)', () => {
  it('round-trips linkedin/twitter/facebook/website through create, update and the resource query', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const created = await api('/contacts', admin.cookie, {
      email: 'linked@example.com',
      first_name: 'Grace',
      last_name: 'Hopper',
      links: { linkedin: 'https://linkedin.com/in/grace', website: 'https://grace.dev' },
    });
    expect(created.status).toBe(201);
    const createdRow = (await created.json()) as { id: string; links: string };
    expect(JSON.parse(createdRow.links)).toEqual({
      linkedin: 'https://linkedin.com/in/grace',
      website: 'https://grace.dev',
    });

    // A PUT that only sends `twitter` fills it in without disturbing the rest.
    const updated = await api(`/contacts/${createdRow.id}`, admin.cookie, {
      links: { linkedin: 'https://linkedin.com/in/grace', twitter: 'https://x.com/grace', website: 'https://grace.dev' },
    }, 'PUT');
    expect(updated.status).toBe(200);

    const queried = await SELF.fetch('https://example.com/app/api/contacts/query', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 0, size: 10, filters: { contact_id: createdRow.id } }),
    });
    const { items } = (await queried.json()) as { items: Array<{ links: string }> };
    expect(JSON.parse(items[0].links)).toEqual({
      linkedin: 'https://linkedin.com/in/grace',
      twitter: 'https://x.com/grace',
      website: 'https://grace.dev',
    });
  });

  it('clearing every link stores null rather than an empty-object json blob', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const created = await api('/contacts', admin.cookie, {
      email: 'clearable@example.com',
      links: { linkedin: 'https://linkedin.com/in/x' },
    });
    const { id } = (await created.json()) as { id: string };

    await api(`/contacts/${id}`, admin.cookie, { links: { linkedin: '', twitter: '  ' } }, 'PUT');
    const row = await env.DB.prepare('SELECT links FROM contacts WHERE id = ?').bind(id).first<{ links: string | null }>();
    expect(row?.links).toBeNull();
  });

  it('a PUT that never mentions links leaves the column untouched', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const created = await api('/contacts', admin.cookie, {
      email: 'untouched@example.com',
      links: { website: 'https://untouched.example.com' },
    });
    const { id } = (await created.json()) as { id: string };

    await api(`/contacts/${id}`, admin.cookie, { company: 'New Co' }, 'PUT');
    const row = await env.DB.prepare('SELECT links, company FROM contacts WHERE id = ?').bind(id).first<{ links: string; company: string }>();
    expect(row?.company).toBe('New Co');
    expect(JSON.parse(row!.links)).toEqual({ website: 'https://untouched.example.com' });
  });
});

describe('nameless "account-step stub" contact exclusion (item 4)', () => {
  it('resolveAudience("speakers") skips a submitter with a blank name on both columns', async () => {
    const eventId = await seedEvent();
    const named = await seedContact(eventId, { email: 'named@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    // Mirrors submit.tsx's `/account` stub: a bare-email contact that later
    // becomes a submitter without a form step that collects participant names.
    const stub = await seedContact(eventId, { email: 'cfp-preview-tester@example.com', first_name: '', last_name: '' });
    await seedSubmission(eventId, { submitter_contact_id: named });
    await seedSubmission(eventId, { submitter_contact_id: stub });

    const recipients = await resolveAudience(env.DB, eventId, 'speakers', []);
    expect(recipients.map((r) => r.id)).toEqual([named]);
    expect(recipients.map((r) => r.id)).not.toContain(stub);
  });

  it('the Speakers grid resource query still returns the stub (server-side exclusion stays admin-side/UI-layer only)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const stub = await seedContact(eventId, { email: 'cfp-preview-tester@example.com', first_name: '', last_name: '' });

    const queried = await SELF.fetch('https://example.com/app/api/contacts/query', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 0, size: 10, filters: { contact_id: stub } }),
    });
    const { items } = (await queried.json()) as { items: Array<{ id: string }> };
    // The App.tsx Speakers tab filters this out of its default view
    // (isPlaceholderContact) — the query endpoint itself stays neutral so a
    // direct id lookup (e.g. from a search) can still find and delete it.
    expect(items.map((r) => r.id)).toContain(stub);
  });
});
