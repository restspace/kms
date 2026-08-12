// CFP-14 regression: the bulk "Send decision emails" action reported "No
// decision emails were sent" for admin-created submissions with no submitter
// contact, yet the app still stamped a "Notified" checkmark and "Notified
// <date>" on them. Root cause: expandSendDecisions (jobs/bulkJobs.ts)
// stamped `notified_at` unconditionally in the same UPDATE that flips
// accept_queue/decline_queue -> accepted/declined, regardless of whether a
// submitter existed to email.
//
// Fixed behaviour under test:
//  (a) a submission WITH a submitter contact gets the acceptance/decline
//      template email and notified_at is set.
//  (b) a submission with NO submitter is flipped (still "accepted"/
//      "declined" as a decision) but is never stamped notified_at, and
//      POST /submissions/send-decisions + GET /bulk-jobs/:id report it as
//      skipped so the UI can say "1 sent, 1 skipped (no submitter)".
//  (c) notified_at is only ever set after a successful queue/send.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

// The send-decisions route now kicks the expander itself via waitUntil (the
// dead-minute fix), so the job may be mid-expansion in the background when
// the response lands. Sweep for anything still pending, then wait for the
// job row to reach a terminal state before asserting.
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
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: eventId, role: 'admin' });
  return cookie;
}

async function seedSubmission(eventId: string, submitterId: string | null, status: string): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, `Talk ${id.slice(-4)}`, status, submitterId, ts, ts).run();
  return id;
}

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

describe('POST /app/api/submissions/send-decisions — notified_at only on successful send (CFP-14)', () => {
  it('sends emails and stamps notified_at only for submissions with a submitter contact', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'has-submitter@example.com', first_name: 'Ada' });
    const withSubmitter = await seedSubmission(eventId, speaker, 'accept_queue');
    const withoutSubmitter = await seedSubmission(eventId, null, 'decline_queue');

    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/send-decisions',
      post(cookie, { ids: [withSubmitter, withoutSubmitter] }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: number; declined: number; skipped_no_submitter: number; job_id: string;
    };
    // Upfront: the endpoint already knows one of the two queued submissions
    // has no submitter to notify, before the job has even been expanded.
    expect(body.accepted).toBe(1);
    expect(body.declined).toBe(1);
    expect(body.skipped_no_submitter).toBe(1);

    await settleJob(body.job_id);

    const rows = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(withSubmitter, withoutSubmitter)
      .all<{ id: string; status: string; notified_at: string | null }>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.id, r]));

    // Both are still decided...
    expect(byId[withSubmitter].status).toBe('accepted');
    expect(byId[withoutSubmitter].status).toBe('declined');
    // ...but only the one with a submitter was actually notified.
    expect(byId[withSubmitter].notified_at).not.toBeNull();
    expect(byId[withoutSubmitter].notified_at).toBeNull();

    const messages = await env.DB.prepare(
      `SELECT template_key, to_email FROM message_log WHERE bulk_job_id = ?`,
    ).bind(body.job_id).all<{ template_key: string; to_email: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]).toMatchObject({ template_key: 'decision_accepted', to_email: 'has-submitter@example.com' });

    // GET /bulk-jobs/:id confirms the same skip after expansion, backward
    // compatible (existing fields untouched, skipped_no_submitter additive).
    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie } });
    const polled = (await pollRes.json()) as { status: string; enqueued: number; total: number; skipped_no_submitter: number };
    expect(polled.status).toBe('done');
    expect(polled.enqueued).toBe(2); // both decisions were processed...
    expect(polled.skipped_no_submitter).toBe(1); // ...but only one was notified.
  });

  it('a submission with a submitter but no email on the contact is also skipped, not notified', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    // A contact row with a blank email — same shape an admin-created record
    // with no submitter would eventually resolve to via the LEFT JOIN.
    const blankEmailContact = await createContact(eventId, { email: '' });
    const submissionId = await seedSubmission(eventId, blankEmailContact, 'accept_queue');

    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/send-decisions',
      post(cookie, { ids: [submissionId] }),
    );
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const row = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id = ?')
      .bind(submissionId)
      .first<{ status: string; notified_at: string | null }>();
    expect(row?.status).toBe('accepted');
    expect(row?.notified_at).toBeNull();

    const messages = await env.DB.prepare(`SELECT COUNT(*) AS n FROM message_log WHERE bulk_job_id = ?`)
      .bind(body.job_id)
      .first<{ n: number }>();
    expect(messages?.n).toBe(0);
  });

  it('falls back to a co-speaker/participant email when the submitter has none, instead of silently skipping', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    // No submitter contact at all — the admin-created-record shape this
    // fallback is meant to rescue.
    const submissionId = await seedSubmission(eventId, null, 'accept_queue');
    const coSpeaker = await createContact(eventId, { email: 'co-speaker@example.com', first_name: 'Priya' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'co-speaker', 1, 0)`,
    ).bind(crypto.randomUUID(), submissionId, coSpeaker).run();

    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/send-decisions',
      post(cookie, { ids: [submissionId] }),
    );
    const body = (await res.json()) as { job_id: string; skipped_no_submitter: number };
    // The preflight count already reflects the fallback — it must not report
    // this submission as unreachable when a participant can still be mailed.
    expect(body.skipped_no_submitter).toBe(0);
    await settleJob(body.job_id);

    const row = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id = ?')
      .bind(submissionId)
      .first<{ status: string; notified_at: string | null }>();
    expect(row?.status).toBe('accepted');
    expect(row?.notified_at).not.toBeNull();

    const messages = await env.DB.prepare(
      `SELECT template_key, to_email FROM message_log WHERE bulk_job_id = ?`,
    ).bind(body.job_id).all<{ template_key: string; to_email: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]).toMatchObject({ template_key: 'decision_accepted', to_email: 'co-speaker@example.com' });

    const polled = await (
      await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie } })
    ).json() as { skipped_no_submitter: number };
    expect(polled.skipped_no_submitter).toBe(0);
  });
});
