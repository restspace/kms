// File version chains + cross-role comments (lane W2-C).
//
// Covers the rubric scenario end to end: a speaker uploads slides.pdf, comments
// on it, re-uploads a second version; the organiser sees both versions with
// timestamps, the latest flagged current, the superseded one still downloadable,
// the speaker's comment on the thread, and can reply to it.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import {
  createFileRequest,
  createSubmission,
  createTaskAssignment,
  fileFrom,
  pdfBytes,
} from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let speakerId: string;
let speakerCookie: string;
let adminCookie: string;
let requestId: string;
let submissionId: string;
let assignmentId: string;

beforeEach(async () => {
  slug = `fv-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  speakerId = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Sam', last_name: 'Speaker' });
  speakerCookie = await sessionCookieFor({ contactId: speakerId, eventId, eventSlug: slug, role: 'speaker' });

  const adminId = await createContact(eventId, { email: 'org@example.com', first_name: 'Olive', last_name: 'Organiser' });
  await createEventUser(eventId, adminId, 'admin');
  adminCookie = await sessionCookieFor({
    contactId: adminId,
    eventId,
    eventSlug: slug,
    email: 'org@example.com',
    role: 'admin',
  });

  requestId = await createFileRequest(eventId, { allowedTypes: ['application/pdf'], title: 'Slides' });
  submissionId = await createSubmission(eventId, { submitterContactId: speakerId });
  assignmentId = await createTaskAssignment(eventId, speakerId, {
    actionType: 'file_upload',
    fileRequestId: requestId,
    submissionId,
  });
});

const upload = (name: string, size = 64): Promise<Response> => {
  const form = new FormData();
  form.set('upload', fileFrom(pdfBytes(size), name, 'application/pdf'));
  return SELF.fetch(`${ORIGIN}/portal/${slug}/tasks/${assignmentId}/complete`, {
    method: 'POST',
    headers: { cookie: speakerCookie },
    body: form,
    redirect: 'manual',
  });
};

const tasksPage = async (): Promise<string> => {
  const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/tasks`, { headers: { cookie: speakerCookie } });
  expect(res.status).toBe(200);
  return res.text();
};

const chainRows = () =>
  env.DB.prepare(
    'SELECT id, file_asset_id, version, is_current FROM file_request_uploads WHERE file_request_id = ? ORDER BY version',
  )
    .bind(requestId)
    .all<{ id: string; file_asset_id: string; version: number; is_current: number }>();

const adminGet = (path: string) => SELF.fetch(`${ORIGIN}/app/api/files${path}`, { headers: { cookie: adminCookie } });

describe('migration 0007', () => {
  it('stamps version/is_current on new upload rows', async () => {
    await upload('slides.pdf');
    const { results } = await chainRows();
    expect(results).toHaveLength(1);
    expect(results[0]?.version).toBe(1);
    expect(results[0]?.is_current).toBe(1);
  });

  it('backfills rows written without the new columns as version 1, current', async () => {
    // Mirrors a pre-0007 row: the INSERT names no version/is_current.
    const assetId = `asset-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
       VALUES (?, ?, ?, 'legacy.pdf', 'application/pdf', 10, ?, '2026-01-01T00:00:00Z')`,
    )
      .bind(assetId, eventId, `file:${assetId}`, speakerId)
      .run();
    await env.DB.prepare(
      `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at)
       VALUES (?, ?, ?, NULL, ?, '2026-01-01T00:00:00Z')`,
    )
      .bind(`fru-${crypto.randomUUID()}`, requestId, speakerId, assetId)
      .run();
    const row = await env.DB.prepare('SELECT version, is_current FROM file_request_uploads WHERE file_asset_id = ?')
      .bind(assetId)
      .first<{ version: number; is_current: number }>();
    expect(row).toEqual({ version: 1, is_current: 1 });
  });
});

describe('speaker re-upload', () => {
  it('keeps the upload control on a completed task and appends a version', async () => {
    expect((await upload('slides.pdf')).status).toBe(302);

    const afterFirst = await tasksPage();
    expect(afterFirst).toContain('slides.pdf');
    expect(afterFirst).toContain('Upload a new version');

    expect((await upload('slides-v2.pdf', 128)).status).toBe(302);

    const { results } = await chainRows();
    expect(results.map((r) => [r.version, r.is_current])).toEqual([
      [1, 0],
      [2, 1],
    ]);

    const page = await tasksPage();
    expect(page).toContain('slides.pdf');
    expect(page).toContain('slides-v2.pdf');
    expect(page).toContain('v2 · Current');
    expect(page).toContain('2 versions');
    // Every version is individually downloadable.
    for (const row of results) expect(page).toContain(`/files/${row.file_asset_id}`);
  }, 30_000);

  it('records the first completion time, not the re-upload time', async () => {
    await upload('slides.pdf');
    const first = await env.DB.prepare('SELECT completed_at FROM task_assignments WHERE id = ?')
      .bind(assignmentId)
      .first<{ completed_at: string }>();
    await upload('slides-v2.pdf');
    const after = await env.DB.prepare('SELECT completed_at, status, response_id FROM task_assignments WHERE id = ?')
      .bind(assignmentId)
      .first<{ completed_at: string; status: string; response_id: string }>();
    expect(after?.completed_at).toBe(first?.completed_at);
    expect(after?.status).toBe('complete');
    const { results } = await chainRows();
    // response_id follows the newest bytes.
    expect(after?.response_id).toBe(results[1]?.file_asset_id);
  });
});

describe('resolveFileAccess and superseded versions', () => {
  it('still serves a superseded version to the speaker who uploaded it', async () => {
    await upload('slides.pdf');
    await upload('slides-v2.pdf');
    const { results } = await chainRows();
    for (const row of results) {
      const res = await SELF.fetch(`${ORIGIN}/files/${row.file_asset_id}`, { headers: { cookie: speakerCookie } });
      expect(res.status).toBe(200);
    }
  });

  it('does not leak a superseded version to another speaker', async () => {
    await upload('slides.pdf');
    await upload('slides-v2.pdf');
    const otherId = await createContact(eventId, { email: 'other@example.com' });
    const otherCookie = await sessionCookieFor({ contactId: otherId, eventId, eventSlug: slug, role: 'speaker' });
    const { results } = await chainRows();
    for (const row of results) {
      const res = await SELF.fetch(`${ORIGIN}/files/${row.file_asset_id}`, { headers: { cookie: otherCookie } });
      expect(res.status).toBe(404);
    }
  });
});

describe('cross-role comment thread', () => {
  it('carries a v1 comment into the thread after v2 lands, and lets an organiser reply', async () => {
    await upload('slides.pdf');
    const before = await chainRows();
    const v1 = before.results[0]!;

    // Speaker comments on v1 from the portal.
    const body = new FormData();
    body.set('comment', 'Draft deck - final version coming Friday.');
    const posted = await SELF.fetch(`${ORIGIN}/portal/${slug}/files/${v1.id}/comments`, {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body,
      redirect: 'manual',
    });
    expect(posted.status).toBe(302);

    await upload('slides-v2.pdf');
    const after = await chainRows();
    const v2 = after.results[1]!;

    // Organiser sees the whole chain and the v1 comment on the same thread.
    const chainRes = await adminGet(`/chains/${v2.id}`);
    expect(chainRes.status).toBe(200);
    const chain = (await chainRes.json()) as {
      versions: Array<{ version: number; is_current: number; filename: string; uploaded_at: string }>;
      comments: Array<{ body: string; author_name: string; author_role: string; version: number; created_at: string }>;
    };
    expect(chain.versions.map((v) => v.version)).toEqual([1, 2]);
    expect(chain.versions.find((v) => v.is_current === 1)?.filename).toBe('slides-v2.pdf');
    expect(chain.versions.every((v) => typeof v.uploaded_at === 'string' && v.uploaded_at.length > 0)).toBe(true);
    expect(chain.comments).toHaveLength(1);
    expect(chain.comments[0]?.body).toBe('Draft deck - final version coming Friday.');
    expect(chain.comments[0]?.author_name).toBe('Sam Speaker');
    expect(chain.comments[0]?.author_role).toBe('speaker');
    expect(chain.comments[0]?.version).toBe(1);

    // Organiser replies on the current version; both comments share one thread.
    const reply = await SELF.fetch(`${ORIGIN}/app/api/files/uploads/${v2.id}/comments`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'Thanks — we will review Monday.' }),
    });
    expect(reply.status).toBe(200);
    const replyBody = (await reply.json()) as { comments: Array<{ body: string; author_role: string }> };
    expect(replyBody.comments.map((m) => m.author_role)).toEqual(['speaker', 'admin']);

    // …and the speaker sees the organiser's reply in the portal.
    const page = await tasksPage();
    expect(page).toContain('Draft deck - final version coming Friday.');
    expect(page).toContain('Thanks — we will review Monday.');
    expect(page).toContain('Olive Organiser');
  }, 30_000);

  it('rejects an empty comment and a comment on someone else’s upload', async () => {
    await upload('slides.pdf');
    const { results } = await chainRows();
    const uploadId = results[0]!.id;

    const empty = new FormData();
    empty.set('comment', '   ');
    const emptyRes = await SELF.fetch(`${ORIGIN}/portal/${slug}/files/${uploadId}/comments`, {
      method: 'POST',
      headers: { cookie: speakerCookie },
      body: empty,
      redirect: 'manual',
    });
    expect(emptyRes.headers.get('location')).toContain('Write%20a%20comment');

    const otherId = await createContact(eventId, { email: 'other@example.com' });
    const otherCookie = await sessionCookieFor({ contactId: otherId, eventId, eventSlug: slug, role: 'speaker' });
    const body = new FormData();
    body.set('comment', 'not mine');
    const foreign = await SELF.fetch(`${ORIGIN}/portal/${slug}/files/${uploadId}/comments`, {
      method: 'POST',
      headers: { cookie: otherCookie },
      body,
      redirect: 'manual',
    });
    expect(foreign.headers.get('location')).toContain('File%20not%20found');
    // Storage is shared across a test file, so scope the count to this upload.
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM file_comments WHERE file_request_upload_id = ?')
      .bind(uploadId)
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });
});

describe('organiser file surfaces', () => {
  it('exposes the uploaded file behind a completed task assignment', async () => {
    await upload('slides.pdf');
    await upload('slides-v2.pdf');
    const res = await adminGet(`/task-assignments/${assignmentId}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { versions: Array<{ version: number; file_asset_id: string }> };
    expect(payload.versions).toHaveLength(2);
    const { results } = await chainRows();
    expect(payload.versions.map((v) => v.file_asset_id).sort()).toEqual(
      results.map((r) => r.file_asset_id).sort(),
    );
  });

  it('lists submission-scoped uploads with filename, size, uploader and version count', async () => {
    await upload('slides.pdf');
    await upload('slides-v2.pdf', 256);
    const res = await adminGet(`/library?submission_id=${submissionId}`);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      total: number;
      items: Array<{
        filename: string;
        size_bytes: number;
        uploader_name: string;
        version_count: number;
        comment_count: number;
        submission_id: string;
      }>;
    };
    // One row per chain — the current version, not one row per upload.
    expect(payload.items).toHaveLength(1);
    expect(payload.total).toBe(1);
    const row = payload.items[0]!;
    expect(row.filename).toBe('slides-v2.pdf');
    expect(row.version_count).toBe(2);
    expect(row.comment_count).toBe(0);
    expect(row.uploader_name).toBe('Sam Speaker');
    expect(row.size_bytes).toBeGreaterThan(0);
    expect(row.submission_id).toBe(submissionId);
  });

  it('keeps the library out of reach of a speaker session', async () => {
    await upload('slides.pdf');
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/library`, { headers: { cookie: speakerCookie } });
    expect([401, 403]).toContain(res.status);
  });
});
