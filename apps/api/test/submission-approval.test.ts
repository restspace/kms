// Workplan 13 W3 (D4): approval_state is a flag alongside the accepted
// status, not a status value. Route validation against APPROVAL_STATES,
// the submissions-resource filter, the tracking board's "Approval pending"
// panel, the per-send {{approval_ask}} opt-in — and the rule that 'refused'
// never auto-withdraws (D7).

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission } from './fixtures-admin';

const base = 'https://example.com/app/api';

const approvalUrl = (id: string) => `${base}/submissions/${id}/approval`;

const submissionRow = (id: string) =>
  env.DB.prepare('SELECT status, approval_state, approval_note FROM submissions WHERE id = ?')
    .bind(id)
    .first<{ status: string; approval_state: string | null; approval_note: string | null }>();

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

/** Mirror of decision-email-merging.test.ts: wait for the job to settle. */
async function settleJob(jobId: string) {
  await sweepBulkJobs(env, 50);
  for (let i = 0; i < 50; i++) {
    const row = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string }>();
    if (row && row.status !== 'pending' && row.status !== 'running') return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`bulk job ${jobId} never settled`);
}

async function acceptEmailHtml(jobId: string): Promise<string> {
  const msg = await env.DB.prepare(
    `SELECT idempotency_key FROM message_log WHERE bulk_job_id = ? AND template_key = 'decision_accepted'`,
  ).bind(jobId).first<{ idempotency_key: string }>();
  if (!msg) throw new Error(`no decision_accepted message for job ${jobId}`);
  const outboxRow = await env.DB.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?')
    .bind(msg.idempotency_key)
    .first<{ payload: string }>();
  if (!outboxRow) throw new Error(`no outbox row for key ${msg.idempotency_key}`);
  return (JSON.parse(outboxRow.payload) as { html: string }).html;
}

describe('PUT /submissions/:id/approval', () => {
  it('sets and clears the flag, keeps the note, and rejects unknown states', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const bad = await SELF.fetch(approvalUrl(submissionId), jsonReq(admin.cookie, { approval_state: 'maybe' }, 'PUT'));
    expect(bad.status).toBe(400);

    const set = await SELF.fetch(
      approvalUrl(submissionId),
      jsonReq(admin.cookie, { approval_state: 'pending', approval_note: '  PR sign-off, legal says end of month  ' }, 'PUT'),
    );
    expect(set.status).toBe(200);
    expect(await submissionRow(submissionId)).toEqual({
      status: 'accepted',
      approval_state: 'pending',
      approval_note: 'PR sign-off, legal says end of month',
    });

    const cleared = await SELF.fetch(
      approvalUrl(submissionId),
      jsonReq(admin.cookie, { approval_state: null, approval_note: null }, 'PUT'),
    );
    expect(cleared.status).toBe(200);
    expect(await submissionRow(submissionId)).toEqual({ status: 'accepted', approval_state: null, approval_note: null });
  });

  it("'refused' records the fact and never auto-withdraws (D7)", async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const submissionId = await seedSubmission(eventId, { status: 'accepted' });

    const res = await SELF.fetch(approvalUrl(submissionId), jsonReq(admin.cookie, { approval_state: 'refused' }, 'PUT'));
    expect(res.status).toBe(200);
    const row = await submissionRow(submissionId);
    expect(row!.approval_state).toBe('refused');
    expect(row!.status).toBe('accepted'); // a prompt for a human, not a status change
  });

  it('is refused for a reviewer session', async () => {
    const eventId = await seedEvent();
    const reviewer = await seedStaff(eventId, 'reviewer');
    const submissionId = await seedSubmission(eventId);
    const res = await SELF.fetch(approvalUrl(submissionId), jsonReq(reviewer.cookie, { approval_state: 'pending' }, 'PUT'));
    expect(res.status).toBe(403);
  });
});

describe('approval on the submissions resource', () => {
  it('filters and sorts on approval_state', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const flagged = await seedSubmission(eventId, { code: 'SESS-PEND', status: 'accepted' });
    const plain = await seedSubmission(eventId, { code: 'SESS-PLAIN', status: 'accepted' });
    await env.DB.prepare(`UPDATE submissions SET approval_state = 'pending' WHERE id = ?`).bind(flagged).run();

    const res = await SELF.fetch(
      `${base}/submissions/query`,
      jsonReq(admin.cookie, { size: 10, filters: { approval_state: 'pending' } }),
    );
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((r) => r.id)).toEqual([flagged]);

    const none = await SELF.fetch(
      `${base}/submissions/query`,
      jsonReq(admin.cookie, { size: 10, filters: { approval_state: 'none' } }),
    );
    const noneBody = (await none.json()) as { items: Array<{ id: string }> };
    expect(noneBody.items.map((r) => r.id)).toEqual([plain]);

    const sorted = await SELF.fetch(
      `${base}/submissions/query`,
      jsonReq(admin.cookie, { size: 10, filters: {}, sort: { field: 'approval_state', direction: 'asc' } }),
    );
    expect(sorted.status).toBe(200);
  });
});

describe('Speaker Tracking approval panel', () => {
  it('lists pending approvals sorted by days-until-event ascending', async () => {
    const eventId = await seedEvent({ starts_at: '2026-10-01T08:00:00Z' });
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { first_name: 'Pending', last_name: 'Speaker' });

    const soon = await seedSubmission(eventId, { code: 'SESS-SOON', status: 'accepted', submitter_contact_id: speaker });
    const later = await seedSubmission(eventId, { code: 'SESS-LATER', status: 'accepted', submitter_contact_id: speaker });
    await env.DB.prepare(
      `UPDATE submissions SET approval_state = 'pending', approval_note = 'Legal reviewing', starts_at = '2026-09-01T09:00:00Z' WHERE id = ?`,
    ).bind(soon).run();
    await env.DB.prepare(
      `UPDATE submissions SET approval_state = 'pending', starts_at = '2026-10-02T09:00:00Z' WHERE id = ?`,
    ).bind(later).run();

    const res = await SELF.fetch(`${base}/dashboard`, { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      tracking: { approval_pending: Array<{ submission_id: string; name: string; approval_note: string | null; days_until_event: number }> };
    };
    const rows = payload.tracking.approval_pending.filter((r) => [soon, later].includes(r.submission_id));
    expect(rows.map((r) => r.submission_id)).toEqual([soon, later]);
    expect(rows[0]!.days_until_event).toBeLessThanOrEqual(rows[1]!.days_until_event);
    expect(rows[0]!.approval_note).toBe('Legal reviewing');
    expect(rows[0]!.name).toBe('Pending Speaker');
  });
});

describe('the {{approval_ask}} opt-in on send-decisions', () => {
  it('renders the ask in the accept email and flags the covered submission pending', async () => {
    await clearPendingJobs();
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: `ask-${crypto.randomUUID().slice(0, 8)}@example.com`, first_name: 'Asked' });
    const submissionId = await seedSubmission(eventId, { status: 'accept_queue', submitter_contact_id: speaker });

    const res = await SELF.fetch(
      `${base}/submissions/send-decisions`,
      jsonReq(admin.cookie, { ids: [submissionId], approval_ask: true }),
    );
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    await settleJob(job_id);

    const row = await submissionRow(submissionId);
    expect(row).toMatchObject({ status: 'accepted', approval_state: 'pending' });
    const html = await acceptEmailHtml(job_id);
    expect(html).toContain('sign-off from your employer');
  });

  it('does nothing when the organiser did not opt in — not the default', async () => {
    await clearPendingJobs();
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: `noask-${crypto.randomUUID().slice(0, 8)}@example.com` });
    const submissionId = await seedSubmission(eventId, { status: 'accept_queue', submitter_contact_id: speaker });

    const res = await SELF.fetch(`${base}/submissions/send-decisions`, jsonReq(admin.cookie, { ids: [submissionId] }));
    const { job_id } = (await res.json()) as { job_id: string };
    await settleJob(job_id);

    const row = await submissionRow(submissionId);
    expect(row).toMatchObject({ status: 'accepted', approval_state: null });
    const html = await acceptEmailHtml(job_id);
    expect(html).not.toContain('sign-off from your employer');
  });
});
