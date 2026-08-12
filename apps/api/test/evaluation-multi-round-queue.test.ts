// Eval defect (2026-08-12 sweep): "Reviewer queue deduplicates by submission
// instead of by (submission, round)". The same reviewer reviewing the same
// submission in two concurrent rounds must get two queue items — one per
// plan, each with that plan's own scorecard — and both must be scorable
// independently. This test reproduces the exact scenario the judge ran:
// submission in plan A (assigned), then added to plan B with its own
// criterion + the same reviewer, assigned again.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function makePlan(cookie: string, name: string): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('multi-round review of one submission by one reviewer', () => {
  it('two plans → two queue items, each scorable against its own criteria', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId, { title: 'SESS-10 style' });

    const planA = await makePlan(admin.cookie, 'Round 1');
    const planB = await makePlan(admin.cookie, 'Initial Review');

    for (const planId of [planA, planB]) {
      const add = await SELF.fetch(
        `${base}/evaluation/plans/${planId}/submissions`,
        jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
      );
      expect(add.status).toBe(200);
      const assign = await SELF.fetch(
        `${base}/evaluation/plans/${planId}/assign`,
        jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
      );
      expect(assign.status).toBe(200);
    }

    // The second assign must actually have created a second assignment row.
    const { results: rows } = await env.DB
      .prepare('SELECT id, plan_id FROM review_assignments WHERE submission_id = ? AND reviewer_contact_id = ?')
      .bind(submissionId, reviewer.contactId)
      .all<{ id: string; plan_id: string }>();
    expect(rows.map((r) => r.plan_id).sort()).toEqual([planA, planB].sort());

    // The reviewer's queue lists both — one item per (submission, round).
    const queue = (await (
      await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } })
    ).json()) as { assignments: Array<{ id: string; plan_id: string; plan_name: string }>; criteria: Record<string, unknown[]> };
    const mine = queue.assignments.filter((a) => [planA, planB].includes(a.plan_id));
    expect(mine.length).toBe(2);
    expect(new Set(mine.map((a) => a.plan_id)).size).toBe(2);
    // Each plan's own scorecard travels with it.
    expect((queue.criteria[planA] ?? []).length).toBeGreaterThan(0);
    expect((queue.criteria[planB] ?? []).length).toBeGreaterThan(0);

    // Both are scorable, independently.
    for (const planId of [planA, planB]) {
      const assignment = rows.find((r) => r.plan_id === planId)!;
      const criterion = await env.DB
        .prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?')
        .bind(planId)
        .first<{ id: string }>();
      const save = await SELF.fetch(
        `${base}/review/assignments/${assignment.id}`,
        jsonReq(reviewer.cookie, { scores: { [criterion!.id]: 4 }, comment: `scored in ${planId}` }),
      );
      expect(save.status).toBe(200);
    }

    // Two independent reviews rows exist — the second round did not overwrite
    // the first.
    const reviews = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM reviews WHERE submission_id = ? AND reviewer_contact_id = ?')
      .bind(submissionId, reviewer.contactId)
      .first<{ n: number }>();
    expect(reviews?.n).toBe(2);
  });
});
