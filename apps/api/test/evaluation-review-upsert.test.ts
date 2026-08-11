// Workers tests for sweep item P1-5 (evaluation.ts): the review upsert
// (INSERT … ON CONFLICT(assignment_id) DO UPDATE), the single-statement
// rating_cache refresh, the set-based auto-assign-on-accept, and reviewer-id
// validation on plan assignment.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { autoAssignAcceptTasksCore } from '../src/routes/evaluation';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

async function seedSubmission(eventId: string, overrides: Partial<{ id: string; status: string; submitter_contact_id: string | null }> = {}): Promise<string> {
  const id = overrides.id ?? `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', 'A talk', ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, overrides.status ?? 'pending', overrides.submitter_contact_id ?? null, ts, ts).run();
  return id;
}

async function seedPlan(eventId: string, overrides: Partial<{ id: string }> = {}): Promise<string> {
  const id = overrides.id ?? `plan-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Plan', 'active', ?)`,
  ).bind(id, eventId, ts).run();
  return id;
}

async function seedCriterion(planId: string, weight = 1): Promise<string> {
  const id = `crit-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO scoring_criteria (id, plan_id, name, weight, position) VALUES (?, ?, 'Quality', ?, 0)`,
  ).bind(id, planId, weight).run();
  return id;
}

async function seedAssignment(planId: string, submissionId: string, reviewerId: string): Promise<string> {
  const id = `ra-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).bind(id, planId, submissionId, reviewerId, ts).run();
  return id;
}

async function seedTask(eventId: string, overrides: Partial<{ id: string; title: string; due_at: string | null }> = {}): Promise<string> {
  const id = overrides.id ?? `tsk-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO tasks (id, event_id, title, target, assignment_mode, "trigger", action_type, due_at, required, created_at)
     VALUES (?, ?, ?, 'submission', 'automatic', 'on_accept', 'acknowledge', ?, 0, ?)`,
  ).bind(id, eventId, overrides.title ?? 'Sign speaker agreement', overrides.due_at ?? null, ts).run();
  return id;
}

describe('review upsert (P1-5)', () => {
  it('concurrent saves for the same assignment leave one reviews row with the last writer content, and a consistent rating cache', async () => {
    const eventId = await createEvent();
    const reviewer = await createContact(eventId, { email: 'reviewer@example.com' });
    await createEventUser(eventId, reviewer, 'reviewer');
    const submission = await seedSubmission(eventId);
    const plan = await seedPlan(eventId);
    const criterion = await seedCriterion(plan);
    const assignmentId = await seedAssignment(plan, submission, reviewer);
    const cookie = await sessionCookieFor({ contactId: reviewer, eventId, role: 'reviewer' });

    const save = (score: number) =>
      SELF.fetch(`https://example.com/app/api/review/assignments/${assignmentId}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ scores: { [criterion]: score }, comment: `score ${score}` }),
      });

    // Fire two concurrent saves with different content; D1 serializes writes
    // so exactly one becomes the final state, but there must be exactly one
    // reviews row either way (no duplicate insert from a lost-update race).
    const [r1, r2] = await Promise.all([save(3), save(5)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const rows = await env.DB.prepare('SELECT id, scores, weighted_total FROM reviews WHERE assignment_id = ?')
      .bind(assignmentId)
      .all<{ id: string; scores: string; weighted_total: number }>();
    expect(rows.results).toHaveLength(1);
    const finalScore = JSON.parse(rows.results[0]!.scores) as Record<string, number>;
    expect([3, 5]).toContain(finalScore[criterion]);
    expect(rows.results[0]!.weighted_total).toBe(finalScore[criterion]);

    const sub = await env.DB.prepare('SELECT rating_cache FROM submissions WHERE id = ?')
      .bind(submission)
      .first<{ rating_cache: string }>();
    const cache = JSON.parse(sub!.rating_cache) as Record<string, number>;
    expect(cache[plan]).toBe(finalScore[criterion]);
  });

  it('re-saving the same assignment updates the existing row rather than inserting a second one', async () => {
    const eventId = await createEvent();
    const reviewer = await createContact(eventId, { email: 'reviewer2@example.com' });
    await createEventUser(eventId, reviewer, 'reviewer');
    const submission = await seedSubmission(eventId);
    const plan = await seedPlan(eventId);
    const criterion = await seedCriterion(plan);
    const assignmentId = await seedAssignment(plan, submission, reviewer);
    const cookie = await sessionCookieFor({ contactId: reviewer, eventId, role: 'reviewer' });

    const save = (score: number, comment: string) =>
      SELF.fetch(`https://example.com/app/api/review/assignments/${assignmentId}`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ scores: { [criterion]: score }, comment }),
      });

    await save(2, 'first pass');
    const res = await save(4, 'second pass');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weighted_total: number };
    expect(body.weighted_total).toBe(4);

    // Still exactly one reviews row on re-save; reviews.comment is deprecated
    // (workplan 7 §3) and is no longer written — the rationale text lives on
    // the submission_comments thread instead (see submission-comments.test.ts
    // for the append-on-change behaviour).
    const rows = await env.DB.prepare('SELECT id, comment FROM reviews WHERE assignment_id = ?').bind(assignmentId).all<{ id: string; comment: string | null }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.comment).toBeNull();
  });

  it('preserves another plan\'s cached rating when this plan\'s rating changes', async () => {
    const eventId = await createEvent();
    const reviewer = await createContact(eventId, { email: 'reviewer3@example.com' });
    await createEventUser(eventId, reviewer, 'reviewer');
    const submission = await seedSubmission(eventId);
    const otherPlan = await seedPlan(eventId);
    await env.DB.prepare('UPDATE submissions SET rating_cache = ? WHERE id = ?')
      .bind(JSON.stringify({ [otherPlan]: 4.5 }), submission)
      .run();

    const plan = await seedPlan(eventId);
    const criterion = await seedCriterion(plan);
    const assignmentId = await seedAssignment(plan, submission, reviewer);
    const cookie = await sessionCookieFor({ contactId: reviewer, eventId, role: 'reviewer' });

    await SELF.fetch(`https://example.com/app/api/review/assignments/${assignmentId}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ scores: { [criterion]: 5 } }),
    });

    const sub = await env.DB.prepare('SELECT rating_cache FROM submissions WHERE id = ?').bind(submission).first<{ rating_cache: string }>();
    const cache = JSON.parse(sub!.rating_cache) as Record<string, number>;
    expect(cache[otherPlan]).toBe(4.5);
    expect(cache[plan]).toBe(5);
  });
});

describe('autoAssignAcceptTasksCore (P1-5)', () => {
  it('is set-based and re-running never duplicates the assignment or the email', async () => {
    const eventId = await createEvent();
    const owner = await createContact(eventId, { email: 'speaker@example.com' });
    const submission = await seedSubmission(eventId, { submitter_contact_id: owner, status: 'accepted' });
    await seedTask(eventId, { title: 'Sign agreement' });

    const sent: unknown[] = [];
    const send = async (args: unknown) => {
      sent.push(args);
      return 'queued';
    };

    const first = await autoAssignAcceptTasksCore(
      env.DB, eventId, { id: submission, code: 'SESS-000001', title: 'A talk' }, 'Test Event', 'evt', 'https://app.example.com', send,
    );
    expect(first).toBe(1);
    expect(sent).toHaveLength(1);

    const second = await autoAssignAcceptTasksCore(
      env.DB, eventId, { id: submission, code: 'SESS-000001', title: 'A talk' }, 'Test Event', 'evt', 'https://app.example.com', send,
    );
    expect(second).toBe(0);
    expect(sent).toHaveLength(1); // no duplicate email on the re-run

    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM task_assignments WHERE submission_id = ?').bind(submission).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('keeps the entity id to the bare assignment id so a batch never enters the idempotency key', async () => {
    const eventId = await createEvent();
    const owner = await createContact(eventId, { email: 'speaker2@example.com' });
    const submission = await seedSubmission(eventId, { submitter_contact_id: owner, status: 'accepted' });
    await seedTask(eventId, { title: 'Upload slides' });

    let capturedEntityId = '';
    const send = async (args: { entityId: string }) => {
      capturedEntityId = args.entityId;
      return 'queued';
    };

    await autoAssignAcceptTasksCore(
      env.DB, eventId, { id: submission, code: 'SESS-000002', title: 'Another talk' }, 'Test Event', 'evt', 'https://app.example.com', send,
    );
    // A bulk-job caller tags the send with `bulkJobId` (see jobs/bulkJobs.ts's
    // queueSend) rather than smuggling the job id in here — migration 0014.
    const assignment = await env.DB
      .prepare('SELECT id FROM task_assignments WHERE submission_id = ?')
      .bind(submission)
      .first<{ id: string }>();
    expect(capturedEntityId).toBe(assignment?.id);
  });
});

describe('reviewer validation on plan assignment (P1-5)', () => {
  it('rejects a reviewer id that is not an event_users member with an eligible role', async () => {
    const eventId = await createEvent();
    const admin = await createContact(eventId, { email: 'admin@example.com' });
    await createEventUser(eventId, admin, 'admin');
    const cookie = await sessionCookieFor({ contactId: admin, eventId, role: 'admin' });

    const plan = await seedPlan(eventId);
    const outsider = await createContact(eventId, { email: 'not-a-reviewer@example.com' }); // no event_users row

    const res = await SELF.fetch(`https://example.com/app/api/evaluation/plans/${plan}/assign`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer_contact_ids: [outsider] }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_reviewer' });
  });

  it('accepts a reviewer who is an event_users member with role reviewer', async () => {
    const eventId = await createEvent();
    const admin = await createContact(eventId, { email: 'admin2@example.com' });
    await createEventUser(eventId, admin, 'admin');
    const cookie = await sessionCookieFor({ contactId: admin, eventId, role: 'admin' });

    const plan = await seedPlan(eventId);
    const reviewer = await createContact(eventId, { email: 'good-reviewer@example.com' });
    await createEventUser(eventId, reviewer, 'reviewer');

    const res = await SELF.fetch(`https://example.com/app/api/evaluation/plans/${plan}/assign`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ reviewer_contact_ids: [reviewer] }),
    });
    expect(res.status).toBe(200);
  });
});
