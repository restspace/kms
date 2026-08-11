// Workplan 13 W2: the coverage sort and worklist. "Sort by fewest ratings
// first" is half of what the doc calls the whole review UI — review_count was
// computed in the submissions selectSql but absent from `sortable`, and the
// min_reviews/max_reviews pair makes "everything with fewer than two reads" a
// filter, not just a sort.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

interface QueryResponse {
  items: Array<Record<string, unknown>>;
  total: number;
}

const query = async (cookie: string, body: Record<string, unknown>) => {
  const res = await SELF.fetch('https://example.com/app/api/submissions/query', jsonReq(cookie, body));
  expect(res.status).toBe(200);
  return (await res.json()) as QueryResponse;
};

/** One event with submissions carrying 0, 1 and 2 reviews. */
async function seedCoverage() {
  const eventId = await seedEvent();
  const admin = await seedStaff(eventId, 'admin');
  const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
  ).bind(planId, eventId, ts).run();

  const none = await seedSubmission(eventId, { code: 'SESS-ZERO' });
  const one = await seedSubmission(eventId, { code: 'SESS-ONE' });
  const two = await seedSubmission(eventId, { code: 'SESS-TWO' });
  for (const [submissionId, count] of [[one, 1], [two, 2]] as const) {
    for (let i = 0; i < count; i++) {
      const reviewer = await seedContact(eventId);
      await env.DB.prepare(
        `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, conflict_of_interest, created_at)
         VALUES (?, ?, ?, ?, '{}', 4, 0, ?)`,
      ).bind(`rev-${crypto.randomUUID()}`, submissionId, reviewer, planId, ts).run();
    }
  }
  return { eventId, admin, none, one, two };
}

describe('submissions review coverage (W2)', () => {
  it('sorting review_count ascending puts the zero-review submission first, as 0 and not NULL', async () => {
    const { admin } = await seedCoverage();
    const body = await query(admin.cookie, {
      size: 10,
      filters: {},
      sort: { field: 'review_count', direction: 'asc' },
    });
    expect(body.items.map((r) => r.code)).toEqual(['SESS-ZERO', 'SESS-ONE', 'SESS-TWO']);
    // COUNT(*) is never NULL — the NULL-last ordering wrapper must not bury it.
    expect(body.items[0]!.review_count).toBe(0);
  });

  it('min_reviews / max_reviews split the event, and their totals agree with the coverage bar arithmetic', async () => {
    const { admin, two } = await seedCoverage();
    const all = await query(admin.cookie, { size: 10, filters: {} });
    const covered = await query(admin.cookie, { size: 10, filters: { min_reviews: 2 } });
    const worklist = await query(admin.cookie, { size: 10, filters: { max_reviews: 1 } });

    expect(covered.items.map((r) => r.id)).toEqual([two]);
    expect(worklist.items.map((r) => r.code).sort()).toEqual(['SESS-ONE', 'SESS-ZERO']);
    // The bar's "n of m" and the filtered list come from the same filter, so
    // the split must be exact: covered + under-covered = everything.
    expect(covered.total + worklist.total).toBe(all.total);
  });
});
