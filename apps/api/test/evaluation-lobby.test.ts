// Workplan 15 W1b: GET /evaluation/lobby — "my top-ranked, not yet accepted",
// the per-human lobbying queue for the decision call.
//
// D3 says this is a purpose-built endpoint rather than a sortable on the
// submissions resource, because the ordering needs a bind (the caller's own
// reviewer_contact_id) that the registry's ORDER BY builder cannot carry. The
// test that actually proves it is the one below where the caller's own score
// and the committee mean disagree: only an endpoint that orders by *their*
// weighted_total can order those two rows correctly.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createSessionToken, SESSION_COOKIE } from '../src/session';
import { seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

interface LobbyResponse {
  items: Array<{
    id: string; code: string; title: string; status: string;
    my_score: number; submission_rating: number | null; review_count: number;
  }>;
}

const lobby = async (cookie: string) =>
  SELF.fetch('https://example.com/app/api/evaluation/lobby', { headers: { cookie } });

const seedReview = async (submissionId: string, reviewerId: string, planId: string, score: number) => {
  await env.DB.prepare(
    `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, conflict_of_interest, created_at)
     VALUES (?, ?, ?, ?, '{}', ?, 0, ?)`,
  ).bind(`rev-${crypto.randomUUID()}`, submissionId, reviewerId, planId, score, ts).run();
};

/**
 * One reviewer's scores over an event mid-decision. MINE-LOW is the row the
 * committee likes and this reviewer does not; MINE-HIGH is the reverse — the
 * pair that separates "my score" from the mean.
 */
async function seedLobby() {
  const eventId = await seedEvent();
  const reviewer = await seedStaff(eventId, 'reviewer');
  const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
  ).bind(planId, eventId, ts).run();
  const other = await seedContact(eventId);

  const rate = async (code: string, status: string, mine: number, theirs: number) => {
    const id = await seedSubmission(eventId, { code, status });
    await seedReview(id, reviewer.contactId, planId, mine);
    await seedReview(id, other, planId, theirs);
    // rating_cache is what the grid's Rating column reads (0001_init.sql); the
    // lobby carries it as the mean beside the caller's own number.
    await env.DB.prepare('UPDATE submissions SET rating_cache = ? WHERE id = ?')
      .bind(JSON.stringify({ [planId]: (mine + theirs) / 2 }), id)
      .run();
    return id;
  };

  // My 5 against a mean of 3; my 2 against a mean of 4.5 — mean order is the
  // exact reverse of mine.
  await rate('SESS-MINE-HIGH', 'pending', 5, 1);
  await rate('SESS-MINE-LOW', 'pending', 2, 5);
  await rate('SESS-DONE', 'accepted', 5, 5);
  await rate('SESS-QUEUED', 'accept_queue', 5, 5);
  // Somebody else's review, on a row I never scored.
  const unseen = await seedSubmission(eventId, { code: 'SESS-THEIRS', status: 'pending' });
  await seedReview(unseen, other, planId, 5);

  return { eventId, reviewer, planId };
}

describe('GET /evaluation/lobby (W1b)', () => {
  it('orders by the caller’s own score, not the mean', async () => {
    const { reviewer } = await seedLobby();
    const res = await lobby(reviewer.cookie);
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as LobbyResponse;

    expect(items.map((r) => r.code)).toEqual(['SESS-MINE-HIGH', 'SESS-MINE-LOW']);
    // The disagreement, stated: ordering by submission_rating would invert it.
    expect(items[0]!.my_score).toBe(5);
    expect(items[0]!.submission_rating).toBe(3);
    expect(items[1]!.my_score).toBe(2);
    expect(items[1]!.submission_rating).toBe(3.5);
    expect(items[0]!.review_count).toBe(2);
  });

  it('excludes rows already accepted or queued, and rows the caller never scored', async () => {
    const { reviewer } = await seedLobby();
    const { items } = (await (await lobby(reviewer.cookie)).json()) as LobbyResponse;
    const codes = items.map((r) => r.code);
    // "not yet accepted" per D2's vocabulary: a queued accept is decided.
    expect(codes).not.toContain('SESS-DONE');
    expect(codes).not.toContain('SESS-QUEUED');
    expect(codes).not.toContain('SESS-THEIRS');
  });

  it('answers 403 for a session with no reviewer seat', async () => {
    const { eventId } = await seedLobby();
    const outsider = await seedContact(eventId, { email: `speaker-${crypto.randomUUID().slice(0, 8)}@example.com` });
    const slug = await env.DB.prepare('SELECT slug FROM events WHERE id = ?').bind(eventId).first<{ slug: string }>();
    const token = await createSessionToken(
      { contactId: outsider, eventId, eventSlug: slug!.slug, email: 'speaker@example.com', role: 'speaker' },
      env.SESSION_SECRET,
    );
    const res = await lobby(`${SESSION_COOKIE}=${token}`);
    expect(res.status).toBe(403);
    // A bare refusal: no scores, codes or titles leave the server.
    expect(await res.text()).not.toContain('SESS-');
  });

  // The cheap half of the same idea (D3), one line in the resource registry.
  it('the reviewed_by filter narrows the submissions grid to a reviewer’s reads', async () => {
    const { reviewer, eventId } = await seedLobby();
    const admin = await seedStaff(eventId, 'admin');
    const res = await SELF.fetch('https://example.com/app/api/submissions/query', {
      method: 'POST',
      headers: { cookie: admin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ from: 0, size: 50, filters: { reviewed_by: reviewer.contactId } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ code: string }>; total: number };
    expect(body.total).toBe(4);
    expect(body.items.map((r) => r.code)).not.toContain('SESS-THEIRS');
  });
});
