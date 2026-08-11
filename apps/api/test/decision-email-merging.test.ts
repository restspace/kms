// Workplan 10 (tests/workplan-10-decision-email-merging.md §7): the decision
// flush becomes speaker-shaped. A speaker with several decisions queued in
// the same batch gets ONE `decision_summary` email (accepts listed before
// declines) instead of N separate, potentially contradictory-feeling emails.
// Speakers with exactly one decision in the batch keep the pre-existing
// `decision_accepted`/`decision_declined` templates and log key byte-for-byte
// (D6 — pinned as a regression here). Covers the plan's 11 unit cases:
//  1. 2 accepts + 1 decline -> one merged email, accepts before decline.
//  2. Exactly one decision -> untouched single-decision template/key.
//  3. Re-POST of already-decided ids -> no-op.
//  4. hold_contact_ids excludes a speaker from the send.
//  5. Preflight speakers_with_pending (drafts/withdrawn excluded); no job row.
//  6. pending_note toggles the "still under review" line.
//  7. A null-submitter row in the same batch doesn't poison a real group.
//  8. Tick-boundary: LIMIT never splits a speaker's group across two emails.
//  9. include_feedback nests each submission's non-CoI comments correctly.
//  10. decision_summary disabled at the event -> no email, statuses still flip.
//  11. Accept auto-assign still fires once per accepted submission in a group.
//
// Storage is NOT isolated between it() blocks in this file (see
// bulkjobs-expander.test.ts's note) — every assertion below is scoped to ids/
// emails/job ids created within its own test.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

// The send-decisions route kicks the expander itself via waitUntil (the
// dead-minute fix), so the job may still be expanding when the response
// lands. Sweep for anything still pending, then wait for the job row to
// reach a terminal state before asserting (mirrors
// bulkjobs-expander-decisions-notify.test.ts).
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

async function seedSubmission(
  eventId: string,
  submitterId: string | null,
  status: string,
  overrides: Partial<{ id: string; title: string; code: string; created_at: string }> = {},
): Promise<string> {
  const id = overrides.id ?? `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(
    id,
    eventId,
    overrides.code ?? `SESS-${id.slice(-6)}`,
    overrides.title ?? `Talk ${id.slice(-4)}`,
    status,
    submitterId,
    overrides.created_at ?? ts,
    ts,
  ).run();
  return id;
}

/** Direct bulk_jobs seed for tick-boundary tests that drive sweepBulkJobs
 * without going through the HTTP route (mirrors bulkjobs-expander.test.ts). */
async function seedBulkJob(eventId: string, ids: string[], extraParams: Record<string, unknown> = {}): Promise<string> {
  const id = `job-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
     VALUES (?, ?, 'send-decisions', 'pending', ?, ?, 0, 'tester', ?, ?)`,
  ).bind(id, eventId, JSON.stringify({ ids, ...extraParams }), ids.length, ts, ts).run();
  return id;
}

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

const SEND_DECISIONS_URL = 'https://example.com/app/api/submissions/send-decisions';

async function payloadHtmlFor(jobId: string, templateKeyLike?: string): Promise<string> {
  const where = templateKeyLike
    ? `WHERE bulk_job_id = ? AND template_key = ?`
    : `WHERE bulk_job_id = ?`;
  const msg = templateKeyLike
    ? await env.DB.prepare(`SELECT idempotency_key FROM message_log ${where}`).bind(jobId, templateKeyLike).first<{ idempotency_key: string }>()
    : await env.DB.prepare(`SELECT idempotency_key FROM message_log ${where}`).bind(jobId).first<{ idempotency_key: string }>();
  if (!msg) throw new Error(`no message_log row for job ${jobId}`);
  const outboxRow = await env.DB.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?')
    .bind(msg.idempotency_key)
    .first<{ payload: string }>();
  if (!outboxRow) throw new Error(`no outbox row for key ${msg.idempotency_key}`);
  return (JSON.parse(outboxRow.payload) as { html: string }).html;
}

describe('decision email merging (workplan 10)', () => {
  it('1. speaker with 2 accepts + 1 decline queued gets exactly one merged email, accepts before the decline', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'mix@example.com', first_name: 'Grace' });
    const a1 = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Talk Accept One' });
    const a2 = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Talk Accept Two' });
    const d1 = await seedSubmission(eventId, speaker, 'decline_queue', { title: 'Talk Decline One' });

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [a1, a2, d1] }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const messages = await env.DB.prepare(`SELECT template_key, idempotency_key FROM message_log WHERE bulk_job_id = ?`)
      .bind(body.job_id)
      .all<{ template_key: string; idempotency_key: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]!.template_key).toBe('decision_summary');
    expect(messages.results[0]!.idempotency_key).toContain('batch:');

    const html = await payloadHtmlFor(body.job_id);
    const idxAcc1 = html.indexOf('Talk Accept One');
    const idxAcc2 = html.indexOf('Talk Accept Two');
    const idxDec1 = html.indexOf('Talk Decline One');
    expect(idxAcc1).toBeGreaterThan(-1);
    expect(idxAcc2).toBeGreaterThan(-1);
    expect(idxDec1).toBeGreaterThan(idxAcc1);
    expect(idxDec1).toBeGreaterThan(idxAcc2);

    const rows = await env.DB.prepare('SELECT id, notified_at FROM submissions WHERE id IN (?, ?, ?)')
      .bind(a1, a2, d1)
      .all<{ id: string; notified_at: string | null }>();
    expect(rows.results).toHaveLength(3);
    for (const r of rows.results) expect(r.notified_at).not.toBeNull();
  });

  it('2. speaker with exactly one queued decision keeps the untouched decision_accepted template/key (regression pin, D6)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'solo@example.com' });
    const s1 = await seedSubmission(eventId, speaker, 'accept_queue');

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [s1] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const row = await env.DB.prepare('SELECT template_key, idempotency_key FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .first<{ template_key: string; idempotency_key: string }>();
    expect(row?.template_key).toBe('decision_accepted');
    expect(row?.idempotency_key).toBe(`decision_accepted:${speaker}:${s1}:v1`);
  });

  it('3. re-POST of the same (already-decided) ids is a no-op: no new job, no new emails, notified_at unchanged', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'again@example.com' });
    const a1 = await seedSubmission(eventId, speaker, 'accept_queue');
    const d1 = await seedSubmission(eventId, speaker, 'decline_queue');

    const res1 = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [a1, d1] }));
    const body1 = (await res1.json()) as { job_id: string };
    await settleJob(body1.job_id);

    const before = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(a1, d1)
      .all<{ id: string; status: string; notified_at: string }>();
    const beforeMap = Object.fromEntries(before.results.map((r) => [r.id, r]));
    const totalBefore = (await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log').first<{ n: number }>())?.n;

    // Re-POST the same ids: both rows are now 'accepted'/'declined', outside
    // the queue states the route selects on, so no job is even created.
    const res2 = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [a1, d1] }));
    const body2 = (await res2.json()) as { job_id: string | null; accepted: number; declined: number };
    expect(body2.accepted).toBe(0);
    expect(body2.declined).toBe(0);
    expect(body2.job_id).toBeNull();

    const totalAfter = (await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log').first<{ n: number }>())?.n;
    expect(totalAfter).toBe(totalBefore);

    const after = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(a1, d1)
      .all<{ id: string; status: string; notified_at: string }>();
    for (const r of after.results) {
      expect(r.status).toBe(beforeMap[r.id]!.status);
      expect(r.notified_at).toBe(beforeMap[r.id]!.notified_at);
    }
  });

  it('4. hold_contact_ids excludes that speaker: rows stay queued, no email, response held count is correct', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const held = await createContact(eventId, { email: 'held@example.com' });
    const sendNow = await createContact(eventId, { email: 'sendnow@example.com' });
    const h1 = await seedSubmission(eventId, held, 'accept_queue');
    const h2 = await seedSubmission(eventId, held, 'decline_queue');
    const s1 = await seedSubmission(eventId, sendNow, 'accept_queue');

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [h1, h2, s1], hold_contact_ids: [held] }));
    const body = (await res.json()) as { job_id: string; held: number; accepted: number; declined: number };
    // held counts submissions, not speakers: h1 + h2 = 2.
    expect(body.held).toBe(2);
    expect(body.accepted).toBe(1);
    expect(body.declined).toBe(0);
    await settleJob(body.job_id);

    const heldRows = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(h1, h2)
      .all<{ status: string; notified_at: string | null }>();
    for (const r of heldRows.results) {
      expect(['accept_queue', 'decline_queue']).toContain(r.status);
      expect(r.notified_at).toBeNull();
    }

    const messages = await env.DB.prepare('SELECT to_email FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .all<{ to_email: string }>();
    expect(messages.results.some((m) => m.to_email === 'held@example.com')).toBe(false);
    expect(messages.results.some((m) => m.to_email === 'sendnow@example.com')).toBe(true);
  });

  it('5. preflight reports speakers_with_pending (drafts/withdrawn excluded) and creates no bulk_jobs row', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'pf@example.com', first_name: 'Pat', last_name: 'Fly' });
    const a1 = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Main Talk' });
    await seedSubmission(eventId, speaker, 'pending', { title: 'Pending Talk' });
    await seedSubmission(eventId, speaker, 'draft', { title: 'Draft Talk — must not count' });
    await seedSubmission(eventId, speaker, 'withdrawn', { title: 'Withdrawn Talk — must not count' });

    const jobCountBefore = (await env.DB.prepare('SELECT COUNT(*) AS n FROM bulk_jobs').first<{ n: number }>())?.n;

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [a1], preflight: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      job_id: string | null;
      speakers_with_pending: Array<{ contact_id: string; name: string; pending_count: number; pending_titles: string[] }>;
    };
    expect(body.job_id).toBeNull();
    expect(body.speakers_with_pending).toHaveLength(1);
    expect(body.speakers_with_pending[0]!.contact_id).toBe(speaker);
    expect(body.speakers_with_pending[0]!.pending_count).toBe(1);
    expect(body.speakers_with_pending[0]!.pending_titles).toEqual(['Pending Talk']);

    const jobCountAfter = (await env.DB.prepare('SELECT COUNT(*) AS n FROM bulk_jobs').first<{ n: number }>())?.n;
    expect(jobCountAfter).toBe(jobCountBefore);
  });

  it('6. pending_note:true renders the still-under-review line with the pending title; pending_note:false renders nothing', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);

    const speakerA = await createContact(eventId, { email: 'pn-true@example.com' });
    const aAcc = await seedSubmission(eventId, speakerA, 'accept_queue', { title: 'Accepted Talk A' });
    const aAcc2 = await seedSubmission(eventId, speakerA, 'accept_queue', { title: 'Accepted Talk A2' });
    await seedSubmission(eventId, speakerA, 'pending', { title: 'Under Review Talk' });

    const resA = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [aAcc, aAcc2], pending_note: true }));
    const bodyA = (await resA.json()) as { job_id: string };
    await settleJob(bodyA.job_id);
    const htmlA = await payloadHtmlFor(bodyA.job_id);
    expect(htmlA).toContain('still under review');
    expect(htmlA).toContain('Under Review Talk');

    const speakerB = await createContact(eventId, { email: 'pn-false@example.com' });
    const bAcc = await seedSubmission(eventId, speakerB, 'accept_queue', { title: 'Accepted Talk B' });
    const bAcc2 = await seedSubmission(eventId, speakerB, 'accept_queue', { title: 'Accepted Talk B2' });
    await seedSubmission(eventId, speakerB, 'pending', { title: 'Should Not Appear Talk' });

    const resB = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [bAcc, bAcc2], pending_note: false }));
    const bodyB = (await resB.json()) as { job_id: string };
    await settleJob(bodyB.job_id);
    const htmlB = await payloadHtmlFor(bodyB.job_id);
    expect(htmlB).not.toContain('still under review');
    expect(htmlB).not.toContain('Should Not Appear Talk');
  });

  it('7. a null-submitter submission in the same batch is flipped/skipped without poisoning the real speaker group', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const nullSub = await seedSubmission(eventId, null, 'decline_queue');
    const speaker = await createContact(eventId, { email: 'real@example.com' });
    const r1 = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Real Accept' });
    const r2 = await seedSubmission(eventId, speaker, 'decline_queue', { title: 'Real Decline' });

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [nullSub, r1, r2] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const nullRow = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id = ?')
      .bind(nullSub)
      .first<{ status: string; notified_at: string | null }>();
    expect(nullRow?.status).toBe('declined');
    expect(nullRow?.notified_at).toBeNull();

    const realRows = await env.DB.prepare('SELECT id, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(r1, r2)
      .all<{ id: string; notified_at: string | null }>();
    for (const r of realRows.results) expect(r.notified_at).not.toBeNull();

    const messages = await env.DB.prepare('SELECT template_key, to_email FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .all<{ template_key: string; to_email: string }>();
    // Only the real speaker's merged email — the null-contact row never queues one.
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]!.template_key).toBe('decision_summary');
    expect(messages.results[0]!.to_email).toBe('real@example.com');
  });

  it('8. tick-boundary rule defers a split speaker whole to the next tick; exactly one decision_summary for them across ticks', async () => {
    const eventId = await createEvent();
    // Explicit contact ids to pin the ORDER BY submitter_contact_id sort: 'a'
    // sorts before 'b', so speakerA's group is always the leading one.
    const speakerA = await createContact(eventId, { id: `con-a-tickbound-${crypto.randomUUID()}`, email: 'tickbound-a@example.com' });
    const speakerB = await createContact(eventId, { id: `con-b-tickbound-${crypto.randomUUID()}`, email: 'tickbound-b@example.com' });
    const a1 = await seedSubmission(eventId, speakerA, 'accept_queue');
    const a2 = await seedSubmission(eventId, speakerA, 'decline_queue');
    const b1 = await seedSubmission(eventId, speakerB, 'accept_queue');
    const b2 = await seedSubmission(eventId, speakerB, 'decline_queue');
    const b3 = await seedSubmission(eventId, speakerB, 'accept_queue');
    const jobId = await seedBulkJob(eventId, [a1, a2, b1, b2, b3]);

    // limit=3 over A's complete 2-row group + B's 3-row group: the over-fetch
    // (limit+1=4) lands row 4 still inside B, so B's leading row in the
    // 3-slice is trimmed away — only A's complete group is processed.
    await sweepBulkJobs(env, 3);

    const afterTick1 = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?, ?, ?, ?)')
      .bind(a1, a2, b1, b2, b3)
      .all<{ id: string; status: string; notified_at: string | null }>();
    const byId1 = Object.fromEntries(afterTick1.results.map((r) => [r.id, r]));
    expect(byId1[a1]!.status).toBe('accepted');
    expect(byId1[a2]!.status).toBe('declined');
    expect(byId1[a1]!.notified_at).not.toBeNull();
    expect(byId1[a2]!.notified_at).not.toBeNull();
    // B's group deferred whole — untouched.
    expect(byId1[b1]!.status).toBe('accept_queue');
    expect(byId1[b2]!.status).toBe('decline_queue');
    expect(byId1[b3]!.status).toBe('accept_queue');

    const jobMid = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
    expect(jobMid?.status).toBe('running');

    // Second tick: only B's 3 rows still match the queue-state filter, so the
    // over-fetch no longer straddles a boundary — B's whole group goes in one pass.
    await sweepBulkJobs(env, 3);

    const afterTick2 = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?, ?)')
      .bind(b1, b2, b3)
      .all<{ id: string; status: string; notified_at: string | null }>();
    for (const r of afterTick2.results) expect(r.notified_at).not.toBeNull();

    const jobFinal = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string }>();
    expect(jobFinal?.status).toBe('done');

    const bMessages = await env.DB.prepare(`SELECT template_key FROM message_log WHERE bulk_job_id = ? AND to_email = ?`)
      .bind(jobId, 'tickbound-b@example.com')
      .all<{ template_key: string }>();
    expect(bMessages.results).toHaveLength(1);
    expect(bMessages.results[0]!.template_key).toBe('decision_summary');
  });

  it('9. include_feedback on a merged email nests each non-CoI comment under the right submission', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'feedback@example.com' });
    const acc = await seedSubmission(eventId, speaker, 'accept_queue', { title: 'Feedback Accept Talk' });
    const dec = await seedSubmission(eventId, speaker, 'decline_queue', { title: 'Feedback Decline Talk' });

    // reviews.comment is deprecated (workplan 7 §3): feedback now comes from
    // the submission_comments thread — each assignment's latest
    // kind='rationale' row, with a conflicted assignment excluded via the
    // reviews join. Fixture shape mirrors bulkjobs-expander.test.ts: a real
    // review_assignments row per rationale, plus a second plan for the
    // conflicted assignment (UNIQUE(plan_id, submission_id, reviewer)).
    const plan = `plan-${crypto.randomUUID()}`;
    const plan2 = `plan-${crypto.randomUUID()}`;
    await env.DB.prepare(`INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan', 'active', ?)`)
      .bind(plan, eventId, ts).run();
    await env.DB.prepare(`INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan 2', 'active', ?)`)
      .bind(plan2, eventId, ts).run();
    const reviewer = await createContact(eventId, { email: 'reviewer@example.com' });
    const seedRationale = async (planId: string, submissionId: string, conflict: boolean, rationale: string) => {
      const assignmentId = `ra-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
         VALUES (?, ?, ?, ?, 'complete', ?)`,
      ).bind(assignmentId, planId, submissionId, reviewer, ts).run();
      await env.DB.prepare(
        `INSERT INTO reviews (id, assignment_id, submission_id, reviewer_contact_id, plan_id, comment, conflict_of_interest, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(`rev-${crypto.randomUUID()}`, assignmentId, submissionId, reviewer, planId, conflict ? 1 : 0, ts).run();
      await env.DB.prepare(
        `INSERT INTO submission_comments (id, event_id, submission_id, plan_id, assignment_id, author_contact_id, author_role, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'reviewer', 'rationale', ?, ?)`,
      ).bind(`sc-${crypto.randomUUID()}`, eventId, submissionId, planId, assignmentId, reviewer, rationale, ts).run();
    };
    await seedRationale(plan, acc, false, 'Loved the pacing.');
    await seedRationale(plan, dec, false, 'Not a fit for this track.');
    // A conflicted assignment's rationale must never leak into the merged email.
    await seedRationale(plan2, acc, true, 'CONFLICTED comment — must not appear');

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [acc, dec], include_feedback: true }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const html = await payloadHtmlFor(body.job_id);
    expect(html).not.toContain('CONFLICTED');

    const idxAccTitle = html.indexOf('Feedback Accept Talk');
    const idxAccFeedback = html.indexOf('Loved the pacing.');
    const idxDecTitle = html.indexOf('Feedback Decline Talk');
    const idxDecFeedback = html.indexOf('Not a fit for this track.');
    expect(idxAccTitle).toBeGreaterThan(-1);
    // Accept's own feedback nests right after accept's title, and before the
    // decline block (accepts-first ordering, D1).
    expect(idxAccFeedback).toBeGreaterThan(idxAccTitle);
    expect(idxDecTitle).toBeGreaterThan(idxAccFeedback);
    expect(idxDecFeedback).toBeGreaterThan(idxDecTitle);
  });

  it('10. decision_summary disabled in email_templates: no email, no notified_at, statuses still flip', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    await env.DB.prepare(
      `INSERT INTO email_templates (id, event_id, key, name, enabled, updated_at) VALUES (?, ?, 'decision_summary', 'Decision summary', 0, ?)`,
    ).bind(`tpl-${crypto.randomUUID()}`, eventId, ts).run();

    const speaker = await createContact(eventId, { email: 'disabled@example.com' });
    const a1 = await seedSubmission(eventId, speaker, 'accept_queue');
    const d1 = await seedSubmission(eventId, speaker, 'decline_queue');

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [a1, d1] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const messages = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .first<{ n: number }>();
    expect(messages?.n).toBe(0);

    const rows = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(a1, d1)
      .all<{ status: string; notified_at: string | null }>();
    expect(rows.results).toHaveLength(2);
    for (const r of rows.results) {
      expect(['accepted', 'declined']).toContain(r.status);
      expect(r.notified_at).toBeNull();
    }
  });

  it('11. accepts in a merged group still auto-assign the on_accept task once per accepted submission', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const taskId = `task-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO tasks (id, event_id, title, target, assignment_mode, "trigger", action_type, required, created_at)
       VALUES (?, ?, 'Slides upload', 'submission', 'automatic', 'on_accept', 'acknowledge', 0, ?)`,
    ).bind(taskId, eventId, ts).run();

    const speaker = await createContact(eventId, { email: 'tasked@example.com' });
    const acc1 = await seedSubmission(eventId, speaker, 'accept_queue');
    const acc2 = await seedSubmission(eventId, speaker, 'accept_queue');
    const dec1 = await seedSubmission(eventId, speaker, 'decline_queue');

    const res = await SELF.fetch(SEND_DECISIONS_URL, post(cookie, { ids: [acc1, acc2, dec1] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const assignments = await env.DB.prepare('SELECT submission_id FROM task_assignments WHERE task_id = ?')
      .bind(taskId)
      .all<{ submission_id: string }>();
    const subIds = assignments.results.map((r) => r.submission_id).sort();
    expect(subIds).toEqual([acc1, acc2].sort());
  });
});
