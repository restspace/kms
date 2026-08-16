// ABS-11: portal co-author add/remove — a speaker managing their own
// submission's roster from the edit page, without ever touching the
// organiser-only endpoints (routes/evaluation.ts).

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { addParticipant, createFileAsset, createQuestion, createSubmission, createSubmissionForm, setHeadshot } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let formId: string;
let cookie: string;

async function seedSubmission(status = 'pending'): Promise<string> {
  const id = await createSubmission(eventId, { status, submitterContactId: speakerId, formId, title: 'Original title' });
  await addParticipant(id, speakerId);
  return id;
}

beforeEach(async () => {
  slug = `co-auth-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Grace', last_name: 'Hopper' });
  formId = await createSubmissionForm(eventId);
  // resolveEditTarget requires at least one abstract-section question to
  // treat the submission as editable at all.
  await createQuestion(eventId, formId, { key: 'title', label: 'Title', required: true, position: 0 });
  cookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });
});

const editUrl = (id: string) => `${ORIGIN}/portal/${slug}/submissions/${id}/edit`;

const postAdd = (id: string, fields: Record<string, string>, who = cookie) =>
  SELF.fetch(`${editUrl(id)}/participants/add`, {
    method: 'POST',
    headers: { cookie: who, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });

const postRemove = (id: string, pid: string, who = cookie) =>
  SELF.fetch(`${editUrl(id)}/participants/${pid}/remove`, {
    method: 'POST',
    headers: { cookie: who },
    redirect: 'manual',
  });

interface ParticipantRow {
  id: string;
  contact_id: string;
  role: string;
  position: number;
  is_primary_contact: number;
  confirmed_at: string | null;
}

const participantsOf = async (submissionId: string) =>
  (
    await env.DB.prepare('SELECT id, contact_id, role, position, is_primary_contact, confirmed_at FROM submission_participants WHERE submission_id = ? ORDER BY position')
      .bind(submissionId)
      .all<ParticipantRow>()
  ).results;

describe('portal co-author add (ABS-11)', () => {
  it('creates a contact, an event_contacts row and a participant row with the next position', async () => {
    const id = await seedSubmission();
    const res = await postAdd(id, { p_first: 'Ada', p_last: 'Lovelace', p_email: 'ada@example.com', p_role: 'co-author' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/edit?m=');
    expect(res.headers.get('location')).not.toContain('?m=!'); // no '!' error prefix

    const rows = await participantsOf(id);
    expect(rows).toHaveLength(2);
    const added = rows.find((r) => r.position === 1);
    expect(added).toBeTruthy();
    expect(added?.role).toBe('co-author');
    expect(added?.is_primary_contact).toBe(0);
    expect(added?.confirmed_at).toBeNull(); // own:false

    const contact = await env.DB.prepare('SELECT first_name, last_name, org_id FROM contacts WHERE id = ?')
      .bind(added!.contact_id)
      .first<{ first_name: string; last_name: string; org_id: string }>();
    expect(contact).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });

    const ec = await env.DB.prepare('SELECT event_id, contact_id FROM event_contacts WHERE contact_id = ? AND event_id = ?')
      .bind(added!.contact_id, eventId)
      .first();
    expect(ec).toBeTruthy();

    // content_revisions row recorded, source='portal'.
    const revision = await env.DB.prepare(
      "SELECT source FROM content_revisions WHERE entity_type = 'submission_participants' AND entity_id = ? ORDER BY edited_at DESC LIMIT 1",
    ).bind(id).first<{ source: string }>();
    expect(revision?.source).toBe('portal');
  });

  it('does not overwrite an existing contact\'s self-managed profile when adding by email', async () => {
    const id = await seedSubmission();
    const existing = await createContact(eventId, {
      email: 'grace2@example.com',
      first_name: 'Established',
      last_name: 'Speaker',
      biography: 'A carefully written bio.',
    });

    const res = await postAdd(id, {
      p_first: 'Someone',
      p_last: 'Else',
      p_email: 'grace2@example.com',
      p_role: 'co-author',
    });
    expect(res.status).toBe(302);

    const contact = await env.DB.prepare('SELECT id, first_name, last_name FROM contacts WHERE id = ?')
      .bind(existing)
      .first<{ id: string; first_name: string; last_name: string }>();
    expect(contact).toMatchObject({ first_name: 'Established', last_name: 'Speaker' });

    const ec = await env.DB.prepare('SELECT biography FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, existing)
      .first<{ biography: string | null }>();
    expect(ec?.biography).toBe('A carefully written bio.');
  });

  it('refuses a duplicate email with an error flash and writes nothing', async () => {
    const id = await seedSubmission();
    await postAdd(id, { p_first: 'Ada', p_last: 'Lovelace', p_email: 'ada@example.com', p_role: 'co-author' });
    const before = await participantsOf(id);

    const res = await postAdd(id, { p_first: 'Ada', p_last: 'Duplicate', p_email: 'ADA@example.com', p_role: 'co-author' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!'); // '!' error prefix

    const after = await participantsOf(id);
    expect(after).toHaveLength(before.length);
  });

  it('rejects an invalid email shape', async () => {
    const id = await seedSubmission();
    const res = await postAdd(id, { p_first: 'Ada', p_last: 'Lovelace', p_email: 'not-an-email', p_role: 'co-author' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!');
    expect(await participantsOf(id)).toHaveLength(1);
  });

  it('enforces the participant cap', async () => {
    const id = await seedSubmission();
    for (let i = 0; i < 9; i++) {
      const res = await postAdd(id, {
        p_first: `First${i}`,
        p_last: `Last${i}`,
        p_email: `person${i}@example.com`,
        p_role: 'co-author',
      });
      expect(res.status).toBe(302);
    }
    expect(await participantsOf(id)).toHaveLength(10); // MAX_PARTICIPANTS_PER_SUBMISSION

    const res = await postAdd(id, { p_first: 'One', p_last: 'Too Many', p_email: 'overflow@example.com', p_role: 'co-author' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!');
    expect(await participantsOf(id)).toHaveLength(10);
  });

  it('does not offer the add form once the submission is at the cap', async () => {
    const id = await seedSubmission();
    for (let i = 0; i < 9; i++) {
      await postAdd(id, { p_first: `F${i}`, p_last: `L${i}`, p_email: `cap${i}@example.com`, p_role: 'co-author' });
    }
    const html = await (await SELF.fetch(editUrl(id), { headers: { cookie } })).text();
    expect(html).not.toContain('name="p_email"');
    expect(html).toContain('maximum of 10 participants');
  });
});

describe('portal co-author remove (ABS-11)', () => {
  it('removes a non-primary participant', async () => {
    const id = await seedSubmission();
    const coAuthor = await createContact(eventId, { email: 'co@example.com' });
    await addParticipant(id, coAuthor, 'co-author');
    // addParticipant (fixtures-portal.ts) always inserts is_primary_contact=1;
    // a co-author added after the fact is not the primary contact.
    await env.DB.prepare('UPDATE submission_participants SET is_primary_contact = 0 WHERE submission_id = ? AND contact_id = ?')
      .bind(id, coAuthor)
      .run();
    const rows = await participantsOf(id);
    const target = rows.find((r) => r.contact_id === coAuthor)!;

    const res = await postRemove(id, target.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain('?m=!');
    expect(await participantsOf(id)).toHaveLength(1);

    const revision = await env.DB.prepare(
      "SELECT source FROM content_revisions WHERE entity_type = 'submission_participants' AND entity_id = ? ORDER BY edited_at DESC LIMIT 1",
    ).bind(id).first<{ source: string }>();
    expect(revision?.source).toBe('portal');
  });

  it('refuses to remove the primary contact', async () => {
    const id = await seedSubmission();
    const rows = await participantsOf(id);
    const primary = rows.find((r) => r.is_primary_contact === 1)!;

    const res = await postRemove(id, primary.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!');
    expect(await participantsOf(id)).toHaveLength(1);
  });

  it('refuses to remove the acting speaker\'s own row even when not primary', async () => {
    const id = await seedSubmission();
    // Demote the seeded row so is_primary_contact is not what blocks this.
    await env.DB.prepare('UPDATE submission_participants SET is_primary_contact = 0 WHERE submission_id = ? AND contact_id = ?')
      .bind(id, speakerId)
      .run();
    const rows = await participantsOf(id);
    const own = rows.find((r) => r.contact_id === speakerId)!;

    const res = await postRemove(id, own.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!');
    expect(await participantsOf(id)).toHaveLength(1);
  });

  it('404s / no-ops for a participant id from another event\'s submission', async () => {
    const id = await seedSubmission();
    const otherSlug = `other-${crypto.randomUUID().slice(0, 8)}`;
    const otherEvent = await createEvent({ slug: otherSlug });
    const otherSpeaker = await createContact(otherEvent, { email: 'other-speaker@example.com' });
    const otherSubmission = await createSubmission(otherEvent, { submitterContactId: otherSpeaker, status: 'pending' });
    await addParticipant(otherSubmission, otherSpeaker);
    const otherCoAuthor = await createContact(otherEvent, { email: 'other-co@example.com' });
    await addParticipant(otherSubmission, otherCoAuthor, 'co-author');
    const foreignRow = (await participantsOf(otherSubmission)).find((r) => r.contact_id === otherCoAuthor)!;

    const res = await postRemove(id, foreignRow.id);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('?m=!');
    // The foreign submission's roster is untouched.
    expect(await participantsOf(otherSubmission)).toHaveLength(2);
  });
});

describe('locked submissions and closed forms (ABS-11)', () => {
  it.each(['declined', 'withdrawn'])('refuses add on a %s submission (403)', async (status) => {
    const id = await seedSubmission(status);
    const res = await postAdd(id, { p_first: 'Ada', p_last: 'Lovelace', p_email: 'ada@example.com', p_role: 'co-author' });
    expect(res.status).toBe(403);
  });

  it.each(['declined', 'withdrawn'])('refuses remove on a %s submission (403)', async (status) => {
    const id = await seedSubmission(status);
    const rows = await participantsOf(id);
    const res = await postRemove(id, rows[0]!.id);
    expect(res.status).toBe(403);
  });
});

// Defect #12: event_contacts.biography (the profile store) and a
// submission's Participant-step biography answer (submission_participants
// .answers_json) are supposed to merge at submit time, but any path that
// leaves them out of sync — an add that predates the bio question, data
// seeded directly, and so on — used to leave the portal warning "bio
// missing" even though the speaker plainly supplied one on a submission.
describe('profile bio falls back to a submission-participant bio (defect #12)', () => {
  it('backfills an empty profile bio from the newest submission-participant answer and clears the warning', async () => {
    const bioQuestion = await createQuestion(eventId, formId, {
      key: 'biography',
      label: 'Biography',
      section: 'participant',
      position: 1,
    });
    const id = await seedSubmission();
    await env.DB.prepare('UPDATE submission_participants SET answers_json = ? WHERE submission_id = ? AND contact_id = ?')
      .bind(JSON.stringify({ [bioQuestion]: 'A carefully written bio from the wizard.' }), id, speakerId)
      .run();
    // A headshot is already on file — isolates this case to the bio half of
    // the "bio or headshot is missing" warning.
    await setHeadshot(speakerId, await createFileAsset(eventId));
    // Profile store still empty — nothing has synced it yet.
    expect(
      (await env.DB.prepare('SELECT biography FROM event_contacts WHERE event_id = ? AND contact_id = ?')
        .bind(eventId, speakerId)
        .first<{ biography: string | null }>())?.biography,
    ).toBeNull();

    const html = await (await SELF.fetch(`${ORIGIN}/portal/${slug}`, { headers: { cookie } })).text();
    expect(html).not.toContain('bio or headshot is missing');

    const profileHtml = await (await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, { headers: { cookie } })).text();
    expect(profileHtml).toContain('A carefully written bio from the wizard.');

    // Backfilled onto the profile row so subsequent reads (and the profile
    // edit form) see it too, not just this one render.
    const ec = await env.DB.prepare('SELECT biography FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, speakerId)
      .first<{ biography: string | null }>();
    expect(ec?.biography).toBe('A carefully written bio from the wizard.');
  });

  it('leaves an existing profile bio alone rather than overwriting it from a submission', async () => {
    await createQuestion(eventId, formId, { key: 'biography', label: 'Biography', section: 'participant', position: 1 });
    await env.DB.prepare('UPDATE event_contacts SET biography = ? WHERE event_id = ? AND contact_id = ?')
      .bind('The real, current profile bio.', eventId, speakerId)
      .run();

    const html = await (await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, { headers: { cookie } })).text();
    expect(html).toContain('The real, current profile bio.');
  });

  it('still warns when neither store has a bio, naming what is missing (D4)', async () => {
    await seedSubmission();
    const html = await (await SELF.fetch(`${ORIGIN}/portal/${slug}`, { headers: { cookie } })).text();
    // CFP-S2: the old wording ("your bio or headshot is missing") could not
    // say which, so a speaker who had just written a bio in the submission's
    // participant step read it as their words having been lost.
    expect(html).toContain('Your biography and headshot are missing');
    expect(html).toContain('/profile#field-biography');
  });

  it('names only the headshot once a bio exists', async () => {
    await seedSubmission();
    await env.DB.prepare('UPDATE event_contacts SET biography = ? WHERE event_id = ? AND contact_id = ?')
      .bind('A bio that came from the participant step.', eventId, speakerId)
      .run();
    const html = await (await SELF.fetch(`${ORIGIN}/portal/${slug}`, { headers: { cookie } })).text();
    expect(html).toContain('Your headshot is missing');
    expect(html).not.toContain('Your biography');
  });
});
