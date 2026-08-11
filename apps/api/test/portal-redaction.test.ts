// manual-review-1 item 3: organiser-only columns are stripped at the portal's
// query boundary, so no speaker-facing template can ever render them — even by
// accident, and even after someone adds a new field to a whole-row SELECT.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { addParticipant, createSubmission, setContactNotes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';
const MARKER = 'INTERNAL-MARKER-XYZ';

let slug: string;
let eventId: string;
let contactId: string;
let submissionId: string;
let cookie: string;

beforeEach(async () => {
  slug = `red-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  contactId = await createContact(eventId, { email: 'speaker@example.com' });
  await setContactNotes(contactId, `${MARKER} do not show the speaker`);
  submissionId = await createSubmission(eventId, {
    submitterContactId: contactId,
    notes: `${MARKER} reviewer chatter`,
  });
  await addParticipant(submissionId, contactId);
  cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'speaker' });
});

const get = (path: string) => SELF.fetch(`${ORIGIN}${path}`, { headers: { cookie } });

describe('portal redaction', () => {
  it('never renders internal notes on any portal page', async () => {
    for (const path of [
      `/portal/${slug}`,
      `/portal/${slug}/profile`,
      `/portal/${slug}/submissions`,
      `/portal/${slug}/submissions/${submissionId}`,
      `/portal/${slug}/tasks`,
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      expect(await res.text(), path).not.toContain(MARKER);
    }
  });

  it('keeps the notes in the database — this is a read boundary, not a delete', async () => {
    // `notes` is a per-event profile column on event_contacts since 0015.
    const contact = await env.DB.prepare('SELECT notes FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, contactId)
      .first<{ notes: string | null }>();
    const submission = await env.DB.prepare('SELECT notes FROM submissions WHERE id = ?')
      .bind(submissionId)
      .first<{ notes: string | null }>();
    expect(contact?.notes).toContain(MARKER);
    expect(submission?.notes).toContain(MARKER);
  });
});
