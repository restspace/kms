// Workers tests for sweep item P2-19: the bulk_jobs cron expander
// (jobs/bulkJobs.ts). Covers the send-decisions kind end-to-end: bounded
// ticks, resume-without-duplicates, exactly-once status flips, and the
// reviewer-feedback opt-in.

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

async function seedSubmission(eventId: string, submitterId: string, status: string): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, `Talk ${id.slice(-4)}`, status, submitterId, ts, ts).run();
  return id;
}

async function seedBulkJob(eventId: string, ids: string[], includeFeedback = false): Promise<string> {
  const id = `job-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
     VALUES (?, ?, 'send-decisions', 'pending', ?, ?, 0, 'tester', ?, ?)`,
  ).bind(id, eventId, JSON.stringify({ ids, include_feedback: includeFeedback }), ids.length, ts, ts).run();
  return id;
}

describe('sweepBulkJobs / send-decisions', () => {
  it('processes a 3-submission single-speaker job whole in one tick despite a limit of 2 (anti-split rule), flipping each status exactly once', async () => {
    // Pre-workplan-10 this test pinned 2+1 across two ticks — three separate
    // emails to the same speaker. The tick-boundary rule now refuses to split
    // a speaker's group: when the group alone fills the batch it is fetched
    // and processed whole, producing ONE merged decision_summary email.
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'speaker@example.com' });
    const s1 = await seedSubmission(eventId, speaker, 'accept_queue');
    const s2 = await seedSubmission(eventId, speaker, 'decline_queue');
    const s3 = await seedSubmission(eventId, speaker, 'accept_queue');
    const jobId = await seedBulkJob(eventId, [s1, s2, s3]);

    await sweepBulkJobs(env, 2); // tick 1: the whole group, not a 2-row slice
    const job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string; enqueued: number }>();
    expect(job?.enqueued).toBe(3);
    expect(job?.status).toBe('done');

    const statuses = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?, ?)')
      .bind(s1, s2, s3)
      .all<{ id: string; status: string; notified_at: string | null }>();
    const byId = Object.fromEntries(statuses.results.map((r) => [r.id, r]));
    expect(byId[s1]!.status).toBe('accepted');
    expect(byId[s2]!.status).toBe('declined');
    expect(byId[s3]!.status).toBe('accepted');
    // The one merged email covers — and stamps — all three.
    for (const id of [s1, s2, s3]) expect(byId[id]!.notified_at).not.toBeNull();

    const messages = await env.DB.prepare(`SELECT template_key FROM message_log WHERE bulk_job_id = ?`)
      .bind(jobId)
      .all<{ template_key: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]!.template_key).toBe('decision_summary');
  });

  it('re-running the expander on a done job is a no-op and creates no duplicate message_log rows', async () => {
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'speaker2@example.com' });
    const s1 = await seedSubmission(eventId, speaker, 'accept_queue');
    await seedBulkJob(eventId, [s1]);

    await sweepBulkJobs(env, 50);
    const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log').first<{ n: number }>();

    // A done job is neither 'pending' nor 'running', so a second sweep claims
    // nothing (there is nothing else pending) and leaves everything as-is.
    await sweepBulkJobs(env, 50);
    const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log').first<{ n: number }>();
    expect(after?.n).toBe(before?.n);

    const statusRow = await env.DB.prepare('SELECT status FROM submissions WHERE id = ?').bind(s1).first<{ status: string }>();
    expect(statusRow?.status).toBe('accepted');
  });

  it('embeds non-empty, non-conflicted reviewer comments as bullet lines when include_feedback is set', async () => {
    const eventId = await createEvent();
    const speaker = await createContact(eventId, { email: 'speaker3@example.com' });
    const s1 = await seedSubmission(eventId, speaker, 'accept_queue');

    const plan = `plan-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan', 'active', ?)`)
      .bind(plan, eventId, ts).run();
    const reviewerA = await createContact(eventId, { email: 'ra@example.com' });
    const reviewerB = await createContact(eventId, { email: 'rb@example.com' });
    await env.DB.prepare(
      `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).bind(`rev-${crypto.randomUUID()}`, s1, reviewerA, plan, 'Great talk, solid structure.', ts).run();
    await env.DB.prepare(
      `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, 0, ?)`,
    ).bind(`rev-${crypto.randomUUID()}`, s1, reviewerB, plan, 'Needs more concrete examples.', ts).run();
    // A conflicted review's comment must never leak into the email.
    await env.DB.prepare(
      `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    ).bind(`rev-${crypto.randomUUID()}`, s1, reviewerA, plan, 'CONFLICTED — should not appear', ts).run();

    const jobId = await seedBulkJob(eventId, [s1], true);
    await sweepBulkJobs(env, 50);

    // Storage is NOT isolated between it() blocks within this file (confirmed
    // by direct inspection: earlier tests' bulk_jobs/message_log/outbox rows
    // are visible here), so the query must be scoped to *this* job's own
    // message via the jobId-embedded idempotency-key convention — a bare
    // 'decision_accepted:%' pattern can match an earlier test's row instead.
    const outboxRow = await env.DB.prepare(
      `SELECT payload FROM outbox
       WHERE idempotency_key IN (SELECT idempotency_key FROM message_log WHERE bulk_job_id = ?)
         AND idempotency_key LIKE 'decision_accepted:%'`,
    ).bind(jobId).first<{ payload: string }>();
    expect(outboxRow).toBeTruthy();
    const payload = JSON.parse(outboxRow!.payload) as { html: string; text: string };
    expect(payload.html).toContain('Great talk, solid structure.');
    expect(payload.html).toContain('Needs more concrete examples.');
    expect(payload.html).not.toContain('CONFLICTED');
  });
});
