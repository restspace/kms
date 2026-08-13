// SPK-10: "the Files area reported 0 records both before and after a
// headshot was uploaded" — headshots went through filestore.ts's saveFile,
// which only writes a file_assets row (+ contacts.headshot_asset_id), but
// GET /app/api/files/library (filesAdmin.ts, the query behind the Files
// workspace tab) reads exclusively from file_request_uploads joined onto
// file_assets. A file_assets row with no matching file_request_uploads row
// was invisible to that query. Both the admin-side upload
// (POST /app/api/contacts/:id/headshot, adminApi.ts) and the portal
// self-service upload (POST /portal/:slug/profile, portal.ts) now register
// each headshot save as a version in a per-event "Headshots" file-request
// chain, so it shows up in the library exactly like any other uploaded file.

import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { fileFrom, pngBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

interface LibraryRow {
  upload_id: string;
  filename: string;
  size_bytes: number | null;
  uploaded_at: string;
  contact_id: string;
  uploader_name: string | null;
  uploader_email: string | null;
  uploaded_by_name: string | null;
  uploaded_by_email: string | null;
  submission_code: string | null;
}

async function library(cookie: string, eventId?: string): Promise<{ items: LibraryRow[]; total: number }> {
  const qs = eventId ? `?event_id=${eventId}` : '';
  const res = await SELF.fetch(`${ORIGIN}/app/api/files/library${qs}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return res.json();
}

describe('Files library — headshots (SPK-10)', () => {
  it('an admin-uploaded headshot appears in the library, "for" the speaker', async () => {
    const eventId = await createEvent();
    const adminContactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminContactId, 'admin');
    const adminCookie = await sessionCookieFor({ contactId: adminContactId, eventId, eventSlug: eventId, role: 'admin' });

    const speaker = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Ada', last_name: 'Byron' });

    const before = await library(adminCookie, eventId);
    expect(before.total).toBe(0);

    const form = new FormData();
    form.set('headshot', fileFrom(pngBytes(), 'ada.png', 'image/png'));
    const res = await SELF.fetch(`${ORIGIN}/app/api/contacts/${speaker}/headshot`, {
      method: 'POST',
      headers: { cookie: adminCookie },
      body: form,
    });
    expect(res.status).toBe(200);
    const { headshot_asset_id: assetId } = (await res.json()) as { headshot_asset_id: string };

    const after = await library(adminCookie, eventId);
    expect(after.total).toBe(1);
    const row = after.items[0]!;
    expect(row.filename).toBe('ada.png');
    expect(row.size_bytes).toBeGreaterThan(0);
    expect(row.uploaded_at).toBeTruthy();
    // "For" the speaker whose headshot it is.
    expect(row.contact_id).toBe(speaker);
    expect(row.uploader_name).toBe('Ada Byron');
    expect(row.submission_code).toBeNull();

    // A working view/download control — the existing per-file route.
    const fileRes = await SELF.fetch(`${ORIGIN}/files/${assetId}`, { headers: { cookie: adminCookie } });
    expect(fileRes.status).toBe(200);
  });

  it('a second admin headshot upload for the same speaker appends a new version rather than duplicating rows', async () => {
    const eventId = await createEvent();
    const adminContactId = await createContact(eventId, { email: `admin2-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminContactId, 'admin');
    const adminCookie = await sessionCookieFor({ contactId: adminContactId, eventId, eventSlug: eventId, role: 'admin' });
    const speaker = await createContact(eventId, { email: 'speaker2@example.com' });

    const uploadOnce = (name: string) => {
      const form = new FormData();
      form.set('headshot', fileFrom(pngBytes(), name, 'image/png'));
      return SELF.fetch(`${ORIGIN}/app/api/contacts/${speaker}/headshot`, {
        method: 'POST',
        headers: { cookie: adminCookie },
        body: form,
      });
    };

    expect((await uploadOnce('one.png')).status).toBe(200);
    expect((await uploadOnce('two.png')).status).toBe(200);

    const after = await library(adminCookie, eventId);
    expect(after.total).toBe(1);
    expect(after.items[0]!.filename).toBe('two.png');
  });

  it('a self-service portal headshot upload also appears in the library', async () => {
    const slug = `lib-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = await createEvent({ slug });
    const speaker = await createContact(eventId, { email: 'self@example.com', first_name: 'Grace', last_name: 'Hopper' });
    const speakerCookie = await sessionCookieFor({ contactId: speaker, eventId, eventSlug: slug, role: 'speaker' });

    const adminContactId = await createContact(eventId, { email: `admin3-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminContactId, 'admin');
    const adminCookie = await sessionCookieFor({ contactId: adminContactId, eventId, eventSlug: eventId, role: 'admin' });

    const form = new FormData();
    form.set('first_name', 'Grace');
    form.set('last_name', 'Hopper');
    form.set('headshot', fileFrom(pngBytes(), 'grace.png', 'image/png'));
    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/profile`, {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body: form,
      redirect: 'manual',
    });
    expect(res.status).toBe(302);

    const after = await library(adminCookie, eventId);
    expect(after.total).toBe(1);
    expect(after.items[0]!.filename).toBe('grace.png');
    expect(after.items[0]!.contact_id).toBe(speaker);
  });

  // Replay defect #11: `?rec=<upload_id>` deep-link restore in the admin SPA
  // resolves the detail tab's row through GET /library?upload_id=… — a single
  // chain by its current upload row's id, still inside the accessible-event
  // scope every other library read enforces.
  it('upload_id narrows the library to that single chain', async () => {
    const eventId = await createEvent();
    const adminContactId = await createContact(eventId, { email: `admin4-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminContactId, 'admin');
    const adminCookie = await sessionCookieFor({ contactId: adminContactId, eventId, eventSlug: eventId, role: 'admin' });

    for (const [email, name] of [['a@example.com', 'a.png'], ['b@example.com', 'b.png']] as const) {
      const speaker = await createContact(eventId, { email });
      const form = new FormData();
      form.set('headshot', fileFrom(pngBytes(), name, 'image/png'));
      const res = await SELF.fetch(`${ORIGIN}/app/api/contacts/${speaker}/headshot`, {
        method: 'POST',
        headers: { cookie: adminCookie },
        body: form,
      });
      expect(res.status).toBe(200);
    }

    const all = await library(adminCookie, eventId);
    expect(all.total).toBe(2);
    const target = all.items.find((r) => r.filename === 'a.png')!;

    const one = await SELF.fetch(
      `${ORIGIN}/app/api/files/library?upload_id=${target.upload_id}&event_id=${eventId}`,
      { headers: { cookie: adminCookie } },
    );
    expect(one.status).toBe(200);
    const body = (await one.json()) as { items: LibraryRow[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]!.upload_id).toBe(target.upload_id);
    expect(body.items[0]!.filename).toBe('a.png');

    // An unknown id resolves to nothing rather than erroring — the SPA drops
    // the stale deep link.
    const gone = await SELF.fetch(`${ORIGIN}/app/api/files/library?upload_id=nope`, {
      headers: { cookie: adminCookie },
    });
    expect(gone.status).toBe(200);
    expect(((await gone.json()) as { total: number }).total).toBe(0);
  });
});
