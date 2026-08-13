// 2026-08 eval defects around contact/speaker records:
//  1. speaker edits silently failing to persist (event-scope + no-op guard on
//     PUT /contacts/:id),
//  2. import dry run and commit disagreeing (expected_actions handshake),
//  3. a single "Name" column importing whole into first_name (full_name split).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff } from './fixtures-admin';
import { fileFrom, pngBytes } from './fixtures-portal';

const api = (path: string, cookie: string, body?: unknown, method = 'POST') =>
  SELF.fetch(`https://example.com/app/api${path}`, jsonReq(cookie, body, method));

describe('PUT /app/api/contacts/:id persists edits', () => {
  it('writes company, email and links and reads them back after "reload"', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const priya = await seedContact(eventId, {
      email: 'priya.raman@example.com',
      first_name: 'Priya',
      last_name: 'Raman',
      company: 'Oldco',
    });

    const res = await api(`/contacts/${priya}`, admin.cookie, {
      email: 'priya@newco.com',
      company: 'Newco',
      links: { linkedin: 'https://linkedin.com/in/priya' },
    }, 'PUT');
    expect(res.status).toBe(200);
    const echoed = (await res.json()) as Record<string, unknown>;
    expect(echoed.email).toBe('priya@newco.com');
    expect(echoed.company).toBe('Newco');

    const identity = await env.DB.prepare('SELECT email, links FROM contacts WHERE id = ?')
      .bind(priya).first<{ email: string; links: string | null }>();
    expect(identity?.email).toBe('priya@newco.com');
    expect(JSON.parse(identity?.links ?? '{}')).toEqual({ linkedin: 'https://linkedin.com/in/priya' });

    const profile = await env.DB.prepare(
      'SELECT company FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventId, priya).first<{ company: string | null }>();
    expect(profile?.company).toBe('Newco');
  });

  it('writes profile columns to the row\'s own event when the body names one (All-events grid)', async () => {
    // Two events, same org; the staff member holds a seat on both, the contact
    // is only on event B — exactly what the "All events" speakers grid shows.
    const eventA = await seedEvent();
    const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventA).first<{ org_id: string }>();
    const eventB = await seedEvent({ org_id: org!.org_id });
    const admin = await seedStaff(eventA, 'admin');
    await seedEventUser(eventB, admin.contactId, 'admin');
    // A staff seat only counts where the person is also on that event's roster
    // (getAccessibleEvents' event_contacts join).
    await env.DB.prepare(
      "INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')",
    ).bind(eventB, admin.contactId, '2026-08-01T00:00:00Z').run();
    const speaker = await seedContact(eventB, {
      email: 'only-on-b@example.com', first_name: 'Only', last_name: 'OnB', company: 'Oldco',
    });

    // Session cookie is bound to event A. Without an event_id the write cannot
    // find the membership and must NOT answer 200.
    const blind = await api(`/contacts/${speaker}`, admin.cookie, { company: 'Newco' }, 'PUT');
    expect(blind.status).toBe(404);

    // With the row's own event_id (which the edit form echoes) it persists.
    const scoped = await api(`/contacts/${speaker}`, admin.cookie, { company: 'Newco', event_id: eventB }, 'PUT');
    expect(scoped.status).toBe(200);
    const profile = await env.DB.prepare(
      'SELECT company FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventB, speaker).first<{ company: string | null }>();
    expect(profile?.company).toBe('Newco');
  });

  it('refuses an event_id outside the caller\'s seats', async () => {
    const eventA = await seedEvent();
    const foreign = await seedEvent(); // different org, no seat
    const admin = await seedStaff(eventA, 'admin');
    const speaker = await seedContact(foreign, { email: 'foreign@example.com' });
    const res = await api(`/contacts/${speaker}`, admin.cookie, { company: 'X', event_id: foreign }, 'PUT');
    expect(res.status).toBe(403);
  });
});

/** Two events in one org; the staff member holds writer seats (and roster
 * membership, which getAccessibleEvents requires) on both, the speaker sits
 * only on event B — the exact shape the "All events" grid produces while the
 * session cookie stays bound to event A. */
async function seedCrossEventPair() {
  const eventA = await seedEvent();
  const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventA).first<{ org_id: string }>();
  const eventB = await seedEvent({ org_id: org!.org_id });
  const admin = await seedStaff(eventA, 'admin');
  await seedEventUser(eventB, admin.contactId, 'admin');
  await env.DB.prepare(
    "INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')",
  ).bind(eventB, admin.contactId, '2026-08-01T00:00:00Z').run();
  const speaker = await seedContact(eventB, { email: 'cross-event@example.com', first_name: 'Only', last_name: 'OnB' });
  return { eventA, eventB, admin, speaker };
}

// F7 (workplan 14): the headshot POST and the detail panel's sub-reads were
// still pinned to the session cookie's event — the same mistargeting class
// fixed for the contacts PUT above (commit b815e77), just untouched because it
// wasn't in the defect list.
describe('POST /app/api/contacts/:id/headshot event scoping (F7)', () => {
  const upload = (cookie: string, contactId: string, eventId?: string) => {
    const form = new FormData();
    form.set('headshot', fileFrom(pngBytes(), 'headshot.png', 'image/png'));
    if (eventId) form.set('event_id', eventId);
    return SELF.fetch(`https://example.com/app/api/contacts/${contactId}/headshot`, {
      method: 'POST',
      headers: { cookie },
      body: form,
    });
  };

  it('writes to the row\'s own event when the body names one (All-events grid)', async () => {
    const { eventB, admin, speaker } = await seedCrossEventPair();

    // Session cookie is bound to event A. Without an event_id the write cannot
    // find the membership and must NOT answer 200.
    const blind = await upload(admin.cookie, speaker);
    expect(blind.status).toBe(404);

    const scoped = await upload(admin.cookie, speaker, eventB);
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as { headshot_asset_id: string };

    // The pointer landed on event B's profile row, and the asset itself
    // belongs to event B, not the session's event.
    const row = await env.DB.prepare(
      'SELECT headshot_asset_id FROM event_contacts WHERE event_id = ? AND contact_id = ?',
    ).bind(eventB, speaker).first<{ headshot_asset_id: string | null }>();
    expect(row?.headshot_asset_id).toBe(body.headshot_asset_id);
    const asset = await env.DB.prepare('SELECT event_id FROM file_assets WHERE id = ?')
      .bind(body.headshot_asset_id).first<{ event_id: string }>();
    expect(asset?.event_id).toBe(eventB);
  });

  it('refuses an event_id outside the caller\'s seats', async () => {
    const eventA = await seedEvent();
    const foreign = await seedEvent(); // different org, no seat
    const admin = await seedStaff(eventA, 'admin');
    const speaker = await seedContact(foreign, { email: 'foreign-headshot@example.com' });
    const res = await upload(admin.cookie, speaker, foreign);
    expect(res.status).toBe(403);
  });
});

describe('GET /app/api/contacts/:id/history event scoping (F7)', () => {
  it('honours the row\'s event_id for the roster guard (All-events grid)', async () => {
    const { eventB, admin, speaker } = await seedCrossEventPair();

    // Blind read against the session's event: the speaker has no row there, so
    // the guard falls back to the caller's accessible events and resolves the
    // contact's own event (eval defect #6 — the org directory sends no event_id).
    const blind = await api(`/contacts/${speaker}/history`, admin.cookie, undefined, 'GET');
    expect(blind.status).toBe(200);
    const blindBody = (await blind.json()) as { current_event_id: string };
    expect(blindBody.current_event_id).toBe(eventB);

    const scoped = await api(`/contacts/${speaker}/history?event_id=${eventB}`, admin.cookie, undefined, 'GET');
    expect(scoped.status).toBe(200);
    const body = (await scoped.json()) as { events: Array<{ event_id: string }>; current_event_id: string };
    expect(body.current_event_id).toBe(eventB);
    expect(body.events.some((e) => e.event_id === eventB)).toBe(true);
  });

  it('refuses an event_id outside the caller\'s seats', async () => {
    const eventA = await seedEvent();
    const foreign = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const speaker = await seedContact(foreign, { email: 'foreign-history@example.com' });
    const res = await api(`/contacts/${speaker}/history?event_id=${foreign}`, admin.cookie, undefined, 'GET');
    expect(res.status).toBe(403);
  });
});

describe('import dry run vs commit agreement (contacts)', () => {
  it('commit applies exactly the actions the dry run predicted, no duplicates', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    // Priya on this event with a blank biography → merge target.
    await seedContact(eventId, {
      email: 'priya.raman@example.com', first_name: 'Priya', last_name: 'Raman', company: 'Oldco',
    });
    // Marcus on a sibling event in the SAME org → attach target.
    const org = await env.DB.prepare('SELECT org_id FROM events WHERE id = ?').bind(eventId).first<{ org_id: string }>();
    const siblingEvent = await seedEvent({ org_id: org!.org_id });
    await seedContact(siblingEvent, {
      email: 'marcus.okafor@example.com', first_name: 'Marcus', last_name: 'Okafor',
    });

    const headers = ['Email', 'First name', 'Last name', 'Biography'];
    const rows = [
      ['priya.raman@example.com', 'Priya', 'Raman', 'New bio'],
      ['marcus.okafor@example.com', 'Marcus', 'Okafor', 'Marcus bio'],
      ['newperson@example.com', 'Nia', 'Chen', 'Nia bio'],
    ];

    const preview = await api('/import/preview', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows,
    });
    expect(preview.status).toBe(200);
    const plan = (await preview.json()) as {
      summary: Record<string, number>;
      mapping: string[];
      rows: { action: string; label: string }[];
      rows_raw: string[][];
    };
    expect(plan.summary).toMatchObject({ create: 1, merge: 1, attach: 1 });

    const commit = await api('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows: plan.rows_raw, mapping: plan.mapping,
    });
    expect(commit.status).toBe(200);
    const committed = (await commit.json()) as { applied: Record<string, number> };
    // Committed outcome must equal the dry-run plan.
    expect(committed.applied).toMatchObject({ create: 1, merge: 1, attach: 1 });

    // Exactly one Priya / one Marcus contact in the org.
    const priyaCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM contacts WHERE org_id = ? AND lower(email) LIKE 'priya.raman@%'",
    ).bind(org!.org_id).first<{ n: number }>();
    expect(priyaCount?.n).toBe(1);
    const marcusRoster = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM event_contacts ec JOIN contacts c ON c.id = ec.contact_id
        WHERE ec.event_id = ? AND lower(c.email) = 'marcus.okafor@example.com'`,
    ).bind(eventId).first<{ n: number }>();
    expect(marcusRoster?.n).toBe(1);
  });

  it('409s (plan_changed) when the data drifted between dry run and commit', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    await seedContact(eventId, { email: 'drift@example.com', first_name: 'Dana', last_name: 'Drift' });

    const headers = ['Email', 'First name', 'Last name', 'Biography'];
    const rows = [['drift@example.com', 'Dana', 'Drift', 'A bio']];
    const preview = await api('/import/preview', admin.cookie, { target: 'contacts', event_id: eventId, headers, rows });
    const plan = (await preview.json()) as { mapping: string[]; rows: { action: string }[]; rows_raw: string[][] };
    expect(plan.rows[0]?.action).toBe('merge');

    // The ground moves under the plan: the merge target is deleted.
    await env.DB.prepare(
      "DELETE FROM event_contacts WHERE event_id = ? AND contact_id IN (SELECT id FROM contacts WHERE email = 'drift@example.com')",
    ).bind(eventId).run();
    await env.DB.prepare("DELETE FROM contacts WHERE email = 'drift@example.com'").run();

    const commit = await api('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows: plan.rows_raw, mapping: plan.mapping,
      expected_actions: plan.rows.map((r) => r.action),
    });
    expect(commit.status).toBe(409);
    expect(((await commit.json()) as { error: string }).error).toBe('plan_changed');

    // Nothing was written: the drifted plan was refused, not applied.
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM contacts WHERE email = 'drift@example.com'")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('splits a single mapped "Name" column into first/last on plan AND commit', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const headers = ['Name', 'Email'];
    const rows = [
      ['Priya Raman', 'priya.split@example.com'],
      ['Marcus J. Okafor', 'marcus.split@example.com'],
      ['Cher', 'cher.split@example.com'],
    ];
    const preview = await api('/import/preview', admin.cookie, { target: 'contacts', event_id: eventId, headers, rows });
    const plan = (await preview.json()) as {
      mapping: string[];
      rows: { action: string; values: Record<string, string> }[];
      rows_raw: string[][];
    };
    // The Name header auto-maps to the full_name field, not first_name.
    expect(plan.mapping[0]).toBe('full_name');
    expect(plan.rows[0]?.values).toMatchObject({ first_name: 'Priya', last_name: 'Raman' });
    expect(plan.rows[1]?.values).toMatchObject({ first_name: 'Marcus J.', last_name: 'Okafor' });
    expect(plan.rows[2]?.values).toMatchObject({ first_name: 'Cher' });
    expect(plan.rows[2]?.values.last_name).toBeUndefined();

    const commit = await api('/import/commit', admin.cookie, {
      target: 'contacts', event_id: eventId, headers, rows: plan.rows_raw, mapping: plan.mapping,
      expected_actions: plan.rows.map((r) => r.action),
    });
    expect(commit.status).toBe(200);
    const priya = await env.DB.prepare(
      "SELECT first_name, last_name FROM contacts WHERE email = 'priya.split@example.com'",
    ).first<{ first_name: string | null; last_name: string | null }>();
    expect(priya).toMatchObject({ first_name: 'Priya', last_name: 'Raman' });
  });
});
