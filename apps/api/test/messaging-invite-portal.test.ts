// SPK-06: organiser-triggered portal invitation, via the new
// /app/api/messaging/invite-portal endpoint (messagingAdmin.ts). Mirrors the
// magic_link seam /auth/request uses, so success/failure is visible the same
// way every other send is: a message_log row with a status.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { countRows } from './fixtures-submission';

const json = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function adminSession(eventId: string, slug: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'admin' });
  return { contactId, cookie };
}

describe('POST /app/api/messaging/invite-portal', () => {
  it('queues a magic_link send to the target contact', async () => {
    const eventId = await createEvent();
    const admin = await adminSession(eventId, eventId);
    const speaker = await createContact(eventId, { email: 'speaker@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/invite-portal',
      json(admin.cookie, { contact_id: speaker }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; outcome: string; link: string };
    expect(body.ok).toBe(true);
    expect(body.outcome).toBe('queued');
    // The organiser gets the actual minted link back too, so they can verify
    // or share the invite (or preview the portal as the speaker) without
    // needing that speaker's inbox.
    expect(body.link).toMatch(/^https?:\/\/.+\/auth\/callback\?t=.+/);

    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'magic_link' AND event_id = ? AND to_email = 'speaker@example.com'`,
        eventId,
      ),
    ).toBe(1);
  });

  it('rejects a contact from a different event', async () => {
    const eventId = await createEvent();
    const otherEvent = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await adminSession(eventId, eventId);
    const foreign = await createContact(otherEvent, { email: 'foreign@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/invite-portal',
      json(admin.cookie, { contact_id: foreign }),
    );
    expect(res.status).toBe(404);
  });

  it('requires authentication', async () => {
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'speaker2@example.com' });
    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/invite-portal',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact_id: speaker }) },
    );
    expect(res.status).toBe(401);
  });
});
