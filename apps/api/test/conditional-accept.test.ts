// Workplan 15 W2 (D4): the conditional accept. The decision meeting's actual
// work product — "accepted if you bring a business co-presenter" — is a flag
// ALONGSIDE status='accepted', captured in the accept action itself, told to
// the speaker in the acceptance letter, and chased from the tracking board
// until someone marks it met.
//
// The plan's three cases:
//  1. A condition survives the accept-queue -> accepted flip and the send.
//  2. The email renders the block only for rows that carry one.
//  3. The tracking panel excludes rows with condition_met_at set.
//
// Storage is NOT isolated between it() blocks (see bulkjobs-expander.test.ts's
// note); every assertion below is scoped to ids created within its own test.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

/** Same settle helper the other decision-send suites use: the route kicks the
 *  expander via waitUntil, so sweep and then wait for a terminal status. */
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

async function staffSession(eventId: string) {
  const contactId = await createContact(eventId, { email: `admin-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, 'admin');
  return sessionCookieFor({ contactId, eventId, eventSlug: eventId, role: 'admin' });
}

async function seedSubmission(
  eventId: string,
  submitterId: string | null,
  status: string,
  overrides: Partial<{ title: string; accept_condition: string; condition_met_at: string }> = {},
): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source,
       accept_condition, condition_met_at, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?, ?, ?)`,
  ).bind(
    id,
    eventId,
    `SESS-${id.slice(-6)}`,
    overrides.title ?? `Talk ${id.slice(-4)}`,
    status,
    submitterId,
    overrides.accept_condition ?? null,
    overrides.condition_met_at ?? null,
    ts,
    ts,
  ).run();
  return id;
}

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});
const put = (cookie: string, body: unknown) => ({ ...post(cookie, body), method: 'PUT' });

async function htmlForSubmission(jobId: string, submissionId: string): Promise<string> {
  // The log key is `<template>:<contact>:<entityId>:v<n>` (mailer.ts), and the
  // entity id of a single-decision send is the submission id.
  const msg = await env.DB.prepare(
    `SELECT idempotency_key FROM message_log WHERE bulk_job_id = ? AND idempotency_key LIKE ?`,
  )
    .bind(jobId, `%:${submissionId}:v%`)
    .first<{ idempotency_key: string }>();
  if (!msg) throw new Error(`no message_log row for ${submissionId}`);
  const outboxRow = await env.DB.prepare('SELECT payload FROM outbox WHERE idempotency_key = ?')
    .bind(msg.idempotency_key)
    .first<{ payload: string }>();
  if (!outboxRow) throw new Error(`no outbox row for key ${msg.idempotency_key}`);
  return (JSON.parse(outboxRow.payload) as { html: string }).html;
}

describe('conditional accept (workplan 15 W2)', () => {
  it('1. a condition captured in the accept action survives the flip to accepted and the send', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'cond1@example.com', first_name: 'Ada' });
    const id = await seedSubmission(eventId, speaker, 'pending');

    // The accept action itself carries the condition — this is the placement
    // the plan is about, not a later edit.
    const moved = await SELF.fetch('https://example.com/app/api/submissions/bulk-status', post(cookie, {
      ids: [id],
      status: 'accept_queue',
      accept_condition: 'Needs a business co-presenter — Ann to follow up',
    }));
    expect(moved.status).toBe(200);

    const queued = await env.DB.prepare('SELECT status, accept_condition FROM submissions WHERE id = ?')
      .bind(id)
      .first<{ status: string; accept_condition: string | null }>();
    expect(queued?.status).toBe('accept_queue');
    expect(queued?.accept_condition).toBe('Needs a business co-presenter — Ann to follow up');

    const res = await SELF.fetch('https://example.com/app/api/submissions/send-decisions', post(cookie, { ids: [id] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    const after = await env.DB.prepare(
      'SELECT status, accept_condition, condition_met_at FROM submissions WHERE id = ?',
    )
      .bind(id)
      .first<{ status: string; accept_condition: string | null; condition_met_at: string | null }>();
    // Flipped to accepted, condition intact, and still outstanding: the two
    // axes are independent (D4).
    expect(after?.status).toBe('accepted');
    expect(after?.accept_condition).toBe('Needs a business co-presenter — Ann to follow up');
    expect(after?.condition_met_at).toBeNull();

    const html = await htmlForSubmission(body.job_id, id);
    expect(html).toContain('Needs a business co-presenter');
  });

  it('2. the acceptance letter renders the condition block only for rows carrying one', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const withCond = await createContact(eventId, { email: 'cond2a@example.com' });
    const without = await createContact(eventId, { email: 'cond2b@example.com' });
    const a = await seedSubmission(eventId, withCond, 'accept_queue', { accept_condition: 'Bring a co-presenter' });
    const b = await seedSubmission(eventId, without, 'accept_queue');

    const res = await SELF.fetch('https://example.com/app/api/submissions/send-decisions', post(cookie, { ids: [a, b] }));
    const body = (await res.json()) as { job_id: string };
    await settleJob(body.job_id);

    expect(await htmlForSubmission(body.job_id, a)).toContain('Bring a co-presenter');
    const plain = await htmlForSubmission(body.job_id, b);
    expect(plain).not.toContain('One condition');
    // The unconditional accept letter is byte-for-byte what it always was.
    expect(plain).toContain('has been <strong>accepted</strong>');
  });

  it('3. the tracking panel lists outstanding conditions and drops a row the moment it is marked met', async () => {
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'cond3@example.com', first_name: 'Grace' });
    const outstanding = await seedSubmission(eventId, speaker, 'accepted', {
      title: 'Outstanding condition talk',
      accept_condition: 'Needs a business co-presenter',
    });
    const alreadyMet = await seedSubmission(eventId, speaker, 'accepted', {
      title: 'Met condition talk',
      accept_condition: 'Needed a co-presenter',
      condition_met_at: '2026-08-05T00:00:00Z',
    });
    // An accept with no condition at all is never on the list either.
    await seedSubmission(eventId, speaker, 'accepted', { title: 'Unconditional talk' });

    type Panel = { tracking: { conditions_outstanding: Array<{ submission_id: string; accept_condition: string }> } };
    const first = await SELF.fetch('https://example.com/app/api/dashboard', { headers: { cookie } });
    const listed = ((await first.json()) as Panel).tracking.conditions_outstanding;
    expect(listed.map((r) => r.submission_id)).toContain(outstanding);
    expect(listed.map((r) => r.submission_id)).not.toContain(alreadyMet);
    expect(listed.find((r) => r.submission_id === outstanding)?.accept_condition).toBe(
      'Needs a business co-presenter',
    );

    // Marking it met is one call and must not re-decide the talk.
    const marked = await SELF.fetch(
      `https://example.com/app/api/submissions/${outstanding}/condition`,
      put(cookie, { condition_met: true }),
    );
    expect(marked.status).toBe(200);
    const row = await env.DB.prepare('SELECT status, condition_met_at FROM submissions WHERE id = ?')
      .bind(outstanding)
      .first<{ status: string; condition_met_at: string | null }>();
    expect(row?.status).toBe('accepted');
    expect(row?.condition_met_at).not.toBeNull();

    const second = await SELF.fetch('https://example.com/app/api/dashboard', { headers: { cookie } });
    const after = ((await second.json()) as Panel).tracking.conditions_outstanding;
    expect(after.map((r) => r.submission_id)).not.toContain(outstanding);
  });

  it('4. the grid filters split the two axes: has_condition and condition_outstanding', async () => {
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'cond4@example.com' });
    const outstanding = await seedSubmission(eventId, speaker, 'accepted', { accept_condition: 'Owes a co-presenter' });
    const met = await seedSubmission(eventId, speaker, 'accepted', {
      accept_condition: 'Owed a co-presenter',
      condition_met_at: '2026-08-05T00:00:00Z',
    });
    const none = await seedSubmission(eventId, speaker, 'accepted');

    const query = async (filters: Record<string, unknown>) => {
      const res = await SELF.fetch(
        'https://example.com/app/api/submissions/query',
        post(cookie, { from: 0, size: 50, filters: { ...filters, event_id: eventId } }),
      );
      const body = (await res.json()) as { items: Array<{ id: string }> };
      return body.items.map((i) => i.id);
    };

    const withCondition = await query({ has_condition: 'true' });
    expect(withCondition).toEqual(expect.arrayContaining([outstanding, met]));
    expect(withCondition).not.toContain(none);
    expect(await query({ condition_outstanding: 'true' })).toEqual([outstanding]);
    expect(await query({ condition_outstanding: 'false' })).toEqual([met]);
  });
});
