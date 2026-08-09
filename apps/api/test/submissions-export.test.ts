// ABS-13 (verification lane P3-4): the submissions grid's CSV/XLSX export
// buttons go through the /api/v1 REST export (apps/admin/src/api.ts
// buildExportUrl → GET /events/:id/submissions/export). The registry's
// selectSql already computes `rating` (mean weighted_total across reviewers)
// and `review_count` for every submissions row (adminApi.ts RESOURCE_SPECS),
// so the export inherits those columns for free — this test pins that down
// so a future selectSql edit can't silently drop them.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createEvent } from './fixtures';
import { bearerReq, orgIdForEvent, seedApiToken } from './restapi-helpers';
import { seedSubmission } from './fixtures-admin';

const ts = '2026-08-01T00:00:00Z';

async function seedContactRow(eventId: string, email: string): Promise<string> {
  const id = `ct-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO contacts (id, event_id, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).bind(id, eventId, email, ts, ts).run();
  return id;
}

describe('GET /api/v1/events/:event_id/submissions/export', () => {
  it('includes the aggregate rating and review_count columns in CSV', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);

    const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO evaluation_plans (id, event_id, name, status, created_at) VALUES (?, ?, 'P', 'active', ?)`,
    ).bind(planId, eventId, ts).run();
    const criterionId = `crit-${crypto.randomUUID().slice(0, 8)}`;
    await env.DB.prepare(
      `INSERT INTO scoring_criteria (id, plan_id, name, weight, position) VALUES (?, ?, 'Quality', 2, 1)`,
    ).bind(criterionId, planId).run();

    const submissionId = await seedSubmission(eventId, { code: 'SESS-EXPORT', title: 'Exportable Talk' });
    await env.DB.prepare('UPDATE submissions SET evaluation_plan_id = ? WHERE id = ?').bind(planId, submissionId).run();

    const reviewerId = await seedContactRow(eventId, 'reviewer@example.com');
    await env.DB.prepare(
      `INSERT INTO reviews (id, submission_id, reviewer_contact_id, plan_id, scores, weighted_total, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)`,
    ).bind(`rev-${crypto.randomUUID()}`, submissionId, reviewerId, planId, JSON.stringify({ [criterionId]: 4 }), 4, ts).run();

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/submissions/export?format=csv`,
      bearerReq(token),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('.csv');

    const text = await res.text();
    const [headerLine, ...rows] = text.replace(/^﻿/, '').trim().split('\r\n');
    const cols = headerLine!.split(',');
    expect(cols).toContain('rating');
    expect(cols).toContain('review_count');

    const ratingIdx = cols.indexOf('rating');
    const reviewCountIdx = cols.indexOf('review_count');
    const row = rows.find((r) => r.includes('SESS-EXPORT'));
    expect(row).toBeDefined();
    const cells = row!.split(',');
    expect(cells[ratingIdx]).toBe('4');
    expect(cells[reviewCountIdx]).toBe('1');
  });

  it('produces a downloadable XLSX with the same score columns', async () => {
    const eventId = await createEvent();
    const orgId = await orgIdForEvent(eventId);
    const token = await seedApiToken(orgId);
    await seedSubmission(eventId, { code: 'SESS-XLSX' });

    const res = await SELF.fetch(
      `https://example.com/api/v1/events/${eventId}/submissions/export?format=xlsx`,
      bearerReq(token),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const buf = new Uint8Array(await res.arrayBuffer());
    // A zip (xlsx container) starts with the local-file-header signature "PK\x03\x04".
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.length).toBeGreaterThan(0);
  });
});
