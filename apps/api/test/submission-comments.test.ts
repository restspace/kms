// Workers tests for submission comment threads (workplan 7 §9): the
// organiser/reviewer discussion surface that replaces reviews.comment.
//
// Covers: round-trip through the detail payload, event scoping, the D3
// reviewer gate (pending/complete/closed-round), the rationale fold-in at
// score-save time, body validation, append-only (no PUT/DELETE routes), and
// backfill idempotence for migration 0017.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';
const ts = '2026-08-01T00:00:00Z';

async function seedPlan(eventId: string, overrides: Partial<{ id: string; status: string; opens_at: string | null; closes_at: string | null }> = {}): Promise<string> {
  const id = overrides.id ?? `plan-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, opens_at, closes_at, created_at)
     VALUES (?, ?, 'Plan', ?, ?, ?, ?)`,
  ).bind(id, eventId, overrides.status ?? 'active', overrides.opens_at ?? null, overrides.closes_at ?? null, ts).run();
  return id;
}

async function seedCriterion(planId: string, weight = 1): Promise<string> {
  const id = `crit-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO scoring_criteria (id, plan_id, name, weight, position) VALUES (?, ?, 'Quality', ?, 0)`,
  ).bind(id, planId, weight).run();
  return id;
}

async function seedAssignment(planId: string, submissionId: string, reviewerId: string, status = 'pending'): Promise<string> {
  const id = `ra-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, planId, submissionId, reviewerId, status, ts).run();
  return id;
}

interface DetailComment {
  id: string;
  author_role: string;
  author_name: string | null;
  kind: string;
  body: string;
}

const detail = (cookie: string, submissionId: string) =>
  SELF.fetch(`${base}/submissions/${submissionId}/detail`, { headers: { cookie } });

describe('submission comment threads (workplan 7)', () => {
  it('round-trips: an admin post appears on the submission detail thread', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId);

    const post = await SELF.fetch(
      `${base}/submissions/${submissionId}/comments`,
      jsonReq(admin.cookie, { body: 'Looks strong, let\'s accept.' }),
    );
    expect(post.status).toBe(200);
    const postBody = (await post.json()) as { ok: boolean; id: string; comments: DetailComment[] };
    expect(postBody.ok).toBe(true);
    expect(postBody.comments).toHaveLength(1);

    const res = await detail(admin.cookie, submissionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { comments: DetailComment[] };
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]).toMatchObject({
      author_role: 'admin',
      kind: 'discussion',
      body: "Looks strong, let's accept.",
    });
  });

  describe('event scoping', () => {
    it('a comment on event A\'s submission is invisible to an event B session, and B cannot post to it', async () => {
      const eventA = await seedEvent();
      const eventB = await seedEvent();
      const adminA = await seedStaff(eventA, 'admin');
      const adminB = await seedStaff(eventB, 'admin');
      const submissionA = await seedSubmission(eventA);

      const post = await SELF.fetch(
        `${base}/submissions/${submissionA}/comments`,
        jsonReq(adminA.cookie, { body: 'Event A only.' }),
      );
      expect(post.status).toBe(200);

      const crossDetail = await detail(adminB.cookie, submissionA);
      expect(crossDetail.status).toBe(404);

      const crossPost = await SELF.fetch(
        `${base}/submissions/${submissionA}/comments`,
        jsonReq(adminB.cookie, { body: 'Trying to post from B.' }),
      );
      expect(crossPost.status).toBe(404);
    });
  });

  describe('reviewer gate (D3)', () => {
    it('pending assignment -> 403 on GET and POST; after score save -> 200 with rows', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const criterion = await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);

      const getPending = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie: reviewer.cookie } });
      expect(getPending.status).toBe(403);
      expect(await getPending.json()).toEqual({ error: 'review_not_submitted' });

      const postPending = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}/comments`,
        jsonReq(reviewer.cookie, { body: 'Trying to discuss early.' }),
      );
      expect(postPending.status).toBe(403);
      expect(await postPending.json()).toEqual({ error: 'review_not_submitted' });

      const save = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}`,
        jsonReq(reviewer.cookie, { scores: { [criterion]: 4 }, comment: 'My rationale.' }),
      );
      expect(save.status).toBe(200);

      const getAfter = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie: reviewer.cookie } });
      expect(getAfter.status).toBe(200);
      const afterBody = (await getAfter.json()) as { comments: DetailComment[] };
      expect(afterBody.comments.length).toBeGreaterThan(0);
    });

    it('a closed round opens the thread even while the assignment is still pending', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      // Round closed in the past.
      const plan = await seedPlan(eventId, { closes_at: '2020-01-01T00:00:00Z' });
      await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);

      const res = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie: reviewer.cookie } });
      expect(res.status).toBe(200);
    });

    it('a plan closed by status also opens the thread for a still-pending reviewer', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId, { status: 'closed' });
      await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);

      const res = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie: reviewer.cookie } });
      expect(res.status).toBe(200);
    });

    it('an assignment id belonging to a different reviewer is a 404, not a 403', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const other = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);

      const res = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie: other.cookie } });
      expect(res.status).toBe(404);

      const postRes = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}/comments`,
        jsonReq(other.cookie, { body: 'Not my assignment.' }),
      );
      expect(postRes.status).toBe(404);
    });
  });

  describe('rationale fold-in at score-save time', () => {
    it('appends exactly one rationale row per distinct text, is a no-op on an identical re-save, and never writes reviews.comment', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const criterion = await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);

      const save = (score: number, comment: string) =>
        SELF.fetch(
          `${base}/review/assignments/${assignmentId}`,
          jsonReq(reviewer.cookie, { scores: { [criterion]: score }, comment }),
        );

      expect((await save(4, 'X')).status).toBe(200);
      let rationale = await env.DB.prepare(
        `SELECT id, body FROM submission_comments WHERE assignment_id = ? AND kind = 'rationale'`,
      ).bind(assignmentId).all<{ id: string; body: string }>();
      expect(rationale.results).toHaveLength(1);
      expect(rationale.results[0]!.body).toBe('X');

      // Re-save with identical rationale text: no new row.
      expect((await save(4, 'X')).status).toBe(200);
      rationale = await env.DB.prepare(
        `SELECT id, body FROM submission_comments WHERE assignment_id = ? AND kind = 'rationale'`,
      ).bind(assignmentId).all<{ id: string; body: string }>();
      expect(rationale.results).toHaveLength(1);

      // Re-save with changed text: a second row appears.
      expect((await save(5, 'Y')).status).toBe(200);
      rationale = await env.DB.prepare(
        `SELECT id, body FROM submission_comments WHERE assignment_id = ? AND kind = 'rationale' ORDER BY created_at, id`,
      ).bind(assignmentId).all<{ id: string; body: string }>();
      expect(rationale.results).toHaveLength(2);
      expect(rationale.results.map((r) => r.body)).toEqual(['X', 'Y']);

      // Review queue's my_comment reads the latest rationale.
      const queue = await SELF.fetch(`${base}/review/queue`, { headers: { cookie: reviewer.cookie } });
      expect(queue.status).toBe(200);
      const queueBody = (await queue.json()) as { assignments: Array<{ id: string; my_comment: string | null }> };
      const mine = queueBody.assignments.find((a) => a.id === assignmentId);
      expect(mine?.my_comment).toBe('Y');

      // reviews.comment stays NULL — the column is deprecated, not written.
      const reviewRow = await env.DB.prepare('SELECT comment FROM reviews WHERE assignment_id = ?')
        .bind(assignmentId)
        .first<{ comment: string | null }>();
      expect(reviewRow?.comment).toBeNull();
    });
  });

  describe('body validation', () => {
    it('rejects a whitespace-only body with 400 empty_body on both the admin and reviewer routes', async () => {
      const eventId = await seedEvent();
      const admin = await seedStaff(eventId, 'admin');
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const criterion = await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);
      // Get the reviewer past the D3 gate first.
      await SELF.fetch(
        `${base}/review/assignments/${assignmentId}`,
        jsonReq(reviewer.cookie, { scores: { [criterion]: 3 } }),
      );

      const adminRes = await SELF.fetch(
        `${base}/submissions/${submissionId}/comments`,
        jsonReq(admin.cookie, { body: '   ' }),
      );
      expect(adminRes.status).toBe(400);
      expect(await adminRes.json()).toEqual({ error: 'empty_body' });

      const reviewerRes = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}/comments`,
        jsonReq(reviewer.cookie, { body: '   ' }),
      );
      expect(reviewerRes.status).toBe(400);
      expect(await reviewerRes.json()).toEqual({ error: 'empty_body' });
    });

    it('truncates a body over 2000 chars to 2000 on write', async () => {
      const eventId = await seedEvent();
      const admin = await seedStaff(eventId, 'admin');
      const submissionId = await seedSubmission(eventId);
      const long = 'x'.repeat(2500);

      const res = await SELF.fetch(
        `${base}/submissions/${submissionId}/comments`,
        jsonReq(admin.cookie, { body: long }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { id: string };
      const row = await env.DB.prepare('SELECT body FROM submission_comments WHERE id = ?')
        .bind(body.id)
        .first<{ body: string }>();
      expect(row?.body).toHaveLength(2000);
    });
  });

  describe('append-only', () => {
    it('has no PUT or DELETE route on either comment collection', async () => {
      const eventId = await seedEvent();
      const admin = await seedStaff(eventId, 'admin');
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const criterion = await seedCriterion(plan);
      const assignmentId = await seedAssignment(plan, submissionId, reviewer.contactId);
      await SELF.fetch(
        `${base}/review/assignments/${assignmentId}`,
        jsonReq(reviewer.cookie, { scores: { [criterion]: 3 } }),
      );
      const posted = await SELF.fetch(
        `${base}/submissions/${submissionId}/comments`,
        jsonReq(admin.cookie, { body: 'first' }),
      );
      const { id: commentId } = (await posted.json()) as { id: string };

      const putAdmin = await SELF.fetch(
        `${base}/submissions/${submissionId}/comments/${commentId}`,
        jsonReq(admin.cookie, { body: 'edited' }, 'PUT'),
      );
      expect(putAdmin.status).toBe(404);

      const deleteAdmin = await SELF.fetch(
        `${base}/submissions/${submissionId}/comments/${commentId}`,
        jsonReq(admin.cookie, undefined, 'DELETE'),
      );
      expect(deleteAdmin.status).toBe(404);

      const putReviewer = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}/comments/${commentId}`,
        jsonReq(reviewer.cookie, { body: 'edited' }, 'PUT'),
      );
      expect(putReviewer.status).toBe(404);

      const deleteReviewer = await SELF.fetch(
        `${base}/review/assignments/${assignmentId}/comments/${commentId}`,
        jsonReq(reviewer.cookie, undefined, 'DELETE'),
      );
      expect(deleteReviewer.status).toBe(404);
    });
  });

  describe('backfill idempotence (migration 0017)', () => {
    it('re-running the backfill INSERT leaves exactly one sc- row for a seeded review comment', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const reviewId = `rv-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, comment, conflict_of_interest, created_at)
         VALUES (?, ?, ?, ?, '{}', 4, 'Backfilled rationale.', 0, ?)`,
      ).bind(reviewId, submissionId, reviewer.contactId, plan, ts).run();

      const backfill = `
        INSERT OR IGNORE INTO submission_comments
          (id, event_id, submission_id, plan_id, assignment_id, author_contact_id,
           author_role, author_name, kind, body, created_at)
        SELECT
          'sc-' || r.id, p.event_id, r.submission_id, r.plan_id, r.assignment_id,
          r.reviewer_contact_id, 'reviewer',
          NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), ''),
          'rationale', r.comment, r.created_at
        FROM reviews r
        JOIN evaluation_plans p ON p.id = r.plan_id
        LEFT JOIN contacts c ON c.id = r.reviewer_contact_id
        WHERE r.comment IS NOT NULL AND TRIM(r.comment) != ''
      `;

      // The migration already ran once at test-DB setup time (0017 auto-applies
      // and its own backfill covers rows present then); this review was
      // inserted afterwards, so run the statement twice more here to prove a
      // re-run is a no-op regardless of when the row first appeared.
      await env.DB.prepare(backfill).run();
      await env.DB.prepare(backfill).run();

      const rows = await env.DB.prepare(
        `SELECT id, body FROM submission_comments WHERE id = ?`,
      ).bind(`sc-${reviewId}`).all<{ id: string; body: string }>();
      expect(rows.results).toHaveLength(1);
      expect(rows.results[0]!.body).toBe('Backfilled rationale.');
    });
  });

  describe('cross-round scoping on the reviewer thread (eval defect #11)', () => {
    it('a reviewer scoring "Initial Review" does not see rationale from an earlier "Program Committee" round on the same submission', async () => {
      const eventId = await seedEvent();
      const reviewer = await seedStaff(eventId, 'reviewer');
      const submissionId = await seedSubmission(eventId);

      const committeePlan = await seedPlan(eventId, { id: `plan-committee-${crypto.randomUUID()}` });
      const committeeCriterion = await seedCriterion(committeePlan);
      const committeeAssignment = await seedAssignment(committeePlan, submissionId, reviewer.contactId);
      const saveCommittee = await SELF.fetch(
        `${base}/review/assignments/${committeeAssignment}`,
        jsonReq(reviewer.cookie, { scores: { [committeeCriterion]: 4 }, comment: 'Program Committee rationale.' }),
      );
      expect(saveCommittee.status).toBe(200);

      const initialPlan = await seedPlan(eventId, { id: `plan-initial-${crypto.randomUUID()}` });
      const initialCriterion = await seedCriterion(initialPlan);
      const initialAssignment = await seedAssignment(initialPlan, submissionId, reviewer.contactId);

      // Still pending on Initial Review: gate stays closed regardless of the
      // earlier round's completed status, so hit it via a closed-round plan
      // instead of scoring it — proves the *pending* screen never leaks the
      // other round's rationale in the meantime.
      await env.DB.prepare(`UPDATE evaluation_plans SET status = 'closed' WHERE id = ?`).bind(initialPlan).run();

      const res = await SELF.fetch(
        `${base}/review/assignments/${initialAssignment}/comments`,
        { headers: { cookie: reviewer.cookie } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { comments: DetailComment[] };
      expect(body.comments.some((c) => c.body === 'Program Committee rationale.')).toBe(false);

      // The organiser's cross-round submission-detail thread still pools both
      // rounds together — that view is unchanged.
      const admin = await seedStaff(eventId, 'admin');
      const detailRes = await detail(admin.cookie, submissionId);
      const detailBody = (await detailRes.json()) as { comments: DetailComment[] };
      expect(detailBody.comments.some((c) => c.body === 'Program Committee rationale.')).toBe(true);

      // Scoring the Initial Review round and posting there now surfaces its
      // own rationale/discussion, still without the Program Committee row.
      await env.DB.prepare(`UPDATE evaluation_plans SET status = 'active' WHERE id = ?`).bind(initialPlan).run();
      await SELF.fetch(
        `${base}/review/assignments/${initialAssignment}`,
        jsonReq(reviewer.cookie, { scores: { [initialCriterion]: 5 }, comment: 'Initial Review rationale.' }),
      );
      const afterRes = await SELF.fetch(
        `${base}/review/assignments/${initialAssignment}/comments`,
        { headers: { cookie: reviewer.cookie } },
      );
      const afterBody = (await afterRes.json()) as { comments: DetailComment[] };
      expect(afterBody.comments.some((c) => c.body === 'Initial Review rationale.')).toBe(true);
      expect(afterBody.comments.some((c) => c.body === 'Program Committee rationale.')).toBe(false);
    });
  });

  describe('reviewer identity redaction on the thread (anonymise_submitters)', () => {
    it('pseudonymises reviewer authors (rationale + discussion) when the plan anonymises, real names otherwise', async () => {
      const eventId = await seedEvent();
      const reviewerA = await seedStaff(eventId, 'reviewer', 'reviewer-a@example.com');
      const reviewerB = await seedStaff(eventId, 'reviewer', 'reviewer-b@example.com');
      const admin = await seedStaff(eventId, 'admin');
      const submissionId = await seedSubmission(eventId);
      const plan = await seedPlan(eventId);
      const criterion = await seedCriterion(plan);
      const assignA = await seedAssignment(plan, submissionId, reviewerA.contactId);
      const assignB = await seedAssignment(plan, submissionId, reviewerB.contactId);

      // Complete both reviews (opens the D3 gate) with distinct rationale text
      // so each reviewer leaves a real-name-bearing row.
      await SELF.fetch(`${base}/review/assignments/${assignA}`, jsonReq(reviewerA.cookie, { scores: { [criterion]: 4 }, comment: 'From A' }));
      await SELF.fetch(`${base}/review/assignments/${assignB}`, jsonReq(reviewerB.cookie, { scores: { [criterion]: 3 }, comment: 'From B' }));
      // An organiser reply — never pseudonymised, anonymise or not.
      await SELF.fetch(`${base}/submissions/${submissionId}/comments`, jsonReq(admin.cookie, { body: 'Organiser note.' }));

      const getThread = async (cookie: string, assignmentId: string) => {
        const res = await SELF.fetch(`${base}/review/assignments/${assignmentId}/comments`, { headers: { cookie } });
        expect(res.status).toBe(200);
        return (await res.json()) as { comments: Array<DetailComment & { author_contact_id?: string | null }> };
      };

      // Not anonymised (new plans default to anonymised now, so this plan opts out explicitly).
      await SELF.fetch(`${base}/evaluation/plans/${plan}`, jsonReq(admin.cookie, { anonymise_submitters: false }, 'PUT'));
      const openBody = await getThread(reviewerA.cookie, assignA);
      const names = openBody.comments.map((c) => c.author_name);
      expect(names).toContain('Test Person'); // seedStaff's default contact name, shared by both reviewers
      expect(openBody.comments.some((c) => c.body === 'Organiser note.')).toBe(true);

      // Anonymised: reviewer rows get stable per-thread pseudonyms; the
      // organiser row is untouched.
      await SELF.fetch(`${base}/evaluation/plans/${plan}`, jsonReq(admin.cookie, { anonymise_submitters: true }, 'PUT'));
      const hiddenBody = await getThread(reviewerA.cookie, assignA);
      const reviewerRows = hiddenBody.comments.filter((c) => c.author_role === 'reviewer' || c.kind === 'rationale');
      expect(reviewerRows.every((c) => (c.author_name ?? '').startsWith('Reviewer '))).toBe(true);
      // Two distinct authors -> two distinct, stable pseudonyms.
      expect(new Set(reviewerRows.map((c) => c.author_name)).size).toBe(2);
      // author_contact_id is cleared alongside the name — no trivial de-anon.
      expect(reviewerRows.every((c) => c.author_contact_id == null)).toBe(true);
      // The organiser's row keeps its real name and role untouched.
      const organiserRow = hiddenBody.comments.find((c) => c.body === 'Organiser note.');
      expect(organiserRow?.author_role).toBe('admin');
      expect(organiserRow?.author_name).not.toBeNull();

      // Same pseudonym mapping is stable for the POST response too.
      const postRes = await SELF.fetch(
        `${base}/review/assignments/${assignA}/comments`,
        jsonReq(reviewerA.cookie, { body: 'Following up.' }),
      );
      expect(postRes.status).toBe(200);
      const postBody = (await postRes.json()) as { comments: DetailComment[] };
      const mine = postBody.comments.find((c) => c.body === 'Following up.');
      expect(mine?.author_name).toBe(
        reviewerRows.find((c) => c.body === 'From A')!.author_name,
      );
    });
  });
});
