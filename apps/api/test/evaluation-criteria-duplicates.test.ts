// Replay defects #1/#2 (workplan 17, eval-editor lane).
//
// #1 (cross-round criteria bleed) — the server half pinned here: a criterion
// POSTed to /evaluation/plans/:id/criteria must land on exactly the plan in
// the URL and leave every other round's scorecard untouched. (The client half
// — the just-created round's editor becoming the active criteria target — is
// covered in apps/admin/src/evaluation/EvaluationSection.test.tsx.)
//
// #2 (duplicate criterion names) — a second criterion whose name matches an
// existing one on the same scorecard (case-insensitive, trimmed) is refused
// with 409 duplicate_criterion_name, on create and on rename alike; the same
// name on a *different* round stays legal.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function makePlan(cookie: string, name: string): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const addCriterion = (cookie: string, planId: string, body: Record<string, unknown>) =>
  SELF.fetch(`${base}/evaluation/plans/${planId}/criteria`, jsonReq(cookie, body));

const criteriaOf = async (planId: string): Promise<Array<{ id: string; name: string }>> => {
  const { results } = await env.DB
    .prepare('SELECT id, name FROM scoring_criteria WHERE plan_id = ? ORDER BY position')
    .bind(planId)
    .all<{ id: string; name: string }>();
  return results;
};

describe('criteria attach to the plan in the URL (#1, server half)', () => {
  it('adding to the new round never touches the previous round', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const initial = await makePlan(admin.cookie, 'Initial Review');
    // Initial Review's scorecard: the seeded Overall plus a Comments field.
    await addCriterion(admin.cookie, initial, { name: 'Comments', kind: 'text' });
    const before = await criteriaOf(initial);

    const final = await makePlan(admin.cookie, 'Final Review');
    expect((await addCriterion(admin.cookie, final, { name: 'Final Score', weight: 2 })).status).toBe(201);
    expect((await addCriterion(admin.cookie, final, { name: 'Comments', kind: 'text' })).status).toBe(201);

    // Final Review got exactly what was posted to it (plus its seeded Overall)…
    expect((await criteriaOf(final)).map((c) => c.name)).toEqual(['Overall', 'Final Score', 'Comments']);
    // …and Initial Review's list is byte-for-byte what it was before.
    expect(await criteriaOf(initial)).toEqual(before);
  });
});

describe('duplicate criterion names on one scorecard (#2)', () => {
  it('refuses a duplicate on create, case-insensitively and ignoring whitespace', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie, 'Initial Review');
    expect((await addCriterion(admin.cookie, planId, { name: 'Comments', kind: 'text' })).status).toBe(201);

    for (const name of ['Comments', 'comments', '  COMMENTS  ']) {
      const res = await addCriterion(admin.cookie, planId, { name, kind: 'text' });
      expect(res.status).toBe(409);
      expect((await res.json()) as { error: string }).toEqual({ error: 'duplicate_criterion_name' });
    }
    // Nothing was inserted by the refused attempts.
    expect((await criteriaOf(planId)).filter((c) => c.name.toLowerCase() === 'comments')).toHaveLength(1);
  });

  it('the seeded Overall criterion counts too', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie, 'Round 1');
    const res = await addCriterion(admin.cookie, planId, { name: 'overall' });
    expect(res.status).toBe(409);
  });

  it('the same name on a different round is fine', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const a = await makePlan(admin.cookie, 'Initial Review');
    const b = await makePlan(admin.cookie, 'Final Review');
    expect((await addCriterion(admin.cookie, a, { name: 'Comments', kind: 'text' })).status).toBe(201);
    expect((await addCriterion(admin.cookie, b, { name: 'Comments', kind: 'text' })).status).toBe(201);
  });

  it('refuses a rename into a duplicate, but allows renaming to your own name', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await makePlan(admin.cookie, 'Round 1');
    expect((await addCriterion(admin.cookie, planId, { name: 'Clarity' })).status).toBe(201);
    const clarity = (await criteriaOf(planId)).find((c) => c.name === 'Clarity')!;

    const collide = await SELF.fetch(
      `${base}/evaluation/criteria/${clarity.id}`,
      jsonReq(admin.cookie, { name: 'overall' }, 'PUT'),
    );
    expect(collide.status).toBe(409);
    expect((await collide.json()) as { error: string }).toEqual({ error: 'duplicate_criterion_name' });

    // A case tweak of its own name is not a collision with itself.
    const own = await SELF.fetch(
      `${base}/evaluation/criteria/${clarity.id}`,
      jsonReq(admin.cookie, { name: 'CLARITY' }, 'PUT'),
    );
    expect(own.status).toBe(200);
    expect((await criteriaOf(planId)).find((c) => c.id === clarity.id)?.name).toBe('CLARITY');
  });
});
