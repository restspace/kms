// #9 (eval defect): a speaker uploaded slides.pdf against a session-linked
// task, but the session's Files section said "No files uploaded" and the
// library had no way to see which session a file belonged to.
//
// file_request_uploads.submission_id is stamped from
// task_assignments.submission_id at upload time (portal.ts) — which is only
// ever set when the *task* itself was targeted at the submission
// (target='submission'). A task assigned directly to a contact
// (adminApi.ts's expandTaskTargets, via soleSubmissionByContact) still
// carries the right task_assignments.submission_id when the contact is on
// exactly one submission, but older data (or any path that leaves
// u.submission_id unstamped) can end up with an upload whose row has no
// submission_id even though the task assignment it came from plainly does.
//
// GET /app/api/files/library now falls back to resolving the session via the
// task_assignment chain identity (file_request_id + contact_id) when
// u.submission_id itself is NULL, so both the submission's Files panel
// (?submission_id=) and the library's Session column find these uploads.

import { env, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedStaff, seedSubmission, seedTask } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

let eventId: string;
let admin: { contactId: string; cookie: string; email: string };
let speakerId: string;
let submissionId: string;

beforeEach(async () => {
  eventId = await seedEvent();
  admin = await seedStaff(eventId, 'admin');
  speakerId = await seedContact(eventId, { email: 'speaker@example.com', first_name: 'Priya', last_name: 'Raman' });
  submissionId = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speakerId });
});

/** A file_upload task assigned directly to a contact (not target='submission'),
 * whose single task_assignment nonetheless carries the resolved submission_id
 * — the shape expandTaskTargets produces for an unambiguous contact target. */
async function seedContactTargetedUploadTask(): Promise<{ taskId: string; assignmentId: string }> {
  const taskId = await seedTask(eventId, { title: 'Upload your slides', action_type: 'file_upload' });
  const assignmentId = `ta-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status) VALUES (?, ?, ?, ?, 'not_started')`,
  ).bind(assignmentId, taskId, speakerId, submissionId).run();
  return { taskId, assignmentId };
}

/** A file_request_uploads row that landed in the standing per-task request
 * chain with submission_id left NULL — the exact "not associated with
 * sessions" shape #9 described. */
async function seedUploadWithNullSubmissionId(taskId: string, filename: string): Promise<string> {
  const fileRequestId = `file-request-task-${taskId}`;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Task upload', 'contacts', ?)`,
  ).bind(fileRequestId, eventId, ts).run();
  const assetId = `fa-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
     VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, ?)`,
  ).bind(assetId, eventId, `k/${assetId}`, filename, speakerId, ts).run();
  const uploadId = `u-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, version, is_current)
     VALUES (?, ?, ?, NULL, ?, ?, 1, 1)`,
  ).bind(uploadId, fileRequestId, speakerId, assetId, ts).run();
  return uploadId;
}

describe('GET /app/api/files/library — session linkage fallback (#9)', () => {
  it('finds an upload whose row has no submission_id via its task assignment', async () => {
    const { taskId } = await seedContactTargetedUploadTask();
    await seedUploadWithNullSubmissionId(taskId, 'slides.pdf');

    const res = await SELF.fetch(`https://kms.test/app/api/files/library?submission_id=${submissionId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ filename: string; session_id: string | null; session_code: string | null }>;
      total: number;
    };
    const row = body.items.find((i) => i.filename === 'slides.pdf');
    expect(row).toBeTruthy();
    expect(row?.session_id).toBe(submissionId);
  });

  it('does not surface the fallback-matched upload for an unrelated submission', async () => {
    const { taskId } = await seedContactTargetedUploadTask();
    await seedUploadWithNullSubmissionId(taskId, 'slides.pdf');
    const otherSubmissionId = await seedSubmission(eventId, { status: 'accepted' });

    const res = await SELF.fetch(`https://kms.test/app/api/files/library?submission_id=${otherSubmissionId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as { items: Array<{ filename: string }> };
    expect(body.items.find((i) => i.filename === 'slides.pdf')).toBeUndefined();
  });

  it('resolves session_id/session_code/session_title on the unfiltered library listing too', async () => {
    const { taskId } = await seedContactTargetedUploadTask();
    await seedUploadWithNullSubmissionId(taskId, 'slides.pdf');

    const res = await SELF.fetch(`https://kms.test/app/api/files/library?event_id=${eventId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as {
      items: Array<{ filename: string; session_id: string | null; session_code: string | null; session_title: string | null }>;
    };
    const row = body.items.find((i) => i.filename === 'slides.pdf');
    expect(row?.session_id).toBe(submissionId);
    expect(row?.session_code).toBeTruthy();
    expect(row?.session_title).toBe('A talk');
  });

  it('a normal submission-targeted upload (u.submission_id already set) is unaffected', async () => {
    const taskId = await seedTask(eventId, { title: 'Upload your slides', action_type: 'file_upload' });
    const assignmentId = `ta-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status) VALUES (?, ?, ?, ?, 'not_started')`,
    ).bind(assignmentId, taskId, speakerId, submissionId).run();
    const fileRequestId = `file-request-task-${taskId}`;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO file_requests (id, event_id, title, type, created_at) VALUES (?, ?, 'Task upload', 'contacts', ?)`,
    ).bind(fileRequestId, eventId, ts).run();
    const assetId = `fa-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO file_assets (id, event_id, key, filename, content_type, size_bytes, uploaded_by_contact_id, created_at)
       VALUES (?, ?, ?, ?, 'application/pdf', 2048, ?, ?)`,
    ).bind(assetId, eventId, `k/${assetId}`, 'deck.pdf', speakerId, ts).run();
    const uploadId = `u-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO file_request_uploads (id, file_request_id, contact_id, submission_id, file_asset_id, uploaded_at, version, is_current)
       VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
    ).bind(uploadId, fileRequestId, speakerId, submissionId, assetId, ts).run();

    const res = await SELF.fetch(`https://kms.test/app/api/files/library?submission_id=${submissionId}`, {
      headers: { cookie: admin.cookie, accept: 'application/json' },
    });
    const body = (await res.json()) as { items: Array<{ filename: string; session_id: string | null }> };
    const row = body.items.find((i) => i.filename === 'deck.pdf');
    expect(row?.session_id).toBe(submissionId);
  });

  it('a free-text search on the session code/title finds the file (library Session filter)', async () => {
    const { taskId } = await seedContactTargetedUploadTask();
    await seedUploadWithNullSubmissionId(taskId, 'slides.pdf');
    const subRow = await env.DB.prepare('SELECT code FROM submissions WHERE id = ?').bind(submissionId).first<{ code: string }>();

    const res = await SELF.fetch(
      `https://kms.test/app/api/files/library?event_id=${eventId}&q=${encodeURIComponent(subRow!.code)}`,
      { headers: { cookie: admin.cookie, accept: 'application/json' } },
    );
    const body = (await res.json()) as { items: Array<{ filename: string }>; total: number };
    expect(body.items.find((i) => i.filename === 'slides.pdf')).toBeTruthy();
  });
});
