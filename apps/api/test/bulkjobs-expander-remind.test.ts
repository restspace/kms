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
      `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'task_reminder' AND bulk_job_id = ?`,
    ).bind(jobId).first<{ n: number }>();
    expect(messages?.n).toBe(2);
  });

  // Regression for the defect the 2026-08-10 unhappy-path e2e run caught
  // (tests/e2e-unhappy-run-u08102133.md, M5.2/M5.3): every press of
  // "Remind all" snapshots a *new* bulk job, and the expander used to bake
  // that job id into the idempotency key as
  // `task_reminder:<contact>:<jobId>:<assignment>:vmanual-<day>`. Since the
  // job id was fresh each press, the UNIQUE key never collided and speakers
  // were re-reminded once per press — the per-day guarantee (NFR-11) existed
  // only in the `vmanual-<day>` suffix and was defeated by its neighbour.
  it('sends a given assignment at most one reminder per day, however many jobs are enqueued (NFR-11)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'twice@example.com' });
    const { assignId } = await seedOverdueAssignment(eventId, speaker);

    const firstJob = await seedRemindJob(eventId, [assignId]);
    await sweepBulkJobs(env, 50);
    const secondJob = await seedRemindJob(eventId, [assignId]);
    await sweepBulkJobs(env, 50);

    // One message for this assignment today, not one per job.
    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'task_reminder' AND contact_id = ?`,
    ).bind(speaker).first<{ n: number }>();
    expect(messages?.n).toBe(1);

    // The one message belongs to the job that actually sent it; the second
    // job reports its recipient as a suppressed duplicate rather than
    // reporting a bare "0 sent" that reads like a failure.
    const owner = await env.DB.prepare(
      `SELECT bulk_job_id FROM message_log WHERE template_key = 'task_reminder' AND contact_id = ?`,
    ).bind(speaker).first<{ bulk_job_id: string }>();
    expect(owner?.bulk_job_id).toBe(firstJob);

    const second = await env.DB.prepare('SELECT status, enqueued, skipped_duplicate FROM bulk_jobs WHERE id = ?')
      .bind(secondJob)
      .first<{ status: string; enqueued: number; skipped_duplicate: number }>();
    expect(second).toEqual({ status: 'done', enqueued: 1, skipped_duplicate: 1 });
  });

  // The key's day segment is the event's calendar day, not the worker's UTC
  // one (packages/core/src/time.ts). For an America/Los_Angeles event an
  // organiser pressing "Remind all" at 17:00 local is already on the next
  // UTC date, and a UTC-keyed guard would wave the duplicate through.
  it('keys the per-day guard to the event timezone, not UTC', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    await env.DB.prepare('UPDATE events SET timezone = ? WHERE id = ?').bind('America/Los_Angeles', eventId).run();
    const speaker = await createContact(eventId, { email: 'tz@example.com' });
    const { assignId } = await seedOverdueAssignment(eventId, speaker);

    const jobId = await seedRemindJob(eventId, [assignId]);
    await sweepBulkJobs(env, 50);

    const row = await env.DB.prepare(
      `SELECT idempotency_key FROM message_log WHERE template_key = 'task_reminder' AND contact_id = ?`,
    ).bind(speaker).first<{ idempotency_key: string }>();
    // No job id anywhere in the key, and the day is the event-local one.
    expect(row?.idempotency_key).not.toContain(jobId);
    const expectedDay = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    expect(row?.idempotency_key).toBe(`task_reminder:${speaker}:${assignId}:vmanual-${expectedDay}`);
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
      `SELECT COUNT(*) AS n FROM message_log WHERE template_key = 'task_reminder' AND bulk_job_id = ?`,
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

  // CNT-08 follow-up: the previous fix (frozen assignment_ids snapshot) made
  // `enqueued` reliably reach `total`, but every seeded overdue reminder then
  // reported "0 reminders sent" on the live demo. Root cause: the cron sweep
  // order in index.ts is sweepReminders -> sweepOutbox -> sweepBulkJobs, so
  // an outbox row *this* expander enqueues is invisible to *this* tick's
  // sweepOutbox — it would only be delivered (message_log flips to 'sent')
  // on the *next* minute's cron tick. But bulk_jobs.status already flips to
  // 'done' the moment `enqueued` reaches `total`, in the very same tick the
  // messages were only just queued. The dashboard's poll loop stops the
  // instant it sees 'done' and reports GET /bulk-jobs/:id's `sent` (counted
  // from message_log status = 'sent') right then — always 0, even though the
  // messages really did go out a few seconds later, invisibly to an admin
  // who'd already dismissed the banner. The fix (bulkJobs.ts's `deliverNow`)
  // delivers inline within expandRemindTasks, so this must be true after a
  // *single* sweepBulkJobs tick with no separate sweepOutbox call at all.
  it('delivers reminders inline so message_log is already sent by the time the job reports done (CNT-08)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const speaker1 = await createContact(eventId, { email: 'inline1@example.com' });
    const speaker2 = await createContact(eventId, { email: 'inline2@example.com' });
    const { assignId: a1 } = await seedOverdueAssignment(eventId, speaker1);
    const { assignId: a2 } = await seedOverdueAssignment(eventId, speaker2);
    const jobId = await seedRemindJob(eventId, [a1, a2]);

    await sweepBulkJobs(env, 50); // no sweepOutbox call — delivery must happen inline

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job).toEqual({ status: 'done', enqueued: 2, total: 2 });

    const sent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE template_key = 'task_reminder' AND status = 'sent' AND bulk_job_id = ?`,
    ).bind(jobId).first<{ n: number }>();
    expect(sent?.n).toBe(2);
  });

  // A snapshot id whose contact has no email (deleted contact, or a contact
  // record missing an address) used to be silently dropped by the expander's
  // inner JOIN contacts — indistinguishable from "no longer overdue" and
  // invisible in the completion banner. It must now be reported as a
  // countable skip, not folded into an unexplained "1 sent" with the other
  // id unaccounted for.
  it('reports assignments whose contact has no email as skipped_no_email instead of silently dropping them', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const speaker1 = await createContact(eventId, { email: 'has-email@example.com' });
    const speaker2 = await createContact(eventId, { email: 'placeholder@example.com' });
    await env.DB.prepare(`UPDATE contacts SET email = '' WHERE id = ?`).bind(speaker2).run();
    const { assignId: a1 } = await seedOverdueAssignment(eventId, speaker1);
    const { assignId: a2 } = await seedOverdueAssignment(eventId, speaker2);
    const jobId = await seedRemindJob(eventId, [a1, a2]);

    await sweepBulkJobs(env, 50);

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job).toEqual({ status: 'done', enqueued: 2, total: 2 });

    const sent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE status = 'sent' AND bulk_job_id = ?`,
    ).bind(jobId).first<{ n: number }>();
    expect(sent?.n).toBe(1);

    const adminId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
    await createEventUser(eventId, adminId, 'admin');
    const cookie = await sessionCookieFor({ contactId: adminId, eventId, eventSlug: eventId, role: 'admin' });
    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${jobId}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as { sent: number; skipped_no_email?: number };
    expect(polled.sent).toBe(1);
    expect(polled.skipped_no_email).toBe(1);
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

    // The route's waitUntil kick may hold the exclusive claim lease (0016), in
    // which case this sweep is a no-op — poll for the terminal state.
    await sweepBulkJobs(env, 50);
    for (let i = 0; i < 50; i++) {
      const row = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?')
        .bind(jobId)
        .first<{ status: string }>();
      if (row && row.status !== 'pending' && row.status !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${jobId}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as { status: string; enqueued: number; total: number };
    expect(polled.status).toBe('done');
    expect(polled.enqueued).toBe(2);
  });
});
