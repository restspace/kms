// ABS-06 — per-reviewer cap on a round (evaluation_plan_reviewers.max_assignments,
// NULL = uncapped), and ABS-05 — the assign-to-selected submission_ids scope
// that was already accepted server-side but never reachable from the UI.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

async function makePlan(cookie: string, name = 'Round 1'): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, { name }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function addAll(cookie: string, planId: string) {
  const res = await SELF.fetch(
    `${base}/evaluation/plans/${planId}/submissions`,
    jsonReq(cookie, { mode: 'add', filter: {} }),
  );
  expect(res.status).toBe(200);
}

const setCap = (cookie: string, planId: string, contactId: string, max: number | null) =>
  SELF.fetch(
    `${base}/evaluation/plans/${planId}/reviewers`,
    jsonReq(cookie, { contact_id: contactId, max_assignments: max }),
  );

const assignmentsFor = async (planId: string): Promise<Array<{ submission_id: string; reviewer_contact_id: string }>> => {
  const { results } = await env.DB
    .prepare('SELECT submission_id, reviewer_contact_id FROM review_assignments WHERE plan_id = ?')
    .bind(planId)
    .all<{ submission_id: string; reviewer_contact_id: string }>();
  return results;
};

describe('reviewer caps (ABS-06)', () => {
  it('pool POST sets and updates a cap, and rejects an invalid one', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const planId = await makePlan(admin.cookie);

    const set = await setCap(admin.cookie, planId, reviewer.contactId, 3);
    expect(set.status).toBe(201);
    expect((await set.json()) as { max_assignments: number | null }).toMatchObject({ max_assignments: 3 });

    const updated = await setCap(admin.cookie, planId, reviewer.contactId, 5);
    expect((await updated.json()) as { max_assignments: number | null }).toMatchObject({ max_assignments: 5 });

    const cleared = await setCap(admin.cookie, planId, reviewer.contactId, null);
    expect((await cleared.json()) as { max_assignments: number | null }).toMatchObject({ max_assignments: null });

    const invalid = await setCap(admin.cookie, planId, reviewer.contactId, 0);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { error: string }).toMatchObject({ error: 'invalid_max_assignments' });
  });

  it('a plain pool-add (no cap in the body) leaves an existing cap untouched', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const planId = await makePlan(admin.cookie);
    await setCap(admin.cookie, planId, reviewer.contactId, 2);

    const plain = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/reviewers`,
      jsonReq(admin.cookie, { contact_id: reviewer.contactId }),
    );
    expect(plain.status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT max_assignments FROM evaluation_plan_reviewers WHERE plan_id = ? AND contact_id = ?',
    ).bind(planId, reviewer.contactId).first<{ max_assignments: number | null }>();
    expect(row?.max_assignments).toBe(2);
  });

  it("'all' strategy respects a cap: a capped reviewer stops receiving new submissions once at capacity", async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const capped = await seedStaff(eventId, 'reviewer');
    const uncapped = await seedStaff(eventId, 'reviewer');
    for (let i = 0; i < 3; i += 1) await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);
    await setCap(admin.cookie, planId, capped.contactId, 1);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [capped.contactId, uncapped.contactId], strategy: 'all' }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { unassigned: Array<{ submission_id: string; short: number }> };

    const rows = await assignmentsFor(planId);
    expect(rows.filter((r) => r.reviewer_contact_id === capped.contactId).length).toBe(1);
    expect(rows.filter((r) => r.reviewer_contact_id === uncapped.contactId).length).toBe(3);
    // 2 submissions only got the uncapped reviewer — one short each.
    expect(body.unassigned.length).toBe(2);
    expect(body.unassigned.every((u) => u.short === 1)).toBe(true);
  });

  it('round_robin skips a capped reviewer once they are full', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const capped = await seedStaff(eventId, 'reviewer');
    const others = [await seedStaff(eventId, 'reviewer'), await seedStaff(eventId, 'reviewer')];
    for (let i = 0; i < 6; i += 1) await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);
    await setCap(admin.cookie, planId, capped.contactId, 1);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, {
        reviewer_contact_ids: [capped.contactId, ...others.map((o) => o.contactId)],
        strategy: 'round_robin',
        per_submission: 1,
      }),
    );
    expect(res.status).toBe(200);
    const rows = await assignmentsFor(planId);
    expect(rows.filter((r) => r.reviewer_contact_id === capped.contactId).length).toBe(1);
    // Every submission still got exactly one reviewer — the rotation moved on
    // to an uncapped reviewer instead of stalling.
    const bySubmission = new Map<string, number>();
    for (const r of rows) bySubmission.set(r.submission_id, (bySubmission.get(r.submission_id) ?? 0) + 1);
    expect([...bySubmission.values()].every((n) => n === 1)).toBe(true);
    expect(rows.length).toBe(6);
  });

  it('a re-run does not double-count existing pairs against the cap', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    await seedSubmission(eventId);
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);
    await setCap(admin.cookie, planId, reviewer.contactId, 1);

    const first = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    expect((await first.json()) as { created: number }).toMatchObject({ created: 1 });

    // Re-running must not report the existing pair as consuming capacity a
    // second time, and must not create a duplicate.
    const second = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, { reviewer_contact_ids: [reviewer.contactId], strategy: 'all' }),
    );
    const body = (await second.json()) as { created: number; unassigned: unknown[] };
    expect(body.created).toBe(0);
    expect(body.unassigned).toEqual([]);
    expect((await assignmentsFor(planId)).length).toBe(1);
  });

  it('scopes Assign to submission_ids — the reviewer queue lists exactly those (ABS-05)', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const s1 = await seedSubmission(eventId, { code: 'SESS-A' });
    const s2 = await seedSubmission(eventId, { code: 'SESS-B' });
    const s3 = await seedSubmission(eventId, { code: 'SESS-C' });
    const planId = await makePlan(admin.cookie);
    await addAll(admin.cookie, planId);

    const res = await SELF.fetch(
      `${base}/evaluation/plans/${planId}/assign`,
      jsonReq(admin.cookie, {
        reviewer_contact_ids: [reviewer.contactId],
        strategy: 'all',
        submission_ids: [s1, s2],
      }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as { submissions: number }).toMatchObject({ submissions: 2 });

    const queue = (await (
      await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } })
    ).json()) as { assignments: Array<{ submission_id: string }> };
    const submissionIds = queue.assignments.map((a) => a.submission_id).sort();
    expect(submissionIds).toEqual([s1, s2].sort());
    expect(submissionIds).not.toContain(s3);
  });
});
