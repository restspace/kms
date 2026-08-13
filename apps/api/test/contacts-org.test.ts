// Workplan 5 §4 — the cross-event contact surfaces 0015 made expressible:
// the org-wide picker, the cross-event history panel, and delete-from-org as
// distinct from DELETE /contacts/:id's detach (covered by contacts-delete).
//
// The scoping assertions matter more than the happy paths here. Two of these
// tests exist purely to pin a boundary no other test covers: the picker must
// not reach across organisations, and the history panel must not disclose the
// existence of events the caller holds no seat on.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { attachContactToEvent } from './fixtures';
import {
  jsonReq, seedContact, seedEvent, seedEventUser, seedFileAsset, seedStaff, seedSubmission,
} from './fixtures-admin';

interface PickerRow {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company: string | null;
  job_title: string | null;
}

const search = async (cookie: string, q = ''): Promise<PickerRow[]> => {
  const res = await SELF.fetch(
    `https://example.com/app/api/contacts/org-search?q=${encodeURIComponent(q)}`,
    jsonReq(cookie, undefined, 'GET'),
  );
  const body = await res.text();
  expect(res.status, body).toBe(200);
  return (JSON.parse(body) as { items: PickerRow[] }).items;
};

describe('GET /app/api/contacts/org-search', () => {
  it('offers org siblings but never someone already on this event', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const admin = await seedStaff(eventA, 'admin');
    const onBoth = await seedContact(eventA, { email: 'already@example.com', last_name: 'Here' });
    await attachContactToEvent(eventB, onBoth);
    const elsewhere = await seedContact(eventB, { email: 'elsewhere@example.com', last_name: 'Away' });

    const ids = (await search(admin.cookie)).map((r) => r.id);
    expect(ids).toContain(elsewhere);
    // On this event's roster already — the "+ New" 409 covers that case, and
    // offering them here would be an attach that cannot happen.
    expect(ids).not.toContain(onBoth);
    // The caller's own staff contact is on this event too.
    expect(ids).not.toContain(admin.contactId);
  });

  it('never reaches into another organisation', async () => {
    const eventA = await seedEvent();
    const otherOrgEvent = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const stranger = await seedContact(otherOrgEvent, {
      email: 'stranger@example.com',
      first_name: 'Stran',
      last_name: 'Ger',
    });

    expect((await search(admin.cookie)).map((r) => r.id)).not.toContain(stranger);
    // …and not by name either: the search filter must not widen the scope.
    expect((await search(admin.cookie, 'Ger')).map((r) => r.id)).not.toContain(stranger);
  });

  it('shows the profile the attach would seed, from their most recent event', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const admin = await seedStaff(eventA, 'admin');
    const contactId = await seedContact(eventB, {
      email: 'returning@example.com', last_name: 'Lovelace', company: 'B Corp', job_title: 'CTO',
    });

    const row = (await search(admin.cookie, 'Lovelace')).find((r) => r.id === contactId);
    expect(row).toMatchObject({ company: 'B Corp', job_title: 'CTO' });
  });
});

describe('POST /app/api/contacts/:id/attach', () => {
  it('attaches and seeds the profile from their most recent event in the org', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId });
    const eventB = await seedEvent({ org_id: orgId });
    const admin = await seedStaff(eventA, 'admin');
    const headshot = await seedFileAsset(eventB, null, { filename: 'ada.png' });
    const contactId = await seedContact(eventB, {
      email: 'returning@example.com',
      first_name: 'Ada',
      biography: 'Wrote the first algorithm.',
      company: 'B Corp',
      job_title: 'CTO',
      notes: "B's private remarks",
      headshot_asset_id: headshot,
    });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/attach`,
      jsonReq(admin.cookie, undefined, 'POST'),
    );
    const row = (await res.json()) as Record<string, unknown>;
    expect(res.status, JSON.stringify(row)).toBe(201);
    expect(row).toMatchObject({
      id: contactId,
      event_id: eventA,
      biography: 'Wrote the first algorithm.',
      company: 'B Corp',
      job_title: 'CTO',
      source: 'admin',
    });
    // The headshot is an event-scoped asset and the notes are one event team's
    // private remarks — neither travels (packages/db attachToEvent, 0015).
    expect(row.headshot_asset_id).toBeNull();
    expect(row.notes).toBeNull();

    // One identity, two memberships.
    const memberships = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?',
    ).bind(contactId).first<{ n: number }>();
    expect(memberships?.n).toBe(2);

    // Idempotent from the UI's point of view: a second attach is a conflict,
    // not a silent duplicate.
    const again = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/attach`,
      jsonReq(admin.cookie, undefined, 'POST'),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'already_on_event' });
  });

  it('refuses a contact from another organisation', async () => {
    const eventA = await seedEvent();
    const otherOrgEvent = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const stranger = await seedContact(otherOrgEvent, { email: 'stranger@example.com' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${stranger}/attach`,
      jsonReq(admin.cookie, undefined, 'POST'),
    );
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ? AND event_id = ?',
    ).bind(stranger, eventA).first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});

describe('GET /app/api/contacts/:id/history', () => {
  /** One org, two events, one person on both with a submission at each. */
  async function seedTwoEventSpeaker() {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
    const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
    const contactId = await seedContact(eventA, { email: 'twice@example.com', last_name: 'Hopper' });
    await attachContactToEvent(eventB, contactId, { company: 'B Corp' });
    await seedSubmission(eventA, { submitter_contact_id: contactId, title: 'Alpha Talk' });
    await seedSubmission(eventB, { submitter_contact_id: contactId, title: 'Beta Talk' });
    return { orgId, eventA, eventB, contactId };
  }

  it('never discloses an event the caller holds no seat on', async () => {
    const { eventA, eventB, contactId } = await seedTwoEventSpeaker();
    const admin = await seedStaff(eventA, 'admin');

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/history`,
      jsonReq(admin.cookie, undefined, 'GET'),
    );
    expect(res.status).toBe(200);
    const body = await res.text();

    // The strongest form of the assertion: event B must not appear anywhere in
    // the payload — not as a group, not as a submission, not as a tally of
    // "events you cannot see", which would disclose the same thing.
    expect(body).not.toContain(eventB);
    expect(body).not.toContain('Beta Summit');
    expect(body).not.toContain('Beta Talk');

    const parsed = JSON.parse(body) as {
      events: Array<{ event_id: string; submissions: Array<{ title: string }> }>;
      current_event_id: string;
    };
    expect(parsed.current_event_id).toBe(eventA);
    expect(parsed.events.map((e) => e.event_id)).toEqual([eventA]);
    expect(parsed.events[0].submissions.map((s) => s.title)).toEqual(['Alpha Talk']);
  });

  it('spans every event the caller does hold a seat on', async () => {
    const { eventA, eventB, contactId } = await seedTwoEventSpeaker();
    const admin = await seedStaff(eventA, 'admin');
    // The same staff email seated on B too — access.ts resolves the seat by
    // email across the org, so the session cookie stays minted against A.
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'admin');

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/history`,
      jsonReq(admin.cookie, undefined, 'GET'),
    );
    const parsed = (await res.json()) as {
      events: Array<{ event_id: string; company: string | null; submissions: Array<{ title: string; role: string | null }> }>;
    };
    expect(parsed.events.map((e) => e.event_id).sort()).toEqual([eventA, eventB].sort());
    const beta = parsed.events.find((e) => e.event_id === eventB);
    expect(beta?.company).toBe('B Corp');
    expect(beta?.submissions).toEqual([
      expect.objectContaining({ title: 'Beta Talk', role: 'submitter' }),
    ]);
  });

  it('404s for a contact who is not on this event', async () => {
    const { contactId } = await seedTwoEventSpeaker();
    const outsider = await seedStaff(await seedEvent(), 'admin');

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/history`,
      jsonReq(outsider.cookie, undefined, 'GET'),
    );
    expect(res.status).toBe(404);
  });

  // Eval defect #6a: the org-level directory (scope: 'org') hands every row
  // `event_id: null` — a person is org-wide there, not tied to one event —
  // so the SPA's cross-event panel opens with no ?event_id= to send and the
  // route fell back to session.eventId, which is frequently NOT one of this
  // contact's events when they were found through the org directory rather
  // than a roster. That read as "The record no longer exists" for a contact
  // who plainly does. The route should fall back to any event the caller can
  // access that the contact is actually on.
  it('falls back to another accessible event when the caller omits ?event_id and is not on the contact’s roster', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
    const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
    const admin = await seedStaff(eventA, 'admin');
    // The admin also has a writer seat on B (so B is in accessibleEventIds),
    // but the contact is ONLY on B, never on the admin's home event A.
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'admin');
    const contactId = await seedContact(eventB, { email: 'beta-only@example.com', last_name: 'Lovelace' });
    await seedSubmission(eventB, { submitter_contact_id: contactId, title: 'Beta Only Talk' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/history`,
      jsonReq(admin.cookie, undefined, 'GET'),
    );
    expect(res.status, await res.clone().text()).toBe(200);
    const parsed = (await res.json()) as {
      events: Array<{ event_id: string; submissions: Array<{ title: string }> }>;
      current_event_id: string;
    };
    expect(parsed.current_event_id).toBe(eventB);
    expect(parsed.events.map((e) => e.event_id)).toEqual([eventB]);
    expect(parsed.events[0].submissions.map((s) => s.title)).toEqual(['Beta Only Talk']);
  });

  it('still 404s an explicit ?event_id= the contact is not on, even with another accessible event that would have matched', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
    const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
    const admin = await seedStaff(eventA, 'admin');
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'admin');
    const contactId = await seedContact(eventB, { email: 'beta-only-2@example.com' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${contactId}/history?event_id=${eventA}`,
      jsonReq(admin.cookie, undefined, 'GET'),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /app/api/contacts/:id/org', () => {
  it('deletes outright when no other event references them', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'only-here@example.com' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${speaker}/org`,
      jsonReq(admin.cookie, undefined, 'DELETE'),
    );
    expect(await res.json(), `status ${res.status}`).toEqual({ ok: true, events_affected: 1 });
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first()).toBeNull();
  });

  it('refuses without confirm while another event references them, and names it', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
    const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
    const admin = await seedStaff(eventA, 'admin');
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'admin');
    const speaker = await seedContact(eventA, { email: 'twice@example.com' });
    await attachContactToEvent(eventB, speaker);

    const refused = await SELF.fetch(
      `https://example.com/app/api/contacts/${speaker}/org`,
      jsonReq(admin.cookie, undefined, 'DELETE'),
    );
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: 'confirm_required',
      events: [{ event_id: eventB, event_name: 'Beta Summit' }],
    });
    // Nothing happened — not even the detach.
    const still = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?',
    ).bind(speaker).first<{ n: number }>();
    expect(still?.n).toBe(2);

    const confirmed = await SELF.fetch(
      `https://example.com/app/api/contacts/${speaker}/org?confirm=1`,
      jsonReq(admin.cookie, undefined, 'DELETE'),
    );
    expect(await confirmed.json(), `status ${confirmed.status}`).toEqual({ ok: true, events_affected: 2 });
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first()).toBeNull();
    const left = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM event_contacts WHERE contact_id = ?',
    ).bind(speaker).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it('refuses outright when one of those events is not the caller’s', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const eventA = await seedEvent({ org_id: orgId, name: 'Alpha Conf' });
    const eventB = await seedEvent({ org_id: orgId, name: 'Beta Summit' });
    const admin = await seedStaff(eventA, 'admin');
    const speaker = await seedContact(eventA, { email: 'twice@example.com' });
    await attachContactToEvent(eventB, speaker);

    for (const url of [
      `https://example.com/app/api/contacts/${speaker}/org`,
      `https://example.com/app/api/contacts/${speaker}/org?confirm=1`,
    ]) {
      const res = await SELF.fetch(url, jsonReq(admin.cookie, undefined, 'DELETE'));
      expect(res.status).toBe(403);
      // The refusal names nothing: an organiser of A must not learn B exists.
      expect(await res.json()).toEqual({ error: 'other_events_not_accessible' });
    }
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(speaker).first()).not.toBeNull();
  });

  it('404s for a contact who is not on this event', async () => {
    const eventA = await seedEvent();
    const eventOther = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const victim = await seedContact(eventOther, { email: 'other@example.com' });

    const res = await SELF.fetch(
      `https://example.com/app/api/contacts/${victim}/org`,
      jsonReq(admin.cookie, undefined, 'DELETE'),
    );
    expect(res.status).toBe(404);
    expect(await env.DB.prepare('SELECT id FROM contacts WHERE id = ?').bind(victim).first()).not.toBeNull();
  });
});
