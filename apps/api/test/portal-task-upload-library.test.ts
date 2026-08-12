// Eval defect (files/deliverables): a portal upload against a *bare*
// file_upload task (no file_requests row) used to write only a file_assets row
// plus task_assignments.response_id — invisible to the Files library, which
// reads file_request_uploads. slides.pdf uploaded twice through the portal was
// absent from Workspace > Files entirely. portal.ts now ensures a standing
// per-task file request (`file-request-task-<taskId>`) and appends each upload
// as a version in the speaker's chain, so organisers always have a central
// record with the full version history.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { createContact, createEvent, sessionCookieFor } from './fixtures';
import { createTaskAssignment, fileFrom, pdfBytes } from './fixtures-portal';
import { seedStaff } from './fixtures-admin';

const ORIGIN = 'https://kms.test';

let eventId: string;
let slug: string;
let contactId: string;
let cookie: string;

beforeEach(async () => {
  slug = `lib-${crypto.randomUUID().slice(0, 8)}`;
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

describe('portal uploads on tasks without a file request', () => {
  it('registers each upload as a version chain that the Files library lists', async () => {
    const assignmentId = await createTaskAssignment(eventId, contactId, {
      fileRequestId: null,
      title: 'Send us your presentation',
    });
    const taskId = (
      await env.DB.prepare('SELECT task_id FROM task_assignments WHERE id = ?')
        .bind(assignmentId)
        .first<{ task_id: string }>()
    )?.task_id;
    expect(taskId).toBeTruthy();

    const first = await upload(assignmentId, fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'));
    expect(first.status).toBe(302);
    const second = await upload(assignmentId, fileFrom(pdfBytes(), 'slides.pdf', 'application/pdf'));
    expect(second.status).toBe(302);

    // Both uploads sit in one chain under the standing per-task request.
    const chainRequestId = `file-request-task-${taskId}`;
    const { results: rows } = await env.DB.prepare(
      `SELECT version, is_current FROM file_request_uploads
       WHERE file_request_id = ? AND contact_id = ? ORDER BY version`,
    )
      .bind(chainRequestId, contactId)
      .all<{ version: number; is_current: number }>();
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
    expect(rows.map((r) => r.is_current)).toEqual([0, 1]);

    // And the organiser Files library shows the chain: one row, two versions.
    const admin = await seedStaff(eventId, 'admin');
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/library?event_id=${eventId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ filename: string; version: number; version_count: number; request_title: string | null }>;
    };
    const row = body.items.find((i) => i.filename === 'slides.pdf');
    expect(row).toBeTruthy();
    expect(row?.version).toBe(2);
    expect(row?.version_count).toBe(2);
    expect(row?.request_title).toBe('Send us your presentation');
  });

  it('the Tasks tab chain endpoint resolves the synthetic per-task chain', async () => {
    const assignmentId = await createTaskAssignment(eventId, contactId, { fileRequestId: null });
    await upload(assignmentId, fileFrom(pdfBytes(), 'deck.pdf', 'application/pdf'));
    await upload(assignmentId, fileFrom(pdfBytes(), 'deck-v2.pdf', 'application/pdf'));

    const admin = await seedStaff(eventId, 'admin');
    const res = await SELF.fetch(`${ORIGIN}/app/api/files/task-assignments/${assignmentId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: Array<{ filename: string; version: number; upload_id: string }> };
    expect(body.versions).toHaveLength(2);
    expect(body.versions[1].filename).toBe('deck-v2.pdf');
    // Real upload rows (not the response_id chain-of-one fallback), so
    // comments can attach.
    expect(body.versions.every((v) => v.upload_id !== '')).toBe(true);
  });
});
