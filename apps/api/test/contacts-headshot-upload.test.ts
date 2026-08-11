// CNT-10: the organiser speaker edit form exposed no way to set a speaker's
// headshot at all — the only route in was the speaker's own portal profile
// page (portal.ts's POST /:slug/profile), unreachable for anyone who hasn't
// logged in yet. This adds the admin-side counterpart, POST
// /app/api/contacts/:id/headshot, reusing the exact same storage seam
// (filestore.ts's saveFile — same size/type limits, same magic-byte check,
// same file_assets/KV row) so a headshot set from either surface reads back
// identically through /files/:id and the public speaker headshot route.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { fileFrom, pngBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

async function staffSession(eventId: string, role: 'admin' | 'reviewer' = 'admin') {
  const contactId = await createContact(eventId, { email: `${role}-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, role);
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: eventId, role });
  return { contactId, cookie };
}

async function upload(cookie: string, contactId: string, file: File): Promise<Response> {
  const form = new FormData();
  form.set('headshot', file);
  return SELF.fetch(`${ORIGIN}/app/api/contacts/${contactId}/headshot`, {
    method: 'POST',
    headers: { cookie },
    body: form,
  });
}

describe('POST /app/api/contacts/:id/headshot', () => {
  it('stores an uploaded image and points the contact at it', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'speaker@example.com' });

    const res = await upload(admin.cookie, speaker, fileFrom(pngBytes(), 'headshot.png', 'image/png'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; headshot_asset_id: string };
    expect(body.ok).toBe(true);
    expect(body.headshot_asset_id).toBeTruthy();

    // Since 0015 the headshot pointer is per-event, on event_contacts.
    const row = await env.DB.prepare('SELECT headshot_asset_id FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, speaker)
      .first<{ headshot_asset_id: string | null }>();
    expect(row?.headshot_asset_id).toBe(body.headshot_asset_id);

    // Readable back through the session-gated file route, same as any other
    // asset (this is the same endpoint the portal-set headshot renders via).
    const fileRes = await SELF.fetch(`${ORIGIN}/files/${body.headshot_asset_id}`, { headers: { cookie: admin.cookie } });
    expect(fileRes.status).toBe(200);
  });

  it('replaces an existing headshot rather than accumulating rows on the contact', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'replace@example.com' });

    const first = await upload(admin.cookie, speaker, fileFrom(pngBytes(), 'one.png', 'image/png'));
    const firstId = ((await first.json()) as { headshot_asset_id: string }).headshot_asset_id;

    const second = await upload(admin.cookie, speaker, fileFrom(pngBytes(96), 'two.png', 'image/png'));
    const secondId = ((await second.json()) as { headshot_asset_id: string }).headshot_asset_id;
    expect(secondId).not.toBe(firstId);

    const row = await env.DB.prepare('SELECT headshot_asset_id FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, speaker)
      .first<{ headshot_asset_id: string | null }>();
    expect(row?.headshot_asset_id).toBe(secondId);
  });

  it('rejects a file over the 5 MB headshot limit', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'oversize@example.com' });

    const oversized = fileFrom(pngBytes(6 * 1024 * 1024), 'huge.png', 'image/png');
    const res = await upload(admin.cookie, speaker, oversized);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('too large');

    const row = await env.DB.prepare('SELECT headshot_asset_id FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, speaker)
      .first<{ headshot_asset_id: string | null }>();
    expect(row?.headshot_asset_id).toBeNull();
  });

  it('rejects a non-image content type', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'wrongtype@example.com' });

    const bytes = new TextEncoder().encode('%PDF-1.4 not really an image');
    const res = await upload(admin.cookie, speaker, fileFrom(bytes, 'doc.pdf', 'application/pdf'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not accepted');
  });

  it('rejects bytes that do not match the declared image type', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'spoofed@example.com' });

    const notActuallyPng = new TextEncoder().encode('this is not a real png file at all');
    const res = await upload(admin.cookie, speaker, fileFrom(notActuallyPng, 'fake.png', 'image/png'));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('do not match');
  });

  it('404s for a contact id outside the caller\'s event', async () => {
    const eventId = await createEvent();
    const otherEvent = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await staffSession(eventId);
    const foreignSpeaker = await createContact(otherEvent, { email: 'foreign@example.com' });

    const res = await upload(admin.cookie, foreignSpeaker, fileFrom(pngBytes(), 'headshot.png', 'image/png'));
    expect(res.status).toBe(404);
  });

  it('is forbidden to a reviewer', async () => {
    const eventId = await createEvent();
    const reviewer = await staffSession(eventId, 'reviewer');
    const speaker = await createContact(eventId, { email: 'target@example.com' });

    const res = await upload(reviewer.cookie, speaker, fileFrom(pngBytes(), 'headshot.png', 'image/png'));
    expect(res.status).toBe(403);
  });

  it('requires authentication', async () => {
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'anon@example.com' });

    const form = new FormData();
    form.set('headshot', fileFrom(pngBytes(), 'headshot.png', 'image/png'));
    const res = await SELF.fetch(`${ORIGIN}/app/api/contacts/${speaker}/headshot`, { method: 'POST', body: form });
    expect(res.status).toBe(401);
  });
});
