// Workplan-5 §5: the speaker portal is per-event, the session is not. One
// sign-in reaches every event in the org where the caller is really involved;
// the cookie's `eventId` stopped being the guard and the resolved contact — by
// email, against the event in the URL — took over.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachContactToEvent,
  createContact,
  createEvent,
  createEventUser,
  sessionCookieFor,
} from './fixtures';
import {
  addParticipant,
  createFileAsset,
  createSubmission,
  createTaskAssignment,
  setHeadshot,
} from './fixtures-portal';
import { getPortalEvents, resolveEventActor } from '../src/access';
import { createSessionToken, SESSION_COOKIE } from '../src/session';

const ORIGIN = 'https://kms.test';

interface World {
  orgId: string;
  /** Event A — the one the cookie is minted against. */
  eventA: string;
  slugA: string;
  /** Event B — same org, speaker has a submission there. */
  eventB: string;
  slugB: string;
  /** Event C — same org, roster row only, no relationship. */
  eventC: string;
  slugC: string;
  /** Event D — a DIFFERENT org, where the same human is a different contact. */
  eventD: string;
  slugD: string;
  speaker: string;
  speakerInOtherOrg: string;
  stranger: string;
  slugStranger: string;
  cookieA: string;
}

let w: World;

const SPEAKER_EMAIL = 'roaming@example.com';

beforeEach(async () => {
  const orgId = `org-x-${crypto.randomUUID().slice(0, 8)}`;
  const slugA = `xa-${crypto.randomUUID().slice(0, 8)}`;
  const slugB = `xb-${crypto.randomUUID().slice(0, 8)}`;
  const slugC = `xc-${crypto.randomUUID().slice(0, 8)}`;
  const slugD = `xd-${crypto.randomUUID().slice(0, 8)}`;
  const slugStranger = `xs-${crypto.randomUUID().slice(0, 8)}`;

  const eventA = await createEvent({ org_id: orgId, slug: slugA, name: 'Event A', starts_at: '2026-10-01T08:00:00Z' });
  const eventB = await createEvent({ org_id: orgId, slug: slugB, name: 'Event B', starts_at: '2026-11-01T08:00:00Z' });
  const eventC = await createEvent({ org_id: orgId, slug: slugC, name: 'Event C', starts_at: '2026-12-01T08:00:00Z' });
  // Separate org: the same person is a different contact row there.
  const eventD = await createEvent({ slug: slugD, name: 'Event D' });
  // An event in the same org the speaker has nothing to do with at all.
  const eventStranger = await createEvent({ org_id: orgId, slug: slugStranger, name: 'Event S' });

  // One contact, three rosters — org-scoped identity since 0015.
  const speaker = await createContact(eventA, { email: SPEAKER_EMAIL, first_name: 'Ro', last_name: 'Amer' });
  await attachContactToEvent(eventB, speaker);
  await attachContactToEvent(eventC, speaker);
  // A submission at A and at B; C stays bare membership.
  const subA = await createSubmission(eventA, { submitterContactId: speaker, title: 'Talk at A' });
  await addParticipant(subA, speaker);
  const subB = await createSubmission(eventB, { submitterContactId: speaker, title: 'Talk at B' });
  await addParticipant(subB, speaker);

  const speakerInOtherOrg = await createContact(eventD, { email: SPEAKER_EMAIL, first_name: 'Ro', last_name: 'Amer' });
  await createSubmission(eventD, { submitterContactId: speakerInOtherOrg, title: 'Talk at D' });

  const stranger = await createContact(eventStranger, { email: 'stranger@example.com' });

  w = {
    orgId,
    eventA, slugA, eventB, slugB, eventC, slugC, eventD, slugD,
    speaker, speakerInOtherOrg, stranger, slugStranger,
    cookieA: await sessionCookieFor({ contactId: speaker, eventId: eventA, eventSlug: slugA, role: 'speaker' }),
  };
});

const get = (path: string, cookie: string) => SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });

describe('portal, one session across events', () => {
  it('reaches both portals of the org with a single cookie minted for event A', async () => {
    const a = await get(`/portal/${w.slugA}`, w.cookieA);
    const b = await get(`/portal/${w.slugB}`, w.cookieA);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.text()).toContain('Talk at A');
    const bodyB = await b.text();
    expect(bodyB).toContain('Talk at B');
    // Event B's page is event B's, not a re-render of the cookie's event.
    expect(bodyB).toContain('Event B');
    expect(bodyB).not.toContain('Talk at A');
  });

  it('401s on an event the caller has no event_contacts row for', async () => {
    const res = await get(`/portal/${w.slugStranger}`, w.cookieA);
    expect(res.status).toBe(401);
    // The login page, not a portal.
    expect(await res.text()).toContain('Email me a sign-in link');
  });

  it('a speaker on A only cannot open B', async () => {
    const soloEvent = await createEvent({ org_id: w.orgId, slug: `solo-${crypto.randomUUID().slice(0, 8)}` });
    const solo = await createContact(soloEvent, { email: 'solo@example.com' });
    const cookie = await sessionCookieFor({ contactId: solo, eventId: soloEvent, role: 'speaker' });
    expect((await get(`/portal/${w.slugB}`, cookie)).status).toBe(401);
  });

  it('resolves the OTHER org\'s contact row when the same email opens that org\'s portal', async () => {
    const res = await get(`/portal/${w.slugD}`, w.cookieA);
    expect(res.status).toBe(200);
    // The submission listed is the one belonging to the other org's contact,
    // which proves the page is not running on the cookie's contact id.
    expect(await res.text()).toContain('Talk at D');
    expect(w.speakerInOtherOrg).not.toBe(w.speaker);
  });

  it('scopes ownership writes to the contact resolved for the event in the URL', async () => {
    const res = await SELF.fetch(`${ORIGIN}/portal/${w.slugB}/profile`, {
      method: 'POST',
      headers: { cookie: w.cookieA, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ first_name: 'Ro', last_name: 'Amer', company: 'B Corp', biography: 'At B' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain(`/portal/${w.slugB}/profile`);
    const atB = await env.DB.prepare('SELECT company, biography FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(w.eventB, w.speaker)
      .first<{ company: string | null; biography: string | null }>();
    const atA = await env.DB.prepare('SELECT company, biography FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(w.eventA, w.speaker)
      .first<{ company: string | null; biography: string | null }>();
    expect(atB?.company).toBe('B Corp');
    // The per-event half of the profile must not bleed into the other event.
    expect(atA?.company).toBeNull();
  });
});

describe('accessible events (§5 relationship gate)', () => {
  it('lists events with a real relationship and hides bare membership', async () => {
    const events = await getPortalEvents(env.DB, { email: SPEAKER_EMAIL, eventId: w.eventA });
    const ids = events.map((e) => e.event_id);
    expect(ids).toContain(w.eventA);
    expect(ids).toContain(w.eventB);
    // Event C: an event_contacts row and nothing else. Listing it would tell the
    // speaker "event C has you on file".
    expect(ids).not.toContain(w.eventC);
    // Another org's event is never in this org's switcher.
    expect(ids).not.toContain(w.eventD);
  });

  it('counts a task assignment and a staff seat as relationships', async () => {
    await createTaskAssignment(w.eventC, w.speaker, { actionType: 'acknowledge' });
    let ids = (await getPortalEvents(env.DB, { email: SPEAKER_EMAIL, eventId: w.eventA })).map((e) => e.event_id);
    expect(ids).toContain(w.eventC);

    const seatEvent = await createEvent({ org_id: w.orgId, slug: `seat-${crypto.randomUUID().slice(0, 8)}` });
    await attachContactToEvent(seatEvent, w.speaker);
    await createEventUser(seatEvent, w.speaker, 'reviewer');
    ids = (await getPortalEvents(env.DB, { email: SPEAKER_EMAIL, eventId: w.eventA })).map((e) => e.event_id);
    expect(ids).toContain(seatEvent);
  });

  it('still gates on membership: no event_contacts row, no listing', async () => {
    const bare = await createEvent({ org_id: w.orgId, slug: `bare-${crypto.randomUUID().slice(0, 8)}` });
    // A submission at an event whose roster the speaker was never added to.
    await createSubmission(bare, { submitterContactId: w.speaker, title: 'Orphan' });
    const ids = (await getPortalEvents(env.DB, { email: SPEAKER_EMAIL, eventId: w.eventA })).map((e) => e.event_id);
    expect(ids).not.toContain(bare);
  });

  it('renders the other events as a switcher, and only those', async () => {
    const body = await (await get(`/portal/${w.slugA}`, w.cookieA)).text();
    expect(body).toContain(`/portal/${w.slugB}`);
    expect(body).not.toContain(`/portal/${w.slugC}`);
    // The stranger, with one event and no siblings, gets no switcher at all.
    const strangerCookie = await sessionCookieFor({ contactId: w.stranger, eventId: w.eventA, role: 'speaker' });
    await attachContactToEvent(w.eventA, w.stranger);
    const sub = await createSubmission(w.eventA, { submitterContactId: w.stranger });
    await addParticipant(sub, w.stranger);
    const strangerBody = await (await get(`/portal/${w.slugA}`, strangerCookie)).text();
    expect(strangerBody).not.toContain('Your other events');
  });
});

describe('GET /files/:id across events', () => {
  it('serves an event B asset to a session cookie minted for event A', async () => {
    const headshotB = await createFileAsset(w.eventB, { uploadedBy: w.speaker, filename: 'b.png' });
    await env.DB.prepare('UPDATE event_contacts SET headshot_asset_id = ? WHERE event_id = ? AND contact_id = ?')
      .bind(headshotB, w.eventB, w.speaker)
      .run();
    const res = await get(`/files/${headshotB}`, w.cookieA);
    expect(res.status).toBe(200);
    // ...and the portal page for B really links it.
    expect(await (await get(`/portal/${w.slugB}`, w.cookieA)).text()).toContain(`/files/${headshotB}`);
  });

  it('does not carry a staff role from one event to another', async () => {
    // Owner at A, plain speaker at B: the blanket owner grant must not follow.
    await createEventUser(w.eventA, w.speaker, 'owner');
    const other = await createContact(w.eventB, { email: 'other-b@example.com' });
    const theirHeadshot = await createFileAsset(w.eventB, { uploadedBy: other, filename: 'other.png' });
    await setHeadshot(other, theirHeadshot);
    const ownerCookie = await sessionCookieFor({ contactId: w.speaker, eventId: w.eventA, eventSlug: w.slugA, role: 'owner' });
    expect((await get(`/files/${theirHeadshot}`, ownerCookie)).status).toBe(404);
    // The same asset is readable by an owner OF EVENT B.
    const ownerB = await createContact(w.eventB, { email: 'owner-b@example.com' });
    await createEventUser(w.eventB, ownerB, 'owner');
    const cookieB = await sessionCookieFor({ contactId: ownerB, eventId: w.eventB, eventSlug: w.slugB, role: 'owner' });
    expect((await get(`/files/${theirHeadshot}`, cookieB)).status).toBe(200);
  });

  it('denies an asset in an org the caller has no contact in', async () => {
    const outsiderEvent = await createEvent({ slug: `out-${crypto.randomUUID().slice(0, 8)}` });
    const asset = await createFileAsset(outsiderEvent, { filename: 'secret.png' });
    await env.DB.prepare('UPDATE events SET logo_asset_id = ? WHERE id = ?').bind(asset, outsiderEvent).run();
    expect((await get(`/files/${asset}`, w.cookieA)).status).toBe(404);
  });
});

describe('impersonation', () => {
  it('resolves the per-event contact and keeps the banner', async () => {
    // "View Portal" mints a portal cookie for the SPEAKER (their contact and
    // email) carrying the admin's id in impersonatedBy — docs/03 §5.
    const admin = await createContact(w.eventA, { email: 'admin-imp@example.com' });
    await createEventUser(w.eventA, admin, 'admin');
    const token = await createSessionToken(
      {
        contactId: w.speaker,
        eventId: w.eventA,
        eventSlug: w.slugA,
        email: SPEAKER_EMAIL,
        role: 'speaker',
        impersonatedBy: admin,
      },
      env.SESSION_SECRET,
    );
    const cookie = `${SESSION_COOKIE}=${token}`;
    const a = await get(`/portal/${w.slugA}`, cookie);
    expect(a.status).toBe(200);
    expect(await a.text()).toContain('Admin impersonation');
    // And it crosses events exactly like a real speaker session does.
    const b = await get(`/portal/${w.slugB}`, cookie);
    expect(b.status).toBe(200);
    const bodyB = await b.text();
    expect(bodyB).toContain('Admin impersonation');
    expect(bodyB).toContain('Talk at B');
  });
});

describe('resolveEventActor', () => {
  it('returns the org-local contact and that event\'s role, or null', async () => {
    await createEventUser(w.eventB, w.speaker, 'admin');
    expect(await resolveEventActor(env.DB, SPEAKER_EMAIL, w.eventA)).toEqual({
      contactId: w.speaker,
      role: 'speaker',
    });
    expect(await resolveEventActor(env.DB, SPEAKER_EMAIL, w.eventB)).toEqual({
      contactId: w.speaker,
      role: 'admin',
    });
    // Same email, other org: a different contact row entirely.
    expect(await resolveEventActor(env.DB, SPEAKER_EMAIL, w.eventD)).toEqual({
      contactId: w.speakerInOtherOrg,
      role: 'speaker',
    });
    // Case-insensitive, like the unique index.
    expect((await resolveEventActor(env.DB, SPEAKER_EMAIL.toUpperCase(), w.eventA))?.contactId).toBe(w.speaker);
    // No relationship at all.
    expect(await resolveEventActor(env.DB, 'nobody@example.com', w.eventA)).toBeNull();
  });
});
