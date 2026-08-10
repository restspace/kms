// Lane P1 — "recorded reviews are invisible to organisers".
//
// The regression this file pins: a reviewer saves a rating + comment (the
// evaluation dashboard duly shows 1/1 done), but the organiser's submission
// detail still reads "No reviews yet" and the grid's Ratings column is blank.
//
// The reviews the organiser sees were filtered by `r.plan_id =
// submissions.evaluation_plan_id` — the *legacy routing* column, which since
// 0012 is only one of two ways a submission belongs to a round. A submission
// routed to plan A by a form rule and then put into round B by an organiser
// keeps evaluation_plan_id = A, so every review recorded in B was filtered
// out of the read even though it was written, aggregated and counted.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

interface DetailReview {
  weighted_total: number | null;
  comment: string | null;
  reviewer_name: string | null;
  plan_id?: string;
  plan_name?: string | null;
}

/** Plan + one criterion + membership + a reviewer holding an assignment. */
async function seedRound(options: { extraPlanFirst?: boolean } = {}) {
  const eventId = await seedEvent();
  const admin = await seedStaff(eventId, 'admin');
  const reviewer = await seedStaff(eventId, 'reviewer');
  await env.DB.prepare('UPDATE contacts SET first_name = ?, last_name = ? WHERE id = ?')
    .bind('Sam', 'Whitfield', reviewer.contactId)
    .run();
  const submissionId = await seedSubmission(eventId, { title: 'A talk' });

  // The scenario that broke: the submission is already routed to an earlier
  // plan, so `submissions.evaluation_plan_id` does not point at the round the
  // review is recorded in.
  if (options.extraPlanFirst) {
    const first = (await (
      await SELF.fetch(`${base}/evaluation/plans`, jsonReq(admin.cookie, { name: 'Screening' }))
    ).json()) as { id: string };
    await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ? WHERE id = ?')
      .bind(first.id, submissionId)
      .run();
  }

  const planId = ((await (
    await SELF.fetch(`${base}/evaluation/plans`, jsonReq(admin.cookie, { name: 'Round 1' }))
  ).json()) as { id: string }).id;
  await SELF.fetch(`${base}/evaluation/plans/${planId}/criteria`, jsonReq(admin.cookie, { name: 'Relevance', weight: 1 }));
  await SELF.fetch(
    `${base}/evaluation/plans/${planId}/submissions`,
    jsonReq(admin.cookie, { mode: 'add', submission_ids: [submissionId] }),
  );
  const assign = await SELF.fetch(
    `${base}/evaluation/plans/${planId}/assign`,
    jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
  );
  expect((await assign.json()) as { total_assignments: number }).toMatchObject({ total_assignments: 1 });

  const assignment = await env.DB
    .prepare('SELECT id FROM review_assignments WHERE plan_id = ? AND reviewer_contact_id = ?')
    .bind(planId, reviewer.contactId)
    .first<{ id: string }>();
  const criterion = await env.DB
    .prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?')
    .bind(planId)
    .first<{ id: string }>();

  return { eventId, admin, reviewer, submissionId, planId, assignmentId: assignment!.id, criterionId: criterion!.id };
}

const saveReview = (cookie: string, assignmentId: string, criterionId: string, body: Record<string, unknown> = {}) =>
  SELF.fetch(
    `${base}/review/assignments/${assignmentId}`,
    jsonReq(cookie, { scores: { [criterionId]: 4 }, comment: 'Strong, well-scoped talk.', ...body }),
  );

const detail = async (cookie: string, submissionId: string) => {
  const res = await SELF.fetch(`${base}/submissions/${submissionId}/detail`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { reviews: DetailReview[]; submission: Record<string, unknown> };
};

const gridRow = async (cookie: string, submissionId: string) => {
  const res = await SELF.fetch(`${base}/submissions/query`, jsonReq(cookie, { size: 50, filters: {} }));
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: Array<Record<string, unknown>> };
  return body.items.find((i) => i.id === submissionId);
};

describe('organiser visibility of recorded reviews', () => {
  it('shows the rating, comment and reviewer on the submission detail', async () => {
    const { admin, reviewer, submissionId, assignmentId, criterionId } = await seedRound();
    expect((await saveReview(reviewer.cookie, assignmentId, criterionId)).status).toBe(200);

    const { reviews } = await detail(admin.cookie, submissionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      weighted_total: 4,
      comment: 'Strong, well-scoped talk.',
      reviewer_name: 'Sam Whitfield',
    });
  });

  // The exact regression: the round the review lives in is not the submission's
  // legacy `evaluation_plan_id`.
  it('shows reviews recorded in a round the submission was added to later', async () => {
    const { admin, reviewer, submissionId, assignmentId, criterionId, planId } = await seedRound({ extraPlanFirst: true });
    expect((await saveReview(reviewer.cookie, assignmentId, criterionId)).status).toBe(200);

    const { reviews } = await detail(admin.cookie, submissionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({
      weighted_total: 4,
      comment: 'Strong, well-scoped talk.',
      reviewer_name: 'Sam Whitfield',
      plan_id: planId,
      plan_name: 'Round 1',
    });
  });

  it('feeds the grid Ratings column from every round the submission is in', async () => {
    const { admin, reviewer, submissionId, assignmentId, criterionId } = await seedRound({ extraPlanFirst: true });
    await saveReview(reviewer.cookie, assignmentId, criterionId);

    const row = await gridRow(admin.cookie, submissionId);
    expect(row).toMatchObject({ rating: 4, review_count: 1 });
  });

  it('agrees with the evaluation overview workload counts', async () => {
    const { admin, reviewer, planId, assignmentId, criterionId } = await seedRound();
    await saveReview(reviewer.cookie, assignmentId, criterionId);

    const overview = (await (
      await SELF.fetch(`${base}/evaluation/overview`, { headers: { cookie: admin.cookie } })
    ).json()) as {
      stats: Array<{ plan_id: string; assignments: number; completed: number }>;
      workload: Array<{ plan_id: string; contact_id: string; assigned: number; completed: number }>;
    };
    expect(overview.stats.find((s) => s.plan_id === planId)).toMatchObject({ assignments: 1, completed: 1 });
    expect(overview.workload.find((w) => w.plan_id === planId)).toMatchObject({
      contact_id: reviewer.contactId, assigned: 1, completed: 1,
    });
  });

  it('keeps a conflict-of-interest declaration visible with no score', async () => {
    const { admin, reviewer, submissionId, assignmentId, criterionId } = await seedRound();
    await saveReview(reviewer.cookie, assignmentId, criterionId, {
      conflict_of_interest: true, comment: 'I work with the speaker.',
    });

    const { reviews } = await detail(admin.cookie, submissionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ conflict_of_interest: 1, weighted_total: null });
  });

  // Anonymisation hides *submitters from reviewers*; it must never hide
  // reviewers' scores from the organiser reading the detail.
  it('is unaffected by an anonymised round', async () => {
    const { admin, reviewer, submissionId, assignmentId, criterionId, planId } = await seedRound();
    await SELF.fetch(`${base}/evaluation/plans/${planId}`, jsonReq(admin.cookie, { anonymise_submitters: true }, 'PUT'));
    await saveReview(reviewer.cookie, assignmentId, criterionId);

    const { reviews } = await detail(admin.cookie, submissionId);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.reviewer_name).toBe('Sam Whitfield');
  });
});
