// CNT-08 regression: the dashboard "Remind all (N)" bulk task-reminder job
// (jobs/bulkJobs.ts expandRemindTasks) used to re-derive its "currently
// overdue" candidate set from a live query on every tick, sliced by the
// `enqueued` cursor. If even one of the targeted assignments stopped
// matching between job creation and the cron tick that expands it (marked
// complete, task re-scheduled, etc.), the live-requeried set shrank below
// the job's frozen `total` and `enqueued` could never catch up — the job sat
// in 'running' with `enqueued` stuck below `total` forever, which is exactly
// what the live-demo eval saw as "Sending reminders… 0/2 queued" that never
// advanced or completed, with no task_reminder message ever created.
//
// The fix pages through the *frozen* `assignment_ids` snapshot (the same
// pattern expandSendConfirmations/expandCompose already use for
// session_ids/contact_ids) so `enqueued` is guaranteed to reach `total` in a
// bounded number of ticks regardless of what happens to the underlying rows
// meanwhile — a slice entry that no longer qualifies is simply skipped, not
// silently made unreachable.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';
const past = '2026-01-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

async function seedOverdueAssignment(eventId: string, contactId: string): Promise<{ taskId: string; assignId: string }> {
  const taskId = `task-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tasks (id, event_id, title, due_at, created_at) VALUES (?, ?, 'Submit slides', ?, ?)`,
  ).bind(taskId, eventId, past, ts).run();
  const assignId = `ta-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, 'not_started')`,
  ).bind(assignId, taskId, contactId).run();
  return { taskId, assignId };
}

async function seedRemindJob(eventId: string, assignmentIds: string[]): Promise<string> {
  const jobId = `job-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
     VALUES (?, ?, 'remind-tasks', 'pending', ?, ?, 0, 'tester', ?, ?)`,
  ).bind(jobId, eventId, JSON.stringify({ assignment_ids: assignmentIds, requested_at: ts }), assignmentIds.length, ts, ts).run();
  return jobId;
}

describe('sweepBulkJobs / remind-tasks', () => {
  it('reaches done and queues a task_reminder message per still-overdue target', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const speaker1 = await createContact(eventId, { email: 'remind1@example.com' });
    const speaker2 = await createContact(eventId, { email: 'remind2@example.com' });
    const { assignId: a1 } = await seedOverdueAssignment(eventId, speaker1);
    const { assignId: a2 } = await seedOverdueAssignment(eventId, speaker2);
    const jobId = await seedRemindJob(eventId, [a1, a2]);

    await sweepBulkJobs(env, 50);

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job).toEqual({ status: 'done', enqueued: 2, total: 2 });

    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'task_reminder' AND idempotency_key LIKE '%:' || ? || ':%'`,
    ).bind(jobId).first<{ n: number }>();
    expect(messages?.n).toBe(2);
  });

  it('never hangs when a targeted assignment stops being overdue before the sweep runs (CNT-08)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const speaker1 = await createContact(eventId, { email: 'race1@example.com' });
    const speaker2 = await createContact(eventId, { email: 'race2@example.com' });
    const { assignId: a1 } = await seedOverdueAssignment(eventId, speaker1);
    const { assignId: a2 } = await seedOverdueAssignment(eventId, speaker2);
    const jobId = await seedRemindJob(eventId, [a1, a2]);

    // Both targets are completed (e.g. the speaker acted, or another admin
    // action closed them out) after the job snapshot was taken but before
    // the cron tick expands it — this used to be exactly the condition that
    // left `enqueued` stuck below `total` forever.
    await env.DB.prepare(`UPDATE task_assignments SET status = 'complete' WHERE id IN (?, ?)`).bind(a1, a2).run();

    await sweepBulkJobs(env, 50);
    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    // The job still finishes even though neither target sent a reminder.
    expect(job).toEqual({ status: 'done', enqueued: 2, total: 2 });

    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'task_reminder' AND idempotency_key LIKE '%:' || ? || ':%'`,
    ).bind(jobId).first<{ n: number }>();
    expect(messages?.n).toBe(0);
  });

  it('a job with zero targets finishes immediately instead of hanging', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const jobId = await seedRemindJob(eventId, []);

    await sweepBulkJobs(env, 50);
    const job = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
    expect(job?.status).toBe('done');
  });

  it('end to end: POST /app/api/dashboard/remind → sweep → GET /app/api/bulk-jobs/:id reports progress and completion', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const adminId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminId, 'admin');
    const cookie = await sessionCookieFor({ contactId: adminId, eventId, eventSlug: eventId, role: 'admin' });
    const speaker1 = await createContact(eventId, { email: 'e2e1@example.com' });
    const speaker2 = await createContact(eventId, { email: 'e2e2@example.com' });
    await seedOverdueAssignment(eventId, speaker1);
    await seedOverdueAssignment(eventId, speaker2);

    const res = await SELF.fetch('https://example.com/app/api/dashboard/remind', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(202);
    const { job_id: jobId, total } = (await res.json()) as { job_id: string; total: number };
    expect(total).toBe(2);

    await sweepBulkJobs(env, 50);

    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${jobId}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as { status: string; enqueued: number; total: number };
    expect(polled.status).toBe('done');
    expect(polled.enqueued).toBe(2);
  });
});
