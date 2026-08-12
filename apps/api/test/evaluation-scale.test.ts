// ABS-01 — per-round scoring scale. The reviewer UI (ReviewerWorkspace) and
// the review-save clamp (POST /review/assignments/:id) already build off
// evaluation_plans.scoring_scale_min/max; this file pins the write path: the
// PUT /evaluation/plans/:id branch that changes the scale, its validation,
// the once-reviews-exist lock, POST /evaluation/plans create-with-scale, and
// that a save against a non-default (0-10) plan actually clamps to it.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function makePlan(cookie: string, body: Record<string, unknown> = { name: 'Round 1' }): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, body));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

describe('evaluation plan scoring scale (ABS-01)', () => {
  it('persists a scale change and echoes the stored row', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { scoring_scale_min: 0, scoring_scale_max: 10 }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { plan: { scoring_scale_min: number; scoring_scale_max: number } };
    expect(body.plan).toMatchObject({ scoring_scale_min: 0, scoring_scale_max: 10 });

    const stored = await env.DB.prepare(
      'SELECT scoring_scale_min, scoring_scale_max FROM evaluation_plans WHERE id = ?',
    ).bind(planId).first<{ scoring_scale_min: number; scoring_scale_max: number }>();
    expect(stored).toMatchObject({ scoring_scale_min: 0, scoring_scale_max: 10 });
  });

  it('changing only the max keeps the current min', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { scoring_scale_max: 7 }, 'PUT'),
    );
    expect(res.status).toBe(200);
    const stored = await env.DB.prepare(
      'SELECT scoring_scale_min, scoring_scale_max FROM evaluation_plans WHERE id = ?',
    ).bind(planId).first<{ scoring_scale_min: number; scoring_scale_max: number }>();
    expect(stored).toMatchObject({ scoring_scale_min: 1, scoring_scale_max: 7 });
  });

  it.each([
    ['min >= max', { scoring_scale_min: 5, scoring_scale_max: 5 }],
    ['span over 19', { scoring_scale_min: 0, scoring_scale_max: 20 }],
    ['non-integer', { scoring_scale_min: 1.5, scoring_scale_max: 5 }],
    ['negative min', { scoring_scale_min: -1, scoring_scale_max: 5 }],
  ])('rejects an invalid scale on PUT: %s', async (_label, patch) => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie);

    const res = await SELF.fetch(`${base}/evaluation/plans/${planId}`, jsonReq(admin.cookie, patch, 'PUT'));
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_scale' });
  });

  it('refuses to change the scale once a review has been recorded', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/submissions`,
      jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    const criterion = await env.DB.prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    const assignment = await env.DB.prepare('SELECT id FROM review_assignments WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    const save = await SELF.fetch(
      `${base}/review/assignments/${assignment!.id}`,
      jsonReq(reviewer.cookie, { scores: { [criterion!.id]: 4 } }),
    );
    expect(save.status).toBe(200);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { scoring_scale_max: 10 }, 'PUT'),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'scale_locked_reviews_exist' });

    // Unchanged in storage.
    const stored = await env.DB.prepare('SELECT scoring_scale_max FROM evaluation_plans WHERE id = ?')
      .bind(planId)
      .first<{ scoring_scale_max: number }>();
    expect(stored?.scoring_scale_max).toBe(5);
  });

  it('accepts a redundant PUT of the current scale even once reviews exist (no actual change, no lock)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/submissions`,
      jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    const criterion = await env.DB.prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    const assignment = await env.DB.prepare('SELECT id FROM review_assignments WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    await SELF.fetch(
      `${base}/review/assignments/${assignment!.id}`,
      jsonReq(reviewer.cookie, { scores: { [criterion!.id]: 4 } }),
    );

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}`,
      jsonReq(admin.cookie, { scoring_scale_min: 1, scoring_scale_max: 5, name: 'Round 1 renamed' }, 'PUT'),
    );
    expect(res.status).toBe(200);
  });

  it('creates a plan with a custom scale', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie, { name: 'Ten-point', scoring_scale_min: 0, scoring_scale_max: 10 });
    const stored = await env.DB.prepare(
      'SELECT scoring_scale_min, scoring_scale_max FROM evaluation_plans WHERE id = ?',
    ).bind(planId).first<{ scoring_scale_min: number; scoring_scale_max: number }>();
    expect(stored).toMatchObject({ scoring_scale_min: 0, scoring_scale_max: 10 });
  });

  it('rejects an invalid scale on create', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const res = await SELF.fetch(
      `${base}/evaluation/plans`,
      jsonReq(admin.cookie, { name: 'Bad', scoring_scale_min: 5, scoring_scale_max: 5 }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'invalid_scale' });
  });

  it('a review save clamps to a non-default (0-10) plan scale', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie, { name: 'Ten-point', scoring_scale_min: 0, scoring_scale_max: 10 });
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/submissions`,
      jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    const criterion = await env.DB.prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    const assignment = await env.DB.prepare('SELECT id FROM review_assignments WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();

    // Above the max — must clamp to 10, not be rejected or stored raw.
    const res = await SELF.fetch(
      `${base}/review/assignments/${assignment!.id}`,
      jsonReq(reviewer.cookie, { scores: { [criterion!.id]: 15 } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { weighted_total: number };
    expect(body.weighted_total).toBe(10);
  });
});
