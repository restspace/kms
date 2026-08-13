// Workplan 15 W4: the near-miss invite lane. Declined-but-highly-rated talks
// route their speakers into the org-wide pipeline board (0039) — one card per
// person, idempotent on (org_id, contact_id), and the decision-send preflight
// names the cohort at the moment it would otherwise evaporate.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

const enroll = (cookie: string, ids: string[]) =>
  SELF.fetch(
    'https://example.com/app/api/crm/pipeline/enroll-submissions',
    jsonReq(cookie, { ids }),
  );

const board = async (cookie: string) =>
  (await (
    await SELF.fetch('https://example.com/app/api/crm/pipeline', { headers: { cookie } })
  ).json()) as { stages: string[]; cards: Array<Record<string, unknown>> };

async function seedPlan(eventId: string): Promise<string> {
  const id = `plan-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
  ).bind(id, eventId, ts).run();
  return id;
}

/** A review at `total` on the plan's default 1-5 scale, from a fresh reviewer. */
async function rate(eventId: string, planId: string, submissionId: string, total: number): Promise<void> {
  const reviewer = await seedContact(eventId);
  await env.DB.prepare(
    `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, conflict_of_interest, created_at)
     VALUES (?, ?, ?, ?, '{}', ?, 0, ?)`,
  ).bind(`rev-${crypto.randomUUID()}`, submissionId, reviewer, planId, total, ts).run();
}

async function addSpeaker(submissionId: string, contactId: string, primary = true): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
     VALUES (?, ?, ?, 'speaker', 0, ?)`,
  ).bind(`sp-${crypto.randomUUID()}`, submissionId, contactId, primary ? 1 : 0).run();
}

describe('near-miss enrolment', () => {
  it('lands the primary speaker at identified with the rating carried, and the board renders it', async () => {
    const eventId = await seedEvent({ starts_at: '2026-10-01T08:00:00Z' });
    const admin = await seedStaff(eventId, 'admin');
    const planId = await seedPlan(eventId);
    const speaker = await seedContact(eventId, { first_name: 'Ada', last_name: 'Nwosu' });
    const submissionId = await seedSubmission(eventId, {
      code: 'SESS-104', title: 'Evals in anger', status: 'declined',
    });
    await addSpeaker(submissionId, speaker);
    await rate(eventId, planId, submissionId, 4.6);

    const res = await enroll(admin.cookie, [submissionId]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enrolled: 1, created: 1, updated: 0, skipped_no_speaker: 0 });

    // No schema change: the card is a plain board row, at the first stage,
    // with the 1-5 rating mapped onto the card's 0-100 score.
    const after = await board(admin.cookie);
    const card = after.cards.find((c) => c.contact_id === speaker)!;
    expect(card).toMatchObject({
      stage: 'identified',
      score: 90,
      rationale: 'SESS-104 — Evals in anger (rated 4.6, declined 2026)',
      first_name: 'Ada',
    });

    // …and indistinguishable from a hand-made card in the timeline.
    const detail = (await (
      await SELF.fetch(`https://example.com/app/api/crm/pipeline/cards/${card.id}`, { headers: { cookie: admin.cookie } })
    ).json()) as { activity: Array<{ kind: string; to_stage: string | null; author_name: string | null }> };
    expect(detail.activity).toHaveLength(1);
    expect(detail.activity[0]).toMatchObject({ kind: 'enrolled', to_stage: 'identified' });
    expect(detail.activity[0]!.author_name).toBeTruthy();
  });

  it('re-enrolling the same person makes one card with two rationale lines and two activity rows', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await seedPlan(eventId);
    const speaker = await seedContact(eventId);
    const first = await seedSubmission(eventId, { code: 'SESS-1', title: 'One', status: 'declined' });
    const second = await seedSubmission(eventId, { code: 'SESS-2', title: 'Two', status: 'decline_queue' });
    await addSpeaker(first, speaker);
    await addSpeaker(second, speaker);
    await rate(eventId, planId, first, 4.5);
    await rate(eventId, planId, second, 4.8);

    expect(await (await enroll(admin.cookie, [first])).json()).toMatchObject({ created: 1, updated: 0 });
    expect(await (await enroll(admin.cookie, [second])).json()).toMatchObject({ created: 0, updated: 1 });

    const cards = await env.DB.prepare(
      'SELECT id, stage, score, rationale FROM pipeline_cards WHERE contact_id = ?',
    ).bind(speaker).all<{ id: string; stage: string; score: number; rationale: string }>();
    expect(cards.results).toHaveLength(1);
    const card = cards.results[0]!;
    expect(card.stage).toBe('identified');
    // Two near-misses read as a stronger lead: both lines, and the better score.
    expect(card.rationale.split('\n')).toEqual([
      'SESS-1 — One (rated 4.5, declined 2026)',
      'SESS-2 — Two (rated 4.8, declined 2026)',
    ]);
    expect(card.score).toBe(95);

    const activity = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM pipeline_activity WHERE card_id = ? AND kind = 'enrolled'",
    ).bind(card.id).first<{ n: number }>();
    expect(activity?.n).toBe(2);
  });

  it('skips a submission with nobody attached and says so in the response', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId);
    const orphan = await seedSubmission(eventId, { code: 'SESS-ORPH', status: 'declined' });
    const withSpeaker = await seedSubmission(eventId, { code: 'SESS-OK', status: 'declined' });
    await addSpeaker(withSpeaker, speaker);

    const body = (await (await enroll(admin.cookie, [orphan, withSpeaker])).json()) as Record<string, number>;
    expect(body).toMatchObject({ enrolled: 1, created: 1, skipped_no_speaker: 1 });
    // An unrated talk still enrols — the score is simply unknown.
    const card = await env.DB.prepare('SELECT score, rationale FROM pipeline_cards WHERE contact_id = ?')
      .bind(speaker).first<{ score: number | null; rationale: string }>();
    expect(card?.score).toBeNull();
    expect(card?.rationale).toBe('SESS-OK — A talk (declined 2026)');
  });

  it('is writer-only, event-scoped, and refuses an empty selection', async () => {
    const eventA = await seedEvent();
    const eventB = await seedEvent();
    const admin = await seedStaff(eventA, 'admin');
    const reviewer = await seedStaff(eventA, 'reviewer');
    const stranger = await seedContact(eventB);
    const strangerSubmission = await seedSubmission(eventB, { status: 'declined' });
    await addSpeaker(strangerSubmission, stranger);

    expect((await enroll(reviewer.cookie, [strangerSubmission])).status).toBe(403);
    expect((await enroll(admin.cookie, [])).status).toBe(400);
    // Another event's submission is simply not in the session's event.
    expect(await (await enroll(admin.cookie, [strangerSubmission])).json()).toMatchObject({ created: 0, enrolled: 0 });
  });

  it("the decision preflight names the cohort rated at or above the event's accepted mean", async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const planId = await seedPlan(eventId);
    const submitter = await seedContact(eventId, { email: `sub-${crypto.randomUUID()}@example.com` });

    // Accepted mean 4.0; one decline sits above it, one well below.
    for (const total of [3.8, 4.2]) {
      const accepted = await seedSubmission(eventId, { status: 'accept_queue', submitter_contact_id: submitter });
      await rate(eventId, planId, accepted, total);
    }
    const nearMiss = await seedSubmission(eventId, {
      code: 'SESS-NEAR', status: 'decline_queue', submitter_contact_id: submitter,
    });
    const farMiss = await seedSubmission(eventId, {
      code: 'SESS-FAR', status: 'decline_queue', submitter_contact_id: submitter,
    });
    await rate(eventId, planId, nearMiss, 4.5);
    await rate(eventId, planId, farMiss, 2.1);

    const res = await SELF.fetch(
      'https://example.com/app/api/submissions/send-decisions',
      jsonReq(admin.cookie, { ids: [nearMiss, farMiss], preflight: true }),
    );
    const pre = (await res.json()) as { near_miss?: { count: number; ids: string[]; threshold: number } };
    expect(pre.near_miss).toEqual({ count: 1, ids: [nearMiss], threshold: 4 });
  });
});
