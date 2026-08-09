// FR-PORTAL-8: a task backed by a File Request uploads under that request's
// allowed_types / max_size_mb, not the generic portal defaults — and the
// portal copy states the effective policy instead of a hardcoded "max 20 MB".

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { createFileRequest, createTaskAssignment, fileFrom, pdfBytes, pngBytes } from './fixtures-portal';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let contactId: string;
let cookie: string;

beforeEach(async () => {
  slug = `up-${crypto.randomUUID().slice(0, 8)}`;
  eventId = await createEvent({ slug });
  contactId = await createContact(eventId, { email: 'speaker@example.com' });
  cookie = await sessionCookieFor({ contactId, eventId, eventSlug: slug, role: 'speaker' });
});

async function upload(assignmentId: string, file: File): Promise<Response> {
  const form = new FormData();
  form.set('upload', file);
  return SELF.fetch(`${ORIGIN}/portal/${slug}/tasks/${assignmentId}/complete`, {
    method: 'POST',
    headers: { cookie },
    body: form,
    redirect: 'manual',
  });
}

const isComplete = async (assignmentId: string): Promise<boolean> => {
  const row = await env.DB.prepare('SELECT status FROM task_assignments WHERE id = ?')
    .bind(assignmentId)
    .first<{ status: string }>();
  return row?.status === 'complete';
};

describe('portal task uploads', () => {
  it('rejects a type the file request does not allow, even though the generic list would', async () => {
    const requestId = await createFileRequest(eventId, { allowedTypes: ['application/pdf'] });
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: requestId });

    const res = await upload(assignmentId, fileFrom(pngBytes(), 'shot.png', 'image/png'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('is not accepted');
    expect(await isComplete(assignmentId)).toBe(false);
  });

  it('accepts the type the file request does allow', async () => {
    const requestId = await createFileRequest(eventId, { allowedTypes: ['application/pdf'] });
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: requestId });

    const res = await upload(assignmentId, fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'));
    expect(res.status).toBe(302);
    expect(await isComplete(assignmentId)).toBe(true);

    const upload_ = await env.DB.prepare('SELECT COUNT(*) AS n FROM file_request_uploads WHERE file_request_id = ?')
      .bind(requestId)
      .first<{ n: number }>();
    expect(upload_?.n).toBe(1);
  });

  it('enforces the file request size limit below the generic 20 MB cap', async () => {
    const requestId = await createFileRequest(eventId, { allowedTypes: ['application/pdf'], maxSizeMb: 1 });
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: requestId });

    const res = await upload(assignmentId, fileFrom(pdfBytes(2 * 1024 * 1024), 'big.pdf', 'application/pdf'));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('too large (max 1 MB)');
    expect(await isComplete(assignmentId)).toBe(false);
  });

  it('falls back to the generic policy when the request sets none', async () => {
    const requestId = await createFileRequest(eventId, { allowedTypes: null, maxSizeMb: null });
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: requestId });

    const res = await upload(assignmentId, fileFrom(pngBytes(), 'shot.png', 'image/png'));
    expect(res.status).toBe(302);
    expect(await isComplete(assignmentId)).toBe(true);
  });

  it('falls back to the generic policy when the task has no file request', async () => {
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: null });
    const res = await upload(assignmentId, fileFrom(pngBytes(), 'shot.png', 'image/png'));
    expect(res.status).toBe(302);
    expect(await isComplete(assignmentId)).toBe(true);
  });

  it('renders the effective policy instead of a hardcoded 20 MB', async () => {
    const requestId = await createFileRequest(eventId, { allowedTypes: ['application/pdf'], maxSizeMb: 3 });
    await createTaskAssignment(eventId, contactId, { fileRequestId: requestId });

    const res = await SELF.fetch(`${ORIGIN}/portal/${slug}/tasks`, { headers: { cookie } });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('max 3 MB');
    expect(html).not.toContain('max 20 MB');
    expect(html).toContain('PDF');
  });
});
