// Workplan 13 W1a/W1b: reviews and comment threads become registry resources
// (D1 — one RESOURCE_SPECS entry buys the grid, /api/v1 list, CSV/XLSX and
// the OpenAPI document at once), gated to owner/admin seats. The "everything
// the committee produced has never left a CFP tool" sentence stops being true
// of us here.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RESOURCES } from '../src/routes/adminApi';
import { jsonReq, seedContact, seedEvent, seedEventUser, seedStaff, seedSubmission } from './fixtures-admin';
import { attachContactToEvent } from './fixtures';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';

const ts = '2026-08-01T00:00:00Z';

interface QueryResponse {
  items: Array<Record<string, unknown>>;
  total: number;
  error?: string;
}

const query = async (cookie: string, resource: string, body: Record<string, unknown> = {}) => {
  const res = await SELF.fetch(
    `https://example.com/app/api/${resource}/query`,
    jsonReq(cookie, { size: 50, filters: {}, ...body }),
  );
  return { status: res.status, body: (await res.json()) as QueryResponse };
};

async function seedPlan(eventId: string): Promise<string> {
  const id = `plan-${crypto.randomUUID().slice(0, 8)}`;
  await env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'Round 1', 'active', ?)`,
  ).bind(id, eventId, ts).run();
  return id;
}

async function seedReview(
  eventId: string,
  submissionId: string,
  planId: string,
  reviewerId: string,
  overrides: Partial<{ weighted_total: number | null; conflict_of_interest: number; comment: string | null; scores: string }> = {},
): Promise<string> {
  const id = `rev-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, comment, conflict_of_interest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id,
    submissionId,
    reviewerId,
    planId,
    overrides.scores ?? JSON.stringify({ crit: 4 }),
    overrides.weighted_total === undefined ? 4 : overrides.weighted_total,
    overrides.comment ?? null,
    overrides.conflict_of_interest ?? 0,
    ts,
  ).run();
  return id;
}

async function seedComment(
  eventId: string,
  submissionId: string,
  overrides: Partial<{ kind: string; body: string; author_name: string; author_contact_id: string | null }> = {},
): Promise<string> {
  const id = `sc-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submission_comments (id, event_id, submission_id, author_contact_id, author_role, author_name, kind, body, created_at)
     VALUES (?, ?, ?, ?, 'admin', ?, ?, ?, ?)`,
  ).bind(
    id,
    eventId,
    submissionId,
    overrides.author_contact_id ?? null,
    overrides.author_name ?? 'Ada Admin',
    overrides.kind ?? 'discussion',
    overrides.body ?? 'Strong contender for the keynote slot.',
    ts,
  ).run();
  return id;
}

describe('reviews resource (W1a)', () => {
  it('lists a seeded review with the joined submission, reviewer and plan columns', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedContact(eventId, { email: `rev-${crypto.randomUUID().slice(0, 8)}@example.com`, first_name: 'Sam', last_name: 'Whitfield' });
    const submissionId = await seedSubmission(eventId, { code: 'SESS-REV', title: 'Reviewed Talk' });
    const planId = await seedPlan(eventId);
    await seedReview(eventId, submissionId, planId, reviewer, { comment: 'Sharp and well-scoped.' });

    const { status, body } = await query(admin.cookie, 'reviews', { filters: { submission_id: submissionId } });
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      submission_id: submissionId,
      submission_code: 'SESS-REV',
      submission_title: 'Reviewed Talk',
      reviewer_name: 'Sam Whitfield',
      plan_name: 'Round 1',
      weighted_total: 4,
      comment: 'Sharp and well-scoped.',
      conflict_of_interest: 0,
      event_id: eventId,
    });
    // Raw per-criterion JSON in one cell, deliberately not exploded.
    expect(JSON.parse(String(body.items[0]!.scores))).toEqual({ crit: 4 });
  });

  it('filters on conflict_of_interest and plan_id', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const reviewer = await seedContact(eventId);
    const submissionId = await seedSubmission(eventId);
    const planId = await seedPlan(eventId);
    const scored = await seedReview(eventId, submissionId, planId, reviewer);
    const other = await seedContact(eventId);
    const coi = await seedReview(eventId, submissionId, planId, other, { weighted_total: null, conflict_of_interest: 1 });

    const conflicted = await query(admin.cookie, 'reviews', {
      filters: { submission_id: submissionId, conflict_of_interest: true },
    });
    expect(conflicted.body.items.map((r) => r.id)).toEqual([coi]);

    const inPlan = await query(admin.cookie, 'reviews', { filters: { plan_id: planId } });
    expect(inPlan.body.items.map((r) => r.id).sort()).toEqual([coi, scored].sort());
  });

  it('refuses a reviewer-seat session outright (403, no rows)', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await SELF.fetch(
      'https://example.com/app/api/reviews/query',
      jsonReq(reviewer.cookie, { size: 10, filters: {} }),
    );
    expect(res.status).toBe(403);
  });

  it('never widens the scope through a reviewer seat at a sibling event', async () => {
    const tag = crypto.randomUUID().slice(0, 8);
    const eventA = await seedEvent({ org_id: `org-w13-${tag}`, slug: `w13-a-${tag}` });
    const eventB = await seedEvent({ org_id: `org-w13-${tag}`, slug: `w13-b-${tag}` });
    const admin = await seedStaff(eventA, 'admin', `w13-admin-${tag}@example.com`);
    // Same email holds only a REVIEWER seat at event B.
    await attachContactToEvent(eventB, admin.contactId);
    await seedEventUser(eventB, admin.contactId, 'reviewer');

    const planB = await seedPlan(eventB);
    const reviewerB = await seedContact(eventB);
    const submissionB = await seedSubmission(eventB, { code: `SESS-B-${tag}` });
    await seedReview(eventB, submissionB, planB, reviewerB);

    const spanning = await query(admin.cookie, 'reviews', {});
    expect(spanning.status).toBe(200);
    expect(spanning.body.items.every((r) => r.event_id === eventA)).toBe(true);

    // Naming event B explicitly is refused, not silently emptied.
    const explicit = await query(admin.cookie, 'reviews', { filters: { event_id: eventB } });
    expect(explicit.status).toBe(403);
  });
});

describe('comments resource (W1b)', () => {
  it('lists a seeded comment and filters on kind', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { code: 'SESS-CMT', title: 'Discussed Talk' });
    const discussion = await seedComment(eventId, submissionId);
    const rationale = await seedComment(eventId, submissionId, { kind: 'rationale', body: 'Scores 4 for depth.' });

    const all = await query(admin.cookie, 'comments', { filters: { submission_id: submissionId } });
    expect(all.status).toBe(200);
    expect(all.body.items.map((r) => r.id).sort()).toEqual([discussion, rationale].sort());
    expect(all.body.items[0]).toMatchObject({ submission_code: 'SESS-CMT', event_id: eventId });

    const rationales = await query(admin.cookie, 'comments', {
      filters: { submission_id: submissionId, kind: 'rationale' },
    });
    expect(rationales.body.items.map((r) => r.id)).toEqual([rationale]);
  });

  it('refuses a reviewer-seat session outright (403)', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const res = await SELF.fetch(
      'https://example.com/app/api/comments/query',
      jsonReq(reviewer.cookie, { size: 10, filters: {} }),
    );
    expect(res.status).toBe(403);
  });
});

describe('registry-driven surfaces (D1)', () => {
  it('round-trips a seeded review through the /api/v1 CSV export', async () => {
    const eventId = await seedEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);
    const reviewer = await seedContact(eventId, { first_name: 'Rae', last_name: 'Exporter' });
    const submissionId = await seedSubmission(eventId, { code: 'SESS-CSV', title: 'Exportable Review' });
    const planId = await seedPlan(eventId);
    await seedReview(eventId, submissionId, planId, reviewer, { weighted_total: 3.5 });

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/reviews/export?format=csv`,
      bearerReq(token),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    const text = await res.text();
    const [headerLine, ...rows] = text.replace(/^﻿/, '').trim().split('\r\n');
    const cols = headerLine!.split(',');
    for (const col of ['submission_code', 'submission_title', 'reviewer_name', 'plan_name', 'weighted_total', 'scores', 'created_at']) {
      expect(cols).toContain(col);
    }
    const row = rows.find((r) => r.includes('SESS-CSV'));
    expect(row).toBeDefined();
    expect(row).toContain('Rae Exporter');
    expect(row).toContain('3.5');
  });

  it('describes every registry resource — reviews and comments included — in the OpenAPI document', async () => {
    const res = await SELF.fetch('https://example.com/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { paths: Record<string, unknown> };
    for (const name of Object.keys(RESOURCES)) {
      expect(doc.paths[`/events/{event_id}/${name}`]).toBeDefined();
      expect(doc.paths[`/events/{event_id}/${name}/export`]).toBeDefined();
    }
    expect(Object.keys(RESOURCES)).toEqual(expect.arrayContaining(['reviews', 'comments']));
  });
});
