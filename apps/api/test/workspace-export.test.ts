// Workspace export (GET /app/api/:resource/export): the grids' export twin.
// The /api/v1 REST export is event-addressed — single-event by construction —
// so the SPA's export buttons used to silently narrow an "All events" grid to
// the session's current event. This endpoint scopes the way the workspace
// query does (every accessible event by default, narrowed by an explicit
// `event_id` param), so the file always matches what the grid shows.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedEventUser, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

const getReq = (cookie: string): RequestInit => jsonReq(cookie, undefined, 'GET');

/** Two events in one org; one admin holding a seat on both; a submission each. */
async function seedTwoEventOrg() {
  const suffix = crypto.randomUUID().slice(0, 8);
  const eventA = await seedEvent({ slug: `alpha-${suffix}` });
  const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(eventA)
    .first<{ org_id: string }>();
  const eventB = await seedEvent({ org_id: org!.org_id, slug: `beta-${suffix}` });
  const admin = await seedStaff(eventA, 'admin');
  await env.DB.prepare(
    `INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')`,
  ).bind(eventB, admin.contactId, ts).run();
  await seedEventUser(eventB, admin.contactId, 'admin');
  await seedSubmission(eventA, { code: 'SUB-ALPHA', title: 'Alpha Talk' });
  await seedSubmission(eventB, { code: 'SUB-BETA', title: 'Beta Talk' });
  return { eventA, eventB, admin, suffix };
}

describe('GET /app/api/:resource/export', () => {
  it('spans every accessible event when no event_id is given', async () => {
    const { admin } = await seedTwoEventOrg();
    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/export?format=csv',
      getReq(admin.cookie),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    // Multi-event scope → no single slug to name the file after.
    expect(res.headers.get('content-disposition')).toContain('all-events-submissions-');

    const text = await res.text();
    expect(text).toContain('SUB-ALPHA');
    expect(text).toContain('SUB-BETA');
    // Rows carry their event provenance, same as the grid's Event column.
    const header = text.replace(/^﻿/, '').split('\r\n')[0]!;
    expect(header.split(',')).toContain('event_name');
  });

  it('narrows to one event via event_id and names the file after its slug', async () => {
    const { eventB, admin, suffix } = await seedTwoEventOrg();
    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/export?format=csv&event_id=${eventB}`,
      getReq(admin.cookie),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`beta-${suffix}-submissions-`);

    const text = await res.text();
    expect(text).toContain('SUB-BETA');
    expect(text).not.toContain('SUB-ALPHA');
  });

  it('403s an event_id outside the accessible set', async () => {
    const { admin } = await seedTwoEventOrg();
    const foreignEvent = await seedEvent(); // its own org — never accessible
    const res = await SELF.fetch(
      `https://example.com/app/api/submissions/export?format=csv&event_id=${foreignEvent}`,
      getReq(admin.cookie),
    );
    expect(res.status).toBe(403);
  });

  it('honours registry filters and sort like the query endpoint', async () => {
    const { admin } = await seedTwoEventOrg();
    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/export?format=csv&q=Beta&sort=-created_at',
      getReq(admin.cookie),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('SUB-BETA');
    expect(text).not.toContain('SUB-ALPHA');
  });

  it('produces an XLSX container for format=xlsx', async () => {
    const { admin } = await seedTwoEventOrg();
    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/export?format=xlsx',
      getReq(admin.cookie),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0x50); // "PK" zip signature
    expect(buf[1]).toBe(0x4b);
  });

  it('404s an unknown resource', async () => {
    const { admin } = await seedTwoEventOrg();
    const res = await SELF.fetch(
      'https://example.com/app/api/nonsense/export?format=csv',
      getReq(admin.cookie),
    );
    expect(res.status).toBe(404);
  });
});
