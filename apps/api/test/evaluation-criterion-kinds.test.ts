// 0026 — criterion field types (2026-08-12 eval sweep, review area). The
// scorecard editor previously only expressed numeric scale criteria; this
// covers the new 'choice' (dropdown) and 'text' (long-text) kinds end to end:
// creation validation, the queue payload carrying kind/options, the save
// route's type-aware required/optional rules, and the numeric aggregate
// excluding non-score answers.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function seedRound() {
  const eventId = await seedEvent();
  const admin = await seedStaff(eventId, 'admin');
  const reviewer = await seedStaff(eventId, 'reviewer');
  const submissionId = await seedSubmission(eventId);
  const planRes = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(admin.cookie, { name: 'Typed round' }));
  const planId = ((await planRes.json()) as { id: string }).id;
  await SELF.fetch(
    `${base}/evaluation/plans/${planId}/submissions`,
    jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
  );
  return { eventId, admin, reviewer, submissionId, planId };
}

const criterionIds = async (planId: string) => {
  const { results } = await env.DB
    .prepare('SELECT id, name, kind, options, weight FROM scoring_criteria WHERE plan_id = ? ORDER BY position')
    .bind(planId)
    .all<{ id: string; name: string; kind: string; options: string | null; weight: number }>();
  return results;
};

describe('criterion kinds (0026)', () => {
  it('creates choice and text criteria, rejects a choice with fewer than two options', async () => {
    const { admin, planId } = await seedRound();

    const choice = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Recommended track', kind: 'choice', options: ['Keynote', 'Breakout', 'Lightning'] }),
    );
    expect(choice.status).toBe(201);
    const text = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Detailed feedback', kind: 'text' }),
    );
    expect(text.status).toBe(201);

    const bad = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Broken dropdown', kind: 'choice', options: ['only-one'] }),
    );
    expect(bad.status).toBe(400);
    expect((await bad.json()) as { error: string }).toMatchObject({ error: 'invalid_criterion_kind' });

    const rows = await criterionIds(planId);
    // Plan creation seeds one 'Overall' score criterion; then our two.
    expect(rows.map((r) => r.kind)).toEqual(['score', 'choice', 'text']);
    expect(JSON.parse(rows[1]!.options!)).toEqual(['Keynote', 'Breakout', 'Lightning']);
  });

  it('queue carries kind/options; save requires score+choice, keeps text optional, and aggregates only score rows', async () => {
    const { admin, reviewer, submissionId, planId } = await seedRound();
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Track fit', kind: 'choice', options: ['Yes', 'No'] }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Notes', kind: 'text' }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );

    const queue = (await (
      await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } })
    ).json()) as { assignments: Array<{ id: string; plan_id: string }>; criteria: Record<string, Array<{ id: string; kind: string; options: string | null }>> };
    const planCriteria = queue.criteria[planId]!;
    expect(planCriteria.map((c) => c.kind)).toEqual(['score', 'choice', 'text']);
    expect(planCriteria[1]!.options).toBe(JSON.stringify(['Yes', 'No']));

    const assignment = queue.assignments.find((a) => a.plan_id === planId)!;
    const [overall, choice, text] = await criterionIds(planId);

    // Missing the choice answer → still incomplete.
    const missing = await SELF.fetch(
      `${base}/review/assignments/${assignment.id}`,
      jsonReq(reviewer.cookie, { scores: { [overall!.id]: 4 } }),
    );
    expect(missing.status).toBe(400);
    expect((await missing.json()) as { error: string }).toMatchObject({ error: 'all_criteria_required' });

    // An answer outside the dropdown's options is refused.
    const badChoice = await SELF.fetch(
      `${base}/review/assignments/${assignment.id}`,
      jsonReq(reviewer.cookie, { scores: { [overall!.id]: 4, [choice!.id]: 'Maybe' } }),
    );
    expect(badChoice.status).toBe(400);
    expect((await badChoice.json()) as { error: string }).toMatchObject({ error: 'invalid_choice' });

    // Score + choice answered, text omitted → saves; the weighted total is the
    // score row alone (choice/text never join the numeric aggregate).
    const ok = await SELF.fetch(
      `${base}/review/assignments/${assignment.id}`,
      jsonReq(reviewer.cookie, { scores: { [overall!.id]: 4, [choice!.id]: 'Yes' } }),
    );
    expect(ok.status).toBe(200);
    expect((await ok.json()) as { weighted_total: number }).toMatchObject({ weighted_total: 4 });

    // And with the text answer included, it round-trips into reviews.scores.
    const withText = await SELF.fetch(
      `${base}/review/assignments/${assignment.id}`,
      jsonReq(reviewer.cookie, { scores: { [overall!.id]: 5, [choice!.id]: 'No', [text!.id]: 'Solid but long' } }),
    );
    expect(withText.status).toBe(200);
    expect((await withText.json()) as { weighted_total: number }).toMatchObject({ weighted_total: 5 });
    const stored = await env.DB
      .prepare('SELECT scores, weighted_total FROM reviews WHERE assignment_id = ?')
      .bind(assignment.id)
      .first<{ scores: string; weighted_total: number }>();
    expect(JSON.parse(stored!.scores)).toEqual({
      [overall!.id]: 5,
      [choice!.id]: 'No',
      [text!.id]: 'Solid but long',
    });
    expect(stored!.weighted_total).toBe(5);
    expect(submissionId).toBeTruthy();
  });

  it('a plan with only choice/text criteria saves with a null weighted_total', async () => {
    const { admin, reviewer, planId } = await seedRound();
    // Drop the seeded 'Overall' score criterion, leaving only non-numeric rows.
    const [overall] = await criterionIds(planId);
    await SELF.fetch(`${base}/evaluation/criteria/${overall!.id}`, {
      method: 'DELETE',
      headers: { cookie: admin.cookie },
    });
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/criteria`,
      jsonReq(admin.cookie, { name: 'Verdict', kind: 'choice', options: ['Accept', 'Reject'] }),
    );
    await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    const assignment = await env.DB
      .prepare('SELECT id FROM review_assignments WHERE plan_id = ?')
      .bind(planId)
      .first<{ id: string }>();
    const rows = await criterionIds(planId);
    const verdict = rows.find((r) => r.name === 'Verdict')!;

    const res = await SELF.fetch(
      `${base}/review/assignments/${assignment!.id}`,
      jsonReq(reviewer.cookie, { scores: { [verdict.id]: 'Accept' } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { weighted_total: number | null }).toMatchObject({ weighted_total: null });
  });
});
