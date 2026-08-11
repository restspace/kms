// CFP defect (major): after "Send decisions" the admin toast read
//   "No decision emails were sent. 1 accepted, 1 declined"
// while the very same run stamped a Notified timestamp on the submission — so
// mail had in fact been queued and delivered. Two things combined:
//
//   1. expandSendDecisions (jobs/bulkJobs.ts) queued its messages but — alone
//      among the three expanders — never called deliverNow(). The message_log
//      rows it wrote were still status='queued' when the job flipped to
//      'done', waiting for the next tick's sweepOutbox.
//   2. GET /app/api/bulk-jobs/:id counts only status='sent' and
//      status='failed', so the poll that settled on 'done' read sent=0,
//      failed=0 — and describeSettledJob turns that into "No … were sent."
//
// Fixed on the API side, per the brief, rather than by rewording the client:
// decisions deliver inline like reminders and confirmations already do, and
// the poll additionally reports `queued` so a caller can always tell "nothing
// was ever queued" from "queued, delivery still in flight".

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

// The route kicks the expander via waitUntil, and the exclusive claim lease
// (migration 0016) makes a sweep called mid-kick a no-op — sweep for anything
// unclaimed, then wait for the job to reach a terminal state.
async function settleJob(jobId: string) {
  await sweepBulkJobs(env, 50);
  for (let i = 0; i < 50; i++) {
    const row = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string }>();
    if (row && row.status !== 'pending' && row.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bulk job ${jobId} never settled`);
}

async function staffSession(eventId: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  return sessionCookieFor({ contactId, eventId, eventSlug: eventId, role: 'admin' });
}

async function seedSubmission(eventId: string, submitterId: string | null, status: string): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, `Talk ${id.slice(-4)}`, status, submitterId, ts, ts).run();
  return id;
}

describe('send-decisions reports delivery truthfully', () => {
  it('the settled job accounts for every queued decision email, never "none sent"', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'speaker@example.com', first_name: 'Ada' });
    const other = await createContact(eventId, { email: 'other@example.com', first_name: 'Bo' });
    const accepted = await seedSubmission(eventId, speaker, 'accept_queue');
    const declined = await seedSubmission(eventId, other, 'decline_queue');

    const res = await SELF.fetch('https://example.com/app/api/submissions/send-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [accepted, declined] }),
    });
    const body = (await res.json()) as { job_id: string };
    expect(body.job_id).toBeTruthy();

    await settleJob(body.job_id);

    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as {
      status: string; sent: number; failed: number; queued: number;
    };
    expect(polled.status).toBe('done');
    // Two messages exist and every one of them is accounted for. The bug was
    // sent=0/failed=0 with two rows sitting in message_log.
    expect(polled.sent + polled.failed + polled.queued).toBe(2);
    // …and the "nothing to report" state the toast keys off is not reached.
    expect(polled.sent === 0 && polled.failed === 0 && polled.queued === 0).toBe(false);

    // The submissions that carry a Notified stamp are exactly the ones with a
    // message in the log — the contradiction the organiser saw is impossible.
    const notified = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE id IN (?, ?) AND notified_at IS NOT NULL',
    )
      .bind(accepted, declined)
      .first<{ n: number }>();
    const logged = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log WHERE bulk_job_id = ?`,
    )
      .bind(body.job_id)
      .first<{ n: number }>();
    expect(notified?.n).toBe(logged?.n);
  });

  it('a job that genuinely queued nothing still reports all-zero, so "none sent" stays available', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    // No submitter contact at all: flipped, but nothing can be mailed.
    const orphan = await seedSubmission(eventId, null, 'accept_queue');

    const res = await SELF.fetch('https://example.com/app/api/submissions/send-decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ ids: [orphan] }),
    });
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as { sent: number; failed: number; queued: number };
    expect(polled.sent).toBe(0);
    expect(polled.failed).toBe(0);
    expect(polled.queued).toBe(0);
  });
});
