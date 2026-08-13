// Workplan 15 W7 (D11) — GET /review/queue attaches last year's attendee
// rating to each assignment as read-only display data: a chip for a human to
// weigh out loud, never folded into any score. Org-scoped contacts (0015)
// make "an earlier event's event_contacts row for this speaker" a single join.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

// A new plan defaults to anonymise_submitters = 1 (ABS-07): identity and,
// with it, the prior-rating chip — a fact about a named person — are withheld
// the same way `participants` is. These tests are about the chip itself, not
// anonymisation, so every plan here is switched to a named round.
async function makePlan(cookie: string, name: string): Promise<string> {
  const res = await SELF.fetch(`${base}/evaluation/plans`, jsonReq(cookie, { name }));
  expect(res.status).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  const put = await SELF.fetch(`${base}/evaluation/plans/${id}`, jsonReq(cookie, { anonymise_submitters: false }, 'PUT'));
  expect(put.status).toBe(200);
  return id;
}

/** Assign `submissionId` to `planId` and to `reviewerContactId`, mirroring
 *  the multi-round-queue test's two-call sequence. */
async function routeAndAssign(adminCookie: string, planId: string, submissionId: string, reviewerContactId: string) {
  const add = await SELF.fetch(
    `${base}/evaluation/plans/${planId}/submissions`,
    jsonReq(adminCookie, { mode: 'add', submission_ids: [submissionId] }),
  );
  expect(add.status).toBe(200);
  const assign = await SELF.fetch(
    `${base}/evaluation/plans/${planId}/assign`,
    jsonReq(adminCookie, { reviewer_contact_ids: [reviewerContactId], strategy: 'all' }),
  );
  expect(assign.status).toBe(200);
}

async function addSpeaker(submissionId: string, contactId: string) {
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 1, 1)`,
  ).bind(`sp-${crypto.randomUUID().slice(0, 8)}`, submissionId, contactId).run();
}

async function fetchQueue(cookie: string) {
  const res = await SELF.fetch(`${base}/review/queue`, { headers: { cookie } });
  expect(res.status).toBe(200);
  return (await res.json()) as { assignments: Array<Record<string, unknown>> };
}

describe('GET /review/queue — prior_rating chip (W7, D11)', () => {
  it("a returning speaker's chip reads the earlier event's row, not the current one", async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const earlier = await seedEvent({ org_id: orgId, name: 'AIE 2025', starts_at: '2025-10-01T08:00:00Z', ends_at: '2025-10-02T18:00:00Z' });
    const current = await seedEvent({ org_id: orgId, name: 'AIE 2026', starts_at: '2026-10-01T08:00:00Z', ends_at: '2026-10-02T18:00:00Z' });
    const admin = await seedStaff(current, 'admin');
    const reviewer = await seedStaff(current, 'reviewer');

    // The same person spoke at both events. Last year's row carries the
    // imported feedback score; this year's (freshly seeded) row does not.
    const speaker = await seedContact(earlier, { email: 'returning@example.com', first_name: 'Grace', last_name: 'Hopper' });
    await env.DB.prepare(
      `UPDATE event_contacts SET prior_rating = 3.1, prior_rating_note = 'bottom quartile, n=41' WHERE event_id = ? AND contact_id = ?`,
    ).bind(earlier, speaker).run();
    await env.DB.prepare(
      `INSERT INTO event_contacts (event_id, contact_id, added_at, source) VALUES (?, ?, ?, 'admin')`,
    ).bind(current, speaker, '2026-08-01T00:00:00Z').run();

    const submissionId = await seedSubmission(current, { title: 'Returning talk' });
    await addSpeaker(submissionId, speaker);

    const planId = await makePlan(admin.cookie, 'Round 1');
    await routeAndAssign(admin.cookie, planId, submissionId, reviewer.contactId);

    const queue = await fetchQueue(reviewer.cookie);
    const mine = queue.assignments.find((a) => a.submission_id === submissionId);
    expect(mine).toBeTruthy();
    expect(mine!.prior_rating).toBe(3.1);
    expect(mine!.prior_rating_note).toBe('bottom quartile, n=41');
    expect(mine!.prior_rating_event_id).toBe(earlier);
    expect(mine!.prior_rating_event_name).toBe('AIE 2025');
  });

  it('a first-time speaker shows no chip', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedStaff(eventId, 'reviewer');
    const speaker = await seedContact(eventId, { email: 'newcomer@example.com', first_name: 'New', last_name: 'Comer' });
    const submissionId = await seedSubmission(eventId, { title: 'First talk ever' });
    await addSpeaker(submissionId, speaker);

    const planId = await makePlan(admin.cookie, 'Round 1');
    await routeAndAssign(admin.cookie, planId, submissionId, reviewer.contactId);

    const queue = await fetchQueue(reviewer.cookie);
    const mine = queue.assignments.find((a) => a.submission_id === submissionId);
    expect(mine).toBeTruthy();
    expect(mine!.prior_rating).toBeUndefined();
    expect(mine!.prior_rating_event_name).toBeUndefined();
  });

  it('never enters rating_cache or any aggregate — reading the queue and scoring leave rating_cache untouched by the prior rating', async () => {
    const orgId = `org-${crypto.randomUUID()}`;
    const earlier = await seedEvent({ org_id: orgId, name: 'AIE 2025', starts_at: '2025-10-01T08:00:00Z', ends_at: '2025-10-02T18:00:00Z' });
    const current = await seedEvent({ org_id: orgId, name: 'AIE 2026', starts_at: '2026-10-01T08:00:00Z', ends_at: '2026-10-02T18:00:00Z' });
    const admin = await seedStaff(current, 'admin');
    const reviewer = await seedStaff(current, 'reviewer');
    const speaker = await seedContact(earlier, { email: 'veto-case@example.com', first_name: 'Vera', last_name: 'Case' });
    await env.DB.prepare(
      `UPDATE event_contacts SET prior_rating = 1.2 WHERE event_id = ? AND contact_id = ?`,
    ).bind(earlier, speaker).run();
    const submissionId = await seedSubmission(current, { title: 'Vetoed on paper' });
    await addSpeaker(submissionId, speaker);

    const planId = await makePlan(admin.cookie, 'Round 1');
    await routeAndAssign(admin.cookie, planId, submissionId, reviewer.contactId);
    const queue = await fetchQueue(reviewer.cookie);
    const mine = queue.assignments.find((a) => a.submission_id === submissionId)!;
    expect(mine.prior_rating).toBe(1.2);

    // A real review is scored and saved, exercising the code path that writes
    // rating_cache (evaluation.ts's ratingCacheStatement / AVG(weighted_total)).
    const criterion = await env.DB.prepare('SELECT id FROM scoring_criteria WHERE plan_id = ?').bind(planId).first<{ id: string }>();
    const save = await SELF.fetch(
      `${base}/review/assignments/${mine.id as string}`,
      jsonReq(reviewer.cookie, { scores: { [criterion!.id]: 5 }, comment: 'strong regardless' }),
    );
    expect(save.status).toBe(200);

    const row = await env.DB.prepare('SELECT rating_cache FROM submissions WHERE id = ?').bind(submissionId).first<{ rating_cache: string | null }>();
    expect(row?.rating_cache).toBeTruthy();
    // 1.2 (the prior rating) must never appear as a value inside the cache —
    // only the weighted_total this reviewer actually scored (5).
    const cache = JSON.parse(row!.rating_cache!) as Record<string, number>;
    expect(Object.values(cache)).not.toContain(1.2);
    expect(Object.values(cache)).toContain(5);
  });
});
