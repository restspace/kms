// GET /app/api/evaluation/overview (lane W1-C, eval defect F3): the admin
// Evaluation section sat on a permanent "Loading…" screen, so the contract this
// covers is "always four arrays, 200, even with nothing configured".

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const overview = (cookie: string) =>
  SELF.fetch('https://example.com/app/api/evaluation/overview', { headers: { cookie } });

describe('GET /app/api/evaluation/overview', () => {
  it('answers a brand-new event with empty arrays, not an error', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const res = await overview(admin.cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as Record<string, unknown[]>;
    expect(body.plans).toEqual([]);
    expect(body.criteria).toEqual([]);
    expect(body.stats).toEqual([]);
    // The signed-in admin is themselves an eligible reviewer.
    expect(Array.isArray(body.reviewers)).toBe(true);
  });

  it('reports plans, criteria and progress once a plan is configured', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);

    const created = await SELF.fetch(
      'https://example.com/app/api/evaluation/plans',
      jsonReq(admin.cookie, { name: 'Round 1' }),
    );
    expect(created.status).toBe(201);
    const { id: planId } = (await created.json()) as { id: string };

    await SELF.fetch(
      `https://example.com/app/api/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Relevance', weight: 2 }),
    );
    await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ? WHERE id = ?')
      .bind(planId, submissionId)
      .run();

    const body = (await (await overview(admin.cookie)).json()) as {
      plans: Array<{ id: string; name: string; status: string }>;
      criteria: Array<{ plan_id: string; name: string; weight: number }>;
      stats: Array<{ plan_id: string; submissions: number; assignments: number; completed: number }>;
    };

    expect(body.plans.find((p) => p.id === planId)?.name).toBe('Round 1');
    // A new plan is seeded with one default 'Overall' criterion (a plan with
    // none renders an unsaveable scorecard), so the explicitly added one joins
    // it rather than being the only row.
    expect(body.criteria.filter((c) => c.plan_id === planId)).toEqual([
      expect.objectContaining({ name: 'Overall', weight: 1 }),
      expect.objectContaining({ name: 'Relevance', weight: 2 }),
    ]);
    expect(body.stats.find((s) => s.plan_id === planId)).toMatchObject({
      submissions: 1,
      assignments: 0,
      completed: 0,
    });
  });

  it('a new plan is usable immediately: one default criterion, zeroed stats', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const created = await SELF.fetch(
      'https://example.com/app/api/evaluation/plans',
      jsonReq(admin.cookie, { name: 'Empty round' }),
    );
    const { id: planId } = (await created.json()) as { id: string };

    const body = (await (await overview(admin.cookie)).json()) as {
      criteria: Array<{ plan_id: string }>;
      stats: Array<{ plan_id: string; submissions: number; assignments: number; completed: number }>;
    };
    // Not empty: a brand-new plan whose scorecard has nothing to score cannot
    // be saved by a reviewer at all, so creation seeds a single weight-1
    // 'Overall' criterion that the organiser can rename or replace.
    expect(body.criteria.filter((c) => c.plan_id === planId)).toEqual([
      expect.objectContaining({ name: 'Overall', weight: 1 }),
    ]);
    expect(body.stats.find((s) => s.plan_id === planId)).toMatchObject({
      submissions: 0, assignments: 0, completed: 0,
    });
  });
});
