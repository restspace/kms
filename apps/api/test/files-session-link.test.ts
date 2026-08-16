// CNT-13: an uploaded file that belongs to a session but says so nowhere.
//
// The portal's stock "Upload Session Presentation" task is targeted at the
// CONTACT, so `file_request_uploads.submission_id` is NULL and neither of the
// library's two old resolution steps could find the session: the Files tab's
// SESSION column read blank, and the session's own Files tab said "No files
// uploaded for this submission" — the same file missing from both ends.
//
// Step 3 (the uploader's single accepted session in the event) closes the
// ordinary case; PUT /uploads/:id/submission closes the ambiguous one, where
// the server must not guess.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';
import { fileFrom, pdfBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

interface LibRow {
  upload_id: string;
  filename: string;
  session_id: string | null;
  session_code: string | null;
}

let eventId: string;
let admin: { contactId: string; cookie: string; email: string };
let speakerId: string;
let submissionId: string;
let uploadId: string;

/** The state a contact-targeted portal upload leaves behind: a real chain with
 *  no `submission_id` stamped on it. */
async function seedUnstampedUpload(): Promise<string> {
  const form = new FormData();
  form.set('file', fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'));
  form.set('submission_id', submissionId);
  const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads`, {
    method: 'POST',
    headers: { cookie: admin.cookie },
    body: form,
  });
  expect(res.status).toBe(201);
  const { upload_id } = (await res.json()) as { upload_id: string };
  await env.DB.prepare('UPDATE file_request_uploads SET submission_id = NULL WHERE id = ?').bind(upload_id).run();
  return upload_id;
}

async function library(query = ''): Promise<LibRow[]> {
  const res = await SELF.fetch(`${ORIGIN}/app/api/files/library${query}`, {
    headers: { cookie: admin.cookie, accept: 'application/json' },
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { items: LibRow[] }).items;
}

beforeEach(async () => {
  eventId = await seedEvent();
  admin = await seedStaff(eventId, 'admin');
  speakerId = await seedContact(eventId, { email: 'speaker@example.com', first_name: 'Priya', last_name: 'Raman' });
  submissionId = await seedSubmission(eventId, {
    status: 'accepted',
    title: 'Taming 40-Minute CI',
    submitter_contact_id: speakerId,
  });
  uploadId = await seedUnstampedUpload();
});

describe('GET /app/api/files/library — session resolution', () => {
  it('resolves the uploader’s single accepted session when nothing stamped it', async () => {
    const row = (await library(`?event_id=${eventId}`)).find((r) => r.upload_id === uploadId);
    expect(row?.session_id).toBe(submissionId);
  });

  it('the per-submission Files tab finds the same file the library does', async () => {
    const rows = await library(`?submission_id=${submissionId}`);
    expect(rows.map((r) => r.upload_id)).toContain(uploadId);
  });

  it('refuses to guess when the speaker has two accepted sessions', async () => {
    await seedSubmission(eventId, {
      status: 'accepted',
      title: 'A second accepted talk',
      submitter_contact_id: speakerId,
    });
    const row = (await library(`?event_id=${eventId}`)).find((r) => r.upload_id === uploadId);
    expect(row?.session_id).toBeNull();
    expect(await library(`?submission_id=${submissionId}`)).toEqual([]);
  });

  it('ignores a session the speaker has not had accepted', async () => {
    const pending = await seedSubmission(eventId, { status: 'pending', submitter_contact_id: speakerId });
    const row = (await library(`?event_id=${eventId}`)).find((r) => r.upload_id === uploadId);
    // The accepted one still wins outright — a pending sibling is not a
    // second candidate, so this stays unambiguous.
    expect(row?.session_id).toBe(submissionId);
    expect(await library(`?submission_id=${pending}`)).toEqual([]);
  });
});

describe('PUT /app/api/files/uploads/:id/submission', () => {
  it('links an ambiguous file to the session the organiser picks, chain and all', async () => {
    const second = await seedSubmission(eventId, {
      status: 'accepted',
      title: 'A second accepted talk',
      submitter_contact_id: speakerId,
    });
    // Two candidates: the server no longer answers on its own.
    expect((await library(`?event_id=${eventId}`)).find((r) => r.upload_id === uploadId)?.session_id).toBeNull();

    const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${uploadId}/submission`, {
      ...jsonReq(admin.cookie, { submission_id: second }, 'PUT'),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, submission_id: second });

    expect((await library(`?event_id=${eventId}`)).find((r) => r.upload_id === uploadId)?.session_id).toBe(second);
    expect((await library(`?submission_id=${second}`)).map((r) => r.upload_id)).toContain(uploadId);

    // Every version of the chain moved, not just the current row — the
    // submission_id is part of the identity the version/comment counts group
    // on, so a half-moved chain would split one file's history in two.
    const rows = await env.DB.prepare(
      'SELECT DISTINCT submission_id FROM file_request_uploads WHERE contact_id = ?',
    ).bind(speakerId).all<{ submission_id: string | null }>();
    expect(rows.results.map((r) => r.submission_id)).toEqual([second]);
  });

  it('unlinks with null', async () => {
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${uploadId}/submission`, {
      ...jsonReq(admin.cookie, { submission_id: submissionId }, 'PUT'),
    });
    expect(res.status).toBe(200);
    const cleared = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${uploadId}/submission`, {
      ...jsonReq(admin.cookie, { submission_id: null }, 'PUT'),
    });
    expect(cleared.status).toBe(200);
    const stored = await env.DB.prepare('SELECT submission_id FROM file_request_uploads WHERE id = ?')
      .bind(uploadId)
      .first<{ submission_id: string | null }>();
    expect(stored?.submission_id).toBeNull();
  });

  it('refuses a session from another event', async () => {
    const otherEvent = await seedEvent();
    const foreign = await seedSubmission(otherEvent, { status: 'accepted' });
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${uploadId}/submission`, {
      ...jsonReq(admin.cookie, { submission_id: foreign }, 'PUT'),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_submission' });
  });

  it('refuses a reviewer seat', async () => {
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${uploadId}/submission`, {
      ...jsonReq(reviewer.cookie, { submission_id: submissionId }, 'PUT'),
    });
    expect(res.status).toBe(403);
  });
});
