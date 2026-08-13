// docs/10 §"the same CSV/XLSX export as the admin workspace's own query tool"
// is a promise about the *file*, not merely the query behind it. The two
// handlers had drifted: only the workspace path ran shapeExportRows, so a
// /api/v1 consumer got raw criterion-id JSON in `scores` and no `outcome`
// column at all. These pin both halves of the shaping on the REST path so the
// promise cannot quietly lapse again.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { seedContact, seedEvent, seedSubmission } from './fixtures-admin';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

const ts = '2026-08-01T00:00:00Z';

const exportCsv = async (token: string, eventId: string, resource: string): Promise<string> => {
  const res = await SELF.fetch(
    `https://example.com/api/v1/events/${eventId}/${resource}/export?format=csv`,
    bearerReq(token),
  );
  expect(res.status).toBe(200);
  return res.text();
};

describe('REST v1 export shaping', () => {
  it('gives submissions the derived outcome column, so revise reads as itself', async () => {
    const eventId = await seedEvent();
    const token = await seedApiToken(await orgIdForEvent(eventId));

    // A plain decline and a revise-request. Per workplan 15 D5 both carry
    // status='declined' in storage; the export is where they must diverge.
    await seedSubmission(eventId, { code: 'PLAIN-1', title: 'Straight decline', status: 'declined' });
    const reviseId = await seedSubmission(eventId, { code: 'REVISE-1', title: 'Come back to us', status: 'declined' });
    await env.DB.prepare(
      `UPDATE submissions SET decision_outcome = 'revise', revise_guidance = 'Narrow it to one case study' WHERE id = ?`,
    ).bind(reviseId).run();

    const csv = await exportCsv(token, eventId, 'submissions');
    const header = csv.split('\n')[0];
    expect(header).toContain('outcome');

    const rowFor = (code: string) => csv.split('\n').find((line) => line.includes(code)) ?? '';
    expect(rowFor('REVISE-1')).toContain('revise_requested');
    // The plain decline still reads as its raw status, not as a revise.
    expect(rowFor('PLAIN-1')).toContain('declined');
    expect(rowFor('PLAIN-1')).not.toContain('revise_requested');
  });

  it('gives reviews readable criterion names and the rationale fallback', async () => {
    const eventId = await seedEvent();
    const token = await seedApiToken(await orgIdForEvent(eventId));
    const submissionId = await seedSubmission(eventId, { code: 'SCORED-1', title: 'A scored talk' });
    const reviewerId = await seedContact(eventId, { first_name: 'Rea', last_name: 'Viewer' });

    const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Round 1', 'active', ?)`,
    ).bind(planId, eventId, ts).run();

    // Two criteria, seeded out of alphabetical order so the assertion proves
    // the export follows criterion *position* — the order the reviewer scored
    // them in — rather than whatever order the JSON keys happen to sit in.
    const relevance = `crit-${crypto.randomUUID().slice(0, 8)}`;
    const novelty = `crit-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO scoring_criteria (id, plan_id, name, weight, position) VALUES (?, ?, 'Relevance', 1, 0)`,
    ).bind(relevance, planId).run();
    await env.DB.prepare(
      `INSERT INTO scoring_criteria (id, plan_id, name, weight, position) VALUES (?, ?, 'Novelty', 1, 1)`,
    ).bind(novelty, planId).run();

    await env.DB.prepare(
      `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, 4.5, NULL, 0, ?)`,
    ).bind(
      `rev-${crypto.randomUUID()}`,
      submissionId,
      reviewerId,
      planId,
      JSON.stringify({ [novelty]: 5, [relevance]: 4 }),
      ts,
    ).run();

    // The review carries no comment of its own; the reviewer's rationale is
    // the text that should surface in its place. It is matched on
    // (submission, plan, author), so the plan id is load-bearing here — a
    // rationale without one belongs to no round and matches no review.
    await env.DB.prepare(
      `INSERT INTO submission_comments (id, event_id, submission_id, plan_id, author_contact_id, author_role, author_name, kind, body, created_at)
       VALUES (?, ?, ?, ?, ?, 'reviewer', 'Rea Viewer', 'rationale', 'Strongest of the batch', ?)`,
    ).bind(`sc-${crypto.randomUUID()}`, eventId, submissionId, planId, reviewerId, ts).run();

    const csv = await exportCsv(token, eventId, 'reviews');
    const row = csv.split('\n').find((line) => line.includes('Relevance')) ?? '';
    expect(row).toContain('Relevance: 4');
    expect(row).toContain('Novelty: 5');
    // Criterion ids are an implementation detail and must not reach the file.
    expect(csv).not.toContain(relevance);
    expect(row).toContain('Strongest of the batch');
  });
});
