// SPK-13/SPK-14: the organiser compose flow and the per-event email-template
// overrides (routes/messagingAdmin.ts).
//
// Compose is deliberately not its own sending path — it snapshots a
// `bulk_jobs` row and the cron expander (jobs/bulkJobs.ts, kind 'compose')
// renders it per recipient through queueTemplated. These tests therefore
// assert both halves: what the endpoint resolves and freezes, and what the
// expander actually lands in message_log.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { composeBodyToHtml } from '../src/routes/messagingAdmin';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';
import { countRows } from './fixtures-submission';

const ts = '2026-08-01T00:00:00Z';

/**
 * Storage persists across it() blocks in this pool (see apps/api/vitest.config.ts)
 * and `sweepBulkJobs` claims the *oldest* pending job — an earlier test's
 * un-swept compose would be expanded instead of the one under test. The
 * expander tests therefore start from an empty queue.
 */
const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

/**
 * The compose route kicks the expander itself via waitUntil (dead-minute fix),
 * and since the exclusive claim lease (migration 0016) only one expander can
 * hold a job at a time — a sweep called while the kick is mid-tick is a no-op.
 * So for route-created jobs: sweep for anything unclaimed, then wait for the
 * job row to reach a terminal state before asserting.
 */
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

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

const put = (cookie: string, body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

async function staffSession(eventId: string, role: 'admin' | 'reviewer' = 'admin') {
  const contactId = await createContact(eventId, { email: `${role}-${crypto.randomUUID()}@example.com` });
  await createEventUser(eventId, contactId, role);
  const cookie = await sessionCookieFor({ contactId, eventId, eventSlug: eventId, role });
  return { contactId, cookie };
}

async function seedSubmission(eventId: string, submitterId: string | null, status = 'pending'): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, `Talk ${id.slice(-4)}`, status, submitterId, ts, ts).run();
  return id;
}

// ---------------------------------------------------------------------------
// POST /app/api/messaging/compose — recipient resolution
// ---------------------------------------------------------------------------

describe('POST /app/api/messaging/compose', () => {
  it('resolves the "speakers" audience to submitters and participants, never plain contacts', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const submitter = await createContact(eventId, { email: 'submitter@example.com' });
    const coSpeaker = await createContact(eventId, { email: 'co@example.com' });
    const bystander = await createContact(eventId, { email: 'bystander@example.com' });
    const submissionId = await seedSubmission(eventId, submitter);
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position) VALUES (?, ?, ?, 'co-speaker', 1)`,
    ).bind(`par-${crypto.randomUUID()}`, submissionId, coSpeaker).run();

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hello', body: 'Hi {{first_name}}', audience: 'speakers' }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job_id: string; total: number };
    // submitter + co-speaker, not the bystander (and not the admin contact).
    expect(body.total).toBe(2);

    const job = await env.DB.prepare('SELECT kind, status, params_json FROM bulk_jobs WHERE id = ?')
      .bind(body.job_id)
      .first<{ kind: string; status: string; params_json: string }>();
    expect(job?.kind).toBe('compose');
    // The row is created 'pending', but the route's waitUntil kick may already
    // have claimed or even finished it by the time this read lands — any
    // status short of 'failed' means the snapshot was frozen correctly.
    expect(['pending', 'running', 'done']).toContain(job?.status);
    const params = JSON.parse(job!.params_json) as { contact_ids: string[] };
    expect(params.contact_ids.sort()).toEqual([submitter, coSpeaker].sort());
    expect(params.contact_ids).not.toContain(bystander);
  });

  it('narrows "accepted_speakers" to accepted submissions', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const accepted = await createContact(eventId, { email: 'yes@example.com' });
    const pending = await createContact(eventId, { email: 'maybe@example.com' });
    await seedSubmission(eventId, accepted, 'accepted');
    await seedSubmission(eventId, pending, 'pending');

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hello', body: 'Body', audience: 'accepted_speakers' }),
    );
    const body = (await res.json()) as { job_id: string; total: number };
    expect(body.total).toBe(1);
    const params = JSON.parse(
      (await env.DB.prepare('SELECT params_json FROM bulk_jobs WHERE id = ?').bind(body.job_id).first<{ params_json: string }>())!
        .params_json,
    ) as { contact_ids: string[] };
    expect(params.contact_ids).toEqual([accepted]);
  });

  // 2026-08-13 eval sweep, defect #14: there was no way to reach only
  // rejected speakers without hand-picking recipients — this preset is
  // symmetric with accepted_speakers above.
  it('narrows "declined_speakers" to declined submissions', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const declined = await createContact(eventId, { email: 'no-thanks@example.com' });
    const accepted = await createContact(eventId, { email: 'yay@example.com' });
    const pending = await createContact(eventId, { email: 'maybe@example.com' });
    await seedSubmission(eventId, declined, 'declined');
    await seedSubmission(eventId, accepted, 'accepted');
    await seedSubmission(eventId, pending, 'pending');

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hello', body: 'Body', audience: 'declined_speakers' }),
    );
    const body = (await res.json()) as { job_id: string; total: number };
    expect(body.total).toBe(1);
    const params = JSON.parse(
      (await env.DB.prepare('SELECT params_json FROM bulk_jobs WHERE id = ?').bind(body.job_id).first<{ params_json: string }>())!
        .params_json,
    ) as { contact_ids: string[] };
    expect(params.contact_ids).toEqual([declined]);
  });

  it('drops contacts from another event out of an explicit selection', async () => {
    const eventId = await createEvent();
    const otherEvent = await createEvent({ slug: `other-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await staffSession(eventId);
    const mine = await createContact(eventId, { email: 'mine@example.com' });
    const foreign = await createContact(otherEvent, { email: 'foreign@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hi', body: 'Body', audience: 'selected', contact_ids: [mine, foreign] }),
    );
    const body = (await res.json()) as { job_id: string; total: number };
    expect(body.total).toBe(1);
    const params = JSON.parse(
      (await env.DB.prepare('SELECT params_json FROM bulk_jobs WHERE id = ?').bind(body.job_id).first<{ params_json: string }>())!
        .params_json,
    ) as { contact_ids: string[] };
    expect(params.contact_ids).toEqual([mine]);
  });

  // Eval defect #10: composing from the org-wide "All events" directory offers
  // recipients from every event the caller can access (the picker's contact
  // list is unscoped by event), not just the session's own event. A
  // `selected` audience can therefore span events within the SAME
  // organisation — unlike the cross-org case above, these recipients must not
  // be dropped, and their send must land against THEIR OWN event, not the
  // session's home event ("the seeded default event" the eval report named).
  it('resolves a same-org, other-event recipient and logs their send against their own event, not the session\'s', async () => {
    await clearPendingJobs();
    const orgId = `org-${crypto.randomUUID()}`;
    const home = await createEvent({ org_id: orgId, name: 'Home Conf' });
    const other = await createEvent({ org_id: orgId, name: 'Other Conf', slug: `other-conf-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await staffSession(home);
    const homeContact = await createContact(home, { email: 'home-person@example.com', first_name: 'Homer' });
    const otherContact = await createContact(other, { email: 'other-person@example.com', first_name: 'Ottoline' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, {
        subject: 'Hello {{first_name}}, welcome to {{event.name}}',
        body: 'Hi {{first_name}}',
        audience: 'selected',
        contact_ids: [homeContact, otherContact],
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { job_id: string; total: number };
    // Both recipients resolve — same org, different events — where the old
    // strict `ec.event_id = session.eventId` filter would have kept only the
    // home-event contact.
    expect(body.total).toBe(2);

    await settleJob(body.job_id);

    const { results: logs } = await env.DB.prepare(
      `SELECT event_id, to_email, subject FROM message_log WHERE bulk_job_id = ? ORDER BY to_email`,
    ).bind(body.job_id).all<{ event_id: string; to_email: string; subject: string }>();
    expect(logs).toHaveLength(2);
    const homeLog = logs.find((l) => l.to_email === 'home-person@example.com')!;
    const otherLog = logs.find((l) => l.to_email === 'other-person@example.com')!;
    // The bug: both used to be logged against `home` (the composing session's
    // event) regardless of which event each recipient actually belonged to.
    expect(homeLog.event_id).toBe(home);
    expect(otherLog.event_id).toBe(other);
    expect(homeLog.subject).toBe('Hello Homer, welcome to Home Conf');
    expect(otherLog.subject).toBe('Hello Ottoline, welcome to Other Conf');

    // The job row itself still carries the composing session's event — that
    // column is what GET /bulk-jobs/:id's access check keys on — while the
    // per-recipient message_log rows carry the truth.
    const job = await env.DB.prepare('SELECT event_id FROM bulk_jobs WHERE id = ?')
      .bind(body.job_id).first<{ event_id: string }>();
    expect(job?.event_id).toBe(home);
  });

  it('rejects an empty subject, an empty body and an audience that resolves to nobody', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);

    const noSubject = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: '  ', body: 'Body', audience: 'all_contacts' }),
    );
    expect(noSubject.status).toBe(400);
    expect((await noSubject.json() as { error: string }).error).toBe('subject_required');

    const noBody = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hi', body: '', audience: 'all_contacts' }),
    );
    expect(noBody.status).toBe(400);
    expect((await noBody.json() as { error: string }).error).toBe('body_required');

    // No submissions on this event, so "speakers" is empty.
    const noRecipients = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Hi', body: 'Body', audience: 'speakers' }),
    );
    expect(noRecipients.status).toBe(400);
    expect((await noRecipients.json() as { error: string }).error).toBe('no_recipients');

    expect(await countRows('SELECT COUNT(*) AS n FROM bulk_jobs WHERE event_id = ?', eventId)).toBe(0);
  });

  it('is forbidden to a reviewer', async () => {
    const eventId = await createEvent();
    const reviewer = await staffSession(eventId, 'reviewer');
    await createContact(eventId, { email: 'target@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(reviewer.cookie, { subject: 'Hi', body: 'Body', audience: 'all_contacts' }),
    );
    expect(res.status).toBe(403);
    expect(await countRows('SELECT COUNT(*) AS n FROM bulk_jobs WHERE event_id = ?', eventId)).toBe(0);
  });

  it('requires authentication', async () => {
    const eventId = await createEvent();
    await createContact(eventId, { email: 'anon-target@example.com' });
    const res = await SELF.fetch('https://example.com/app/api/messaging/compose', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'Hi', body: 'Body', audience: 'all_contacts' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('GET /app/api/messaging/compose/audiences', () => {
  it('includes declined_speakers alongside accepted_speakers with honest counts', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const declined = await createContact(eventId, { email: 'declined-count@example.com' });
    await seedSubmission(eventId, declined, 'declined');

    const res = await SELF.fetch('https://example.com/app/api/messaging/compose/audiences', {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ audience: string; count: number }> };
    const declinedItem = body.items.find((i) => i.audience === 'declined_speakers');
    expect(declinedItem).toBeDefined();
    expect(declinedItem!.count).toBe(1);
    expect(body.items.some((i) => i.audience === 'accepted_speakers')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The compose expander — merge fields land per recipient
// ---------------------------------------------------------------------------

describe('sweepBulkJobs / compose', () => {
  it('renders merge fields per recipient into message_log and settles the job', async () => {
    await clearPendingJobs();
    const eventId = await createEvent({ name: 'MergeConf' });
    const admin = await staffSession(eventId);
    const ada = await createContact(eventId, { email: 'ada@example.com', first_name: 'Ada', last_name: 'Lovelace' });
    const alan = await createContact(eventId, { email: 'alan@example.com', first_name: 'Alan', last_name: 'Turing' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, {
        subject: 'Hello {{first_name}}, welcome to {{event.name}}',
        body: 'Hi {{first_name}} {{last_name}},\n\nSee you at {{event.name}}.',
        audience: 'selected',
        contact_ids: [ada, alan],
      }),
    );
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    await settleJob(jobId);

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job?.status).toBe('done');
    expect(job?.enqueued).toBe(2);

    const { results: logs } = await env.DB.prepare(
      `SELECT to_email, subject, template_key, contact_id FROM message_log
       WHERE bulk_job_id = ? ORDER BY to_email`,
    )
      .bind(jobId)
      .all<{ to_email: string; subject: string; template_key: string; contact_id: string }>();
    expect(logs).toHaveLength(2);
    expect(logs[0].to_email).toBe('ada@example.com');
    expect(logs[0].subject).toBe('Hello Ada, welcome to MergeConf');
    expect(logs[1].subject).toBe('Hello Alan, welcome to MergeConf');
    expect(logs[0].template_key).toBe('compose');
    expect(logs[0].contact_id).toBe(ada);

    // The body is merged too — check the queued outbox payload, which carries
    // the rendered HTML/text the provider would receive.
    const outbox = await env.DB.prepare(
      `SELECT payload FROM outbox
       WHERE idempotency_key IN (SELECT idempotency_key FROM message_log WHERE bulk_job_id = ?)
       ORDER BY idempotency_key`,
    )
      .bind(jobId)
      .all<{ payload: string }>();
    const bodies = outbox.results.map((r) => (JSON.parse(r.payload) as { text: string }).text);
    expect(bodies.some((t) => t.includes('Hi Ada Lovelace'))).toBe(true);
    expect(bodies.some((t) => t.includes('Hi Alan Turing'))).toBe(true);
    expect(bodies.every((t) => t.includes('See you at MergeConf'))).toBe(true);
    expect(bodies.every((t) => !t.includes('{{'))).toBe(true);
  });

  it('expands in bounded ticks and never double-sends to a recipient', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await createContact(eventId, { email: `bulk${i}@example.com` }));

    // Seed the job row directly (same shape the compose route freezes) rather
    // than POSTing: the route's waitUntil kick would race the manual ticks
    // below, and since the exclusive claim lease the tick-by-tick assertions
    // are only meaningful when this test drives the only expander.
    const jobId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
       VALUES (?, ?, 'compose', 'pending', ?, ?, 0, 'tester', ?, ?)`,
    ).bind(
      jobId,
      eventId,
      JSON.stringify({ subject: 'Tick', body: composeBodyToHtml('Body'), body_text: 'Body', contact_ids: ids }),
      ids.length,
      ts,
      ts,
    ).run();

    await sweepBulkJobs(env, 2);
    let job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string; enqueued: number }>();
    expect(job?.enqueued).toBe(2);
    expect(job?.status).toBe('running');

    await sweepBulkJobs(env, 2);
    job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string; enqueued: number }>();
    expect(job?.enqueued).toBe(3);
    expect(job?.status).toBe('done');

    expect(
      await countRows(`SELECT COUNT(*) AS n FROM message_log WHERE bulk_job_id = ?`, jobId),
    ).toBe(3);
  });

  // CNT-08 (compose half): live-demo eval composing to "Speakers (2)" produced
  // two message_log rows stuck at status 'queued' — the progress dialog hung
  // at "Sending messages… 0/2 queued" with Close disabled, then the settled
  // banner reported "No messages were sent" even though two rows existed.
  // Root cause was the same as the already-fixed remind-tasks path: the cron
  // sweep order in index.ts is sweepReminders -> sweepOutbox -> sweepBulkJobs,
  // so an outbox row *this* expander enqueues is invisible to *this* tick's
  // sweepOutbox and would only flip to 'sent' on the *next* tick — but
  // bulk_jobs.status already flips to 'done' in *this* tick, so the polling
  // dialog stops and reports message_log's state right then (0 sent). The fix
  // (expandCompose now calls the same deliverNow() helper expandRemindTasks
  // uses) delivers inline, so message_log must already read 'sent' by the
  // time a single sweepBulkJobs tick reports the job done — with no separate
  // sweepOutbox call at all.
  it('delivers compose messages inline so message_log is already sent by the time the job reports done (CNT-08)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent({ name: 'InlineConf' });
    const admin = await staffSession(eventId);
    const speaker1 = await createContact(eventId, { email: 'inline-compose-1@example.com' });
    const speaker2 = await createContact(eventId, { email: 'inline-compose-2@example.com' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, {
        subject: 'Reminder',
        body: 'Hi {{first_name}}',
        audience: 'selected',
        contact_ids: [speaker1, speaker2],
      }),
    );
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    await settleJob(jobId); // no sweepOutbox call — delivery must happen inline

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job).toEqual({ status: 'done', enqueued: 2, total: 2 });

    const sent = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE template_key = 'compose' AND status = 'sent' AND bulk_job_id = ?`,
    ).bind(jobId).first<{ n: number }>();
    expect(sent?.n).toBe(2);

    const queuedStill = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM message_log
       WHERE template_key = 'compose' AND status = 'queued' AND bulk_job_id = ?`,
    ).bind(jobId).first<{ n: number }>();
    expect(queuedStill?.n).toBe(0);

    // GET /app/api/bulk-jobs/:id (what the compose dialog polls) must report
    // the true sent count, not the planned/enqueued count.
    const pollRes = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${jobId}`, { headers: { cookie: admin.cookie } });
    const polled = (await pollRes.json()) as { status: string; sent: number; failed: number };
    expect(polled.status).toBe('done');
    expect(polled.sent).toBe(2);
    expect(polled.failed).toBe(0);
  });

  // 2026-08-12 eval sweep, defect 1 (MAJOR): the compose idempotency key used
  // to be `compose:<contact>:<contact>:v1` — identical for every compose ever
  // sent to a contact — so a second deliberate message to the same person was
  // swallowed as 'duplicate': no message_log row, nothing sent, while the UI
  // claimed every recipient had a row. The job id is now the key's version, so
  // each compose (a distinct bulk_jobs snapshot) sends, while retried ticks of
  // the same job still dedupe.
  it('a second compose to the same recipient sends again (one row per compose, not per contact)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent({ name: 'RepeatConf' });
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'repeat@example.com', first_name: 'Rae' });

    const first = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'First note', body: 'Hello', audience: 'selected', contact_ids: [target] }),
    );
    const { job_id: job1 } = (await first.json()) as { job_id: string };
    await settleJob(job1);

    const second = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Second note', body: 'Hello again', audience: 'selected', contact_ids: [target] }),
    );
    expect(second.status).toBe(202);
    const { job_id: job2 } = (await second.json()) as { job_id: string };
    await settleJob(job2);

    const { results: rows } = await env.DB.prepare(
      `SELECT subject, status, bulk_job_id FROM message_log
       WHERE contact_id = ? AND template_key = 'compose' ORDER BY created_at`,
    ).bind(target).all<{ subject: string; status: string; bulk_job_id: string }>();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.subject)).toEqual(['First note', 'Second note']);
    expect(rows.every((r) => r.status === 'sent')).toBe(true);
    expect(rows[0].bulk_job_id).toBe(job1);
    expect(rows[1].bulk_job_id).toBe(job2);

    // Neither job reported the second send as a skipped duplicate.
    const j2 = await env.DB.prepare('SELECT status, skipped_duplicate FROM bulk_jobs WHERE id = ?')
      .bind(job2)
      .first<{ status: string; skipped_duplicate: number }>();
    expect(j2).toEqual({ status: 'done', skipped_duplicate: 0 });
  });

  // 2026-08-12 eval sweep, defects 2/3: a recipient who dropped off the event
  // roster between compose and expansion used to vanish with no trace — fewer
  // log rows than "Send to N" promised, and nothing saying why. Now the
  // compose-time email snapshot lets the expander write an accounted-for
  // 'failed' row with the skip reason.
  it('a recipient removed from the event mid-job still gets a log row with a skip reason', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const stays = await createContact(eventId, { email: 'stays@example.com' });
    const leaves = await createContact(eventId, { email: 'leaves@example.com' });

    // Seed the job directly (as the compose route now freezes it, emails
    // snapshot included) so we can remove a recipient before any expansion.
    const jobId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
       VALUES (?, ?, 'compose', 'pending', ?, 2, 0, 'tester', ?, ?)`,
    ).bind(
      jobId,
      eventId,
      JSON.stringify({
        subject: 'Roster check',
        body: composeBodyToHtml('Body'),
        body_text: 'Body',
        contact_ids: [stays, leaves],
        emails: { [stays]: 'stays@example.com', [leaves]: 'leaves@example.com' },
      }),
      ts,
      ts,
    ).run();
    await env.DB.prepare('DELETE FROM event_contacts WHERE event_id = ? AND contact_id = ?')
      .bind(eventId, leaves)
      .run();

    await sweepBulkJobs(env, 50);

    const job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number }>();
    expect(job).toEqual({ status: 'done', enqueued: 2 });

    const { results: rows } = await env.DB.prepare(
      `SELECT to_email, status, error FROM message_log WHERE bulk_job_id = ? ORDER BY to_email`,
    ).bind(jobId).all<{ to_email: string; status: string; error: string | null }>();
    // Every selected recipient has a row: one delivered, one failed-with-reason.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ to_email: 'leaves@example.com', status: 'failed' });
    expect(rows[0].error).toContain('no longer on this event');
    expect(rows[1]).toMatchObject({ to_email: 'stays@example.com', status: 'sent' });
  });

  // 2026-08-12 eval sweep, defect 5: the rendered per-recipient body is
  // persisted on the message_log row (migration 0029) so the Messages tab
  // detail view can prove what was sent and that merge fields resolved.
  it('persists the rendered subject and body on the message_log row', async () => {
    await clearPendingJobs();
    const eventId = await createEvent({ name: 'BodyConf' });
    const admin = await staffSession(eventId);
    const grace = await createContact(eventId, { email: 'grace@example.com', first_name: 'Grace', last_name: 'Hopper' });

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, {
        subject: 'Hello {{first_name}}',
        body: 'Hi {{first_name}} {{last_name}}, welcome to {{event.name}}.',
        audience: 'selected',
        contact_ids: [grace],
      }),
    );
    const { job_id: jobId } = (await res.json()) as { job_id: string };
    await settleJob(jobId);

    const row = await env.DB.prepare(
      'SELECT subject, body_html, body_text FROM message_log WHERE bulk_job_id = ?',
    ).bind(jobId).first<{ subject: string; body_html: string | null; body_text: string | null }>();
    expect(row?.subject).toBe('Hello Grace');
    expect(row?.body_text).toContain('Hi Grace Hopper, welcome to BodyConf.');
    expect(row?.body_html).toContain('Hi Grace Hopper, welcome to BodyConf.');
    expect(row?.body_text).not.toContain('{{');
  });

  it('escapes the organiser\'s text rather than letting it become markup', () => {
    const html = composeBodyToHtml('A <script>alert(1)</script> line\nwith a break\n\nSecond paragraph');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<br>');
    expect(html.match(/<p>/g)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// POST /app/api/messaging/preview (workplan-14 F2/D3): per-recipient
// pre-send preview, rendered through the exact same code path a real send
// uses (mailer.ts renderTemplatedPreview shares resolveOverride/loadTheme/
// renderTemplate with queueTemplated). The key guarantee under test: preview
// output must byte-equal what actually lands on the message_log row once the
// same subject/body is sent to the same recipient.
// ---------------------------------------------------------------------------

describe('POST /app/api/messaging/preview', () => {
  it('byte-equals the body later persisted by a real send to the same recipient', async () => {
    await clearPendingJobs();
    const eventId = await createEvent({ name: 'PreviewConf' });
    const admin = await staffSession(eventId);
    const grace = await createContact(eventId, {
      email: 'grace-preview@example.com',
      first_name: 'Grace',
      last_name: 'Hopper',
    });

    const subject = 'Hello {{first_name}}, welcome to {{event.name}}';
    const messageBody = 'Hi {{first_name}} {{last_name}},\n\nSee you at {{event.name}}.';

    const previewRes = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject, body: messageBody, contact_id: grace }),
    );
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as { subject: string; body_text: string; body_html: string };
    expect(preview.subject).toBe('Hello Grace, welcome to PreviewConf');
    expect(preview.body_text).toContain('Hi Grace Hopper,');
    expect(preview.body_text).not.toContain('{{');

    // Now actually send the same subject/body to the same recipient and
    // compare the persisted row (0029 columns) to the preview above.
    const composeRes = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject, body: messageBody, audience: 'selected', contact_ids: [grace] }),
    );
    const { job_id: jobId } = (await composeRes.json()) as { job_id: string };
    await settleJob(jobId);

    const row = await env.DB.prepare(
      'SELECT subject, body_html, body_text FROM message_log WHERE bulk_job_id = ?',
    ).bind(jobId).first<{ subject: string; body_html: string; body_text: string }>();
    expect(row?.subject).toBe(preview.subject);
    expect(row?.body_text).toBe(preview.body_text);
    expect(row?.body_html).toBe(preview.body_html);
  });

  it('requires subject, body and contact_id', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'preview-target@example.com' });

    const noSubject = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject: '  ', body: 'Body', contact_id: target }),
    );
    expect(noSubject.status).toBe(400);
    expect(((await noSubject.json()) as { error: string }).error).toBe('subject_required');

    const noBody = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject: 'Hi', body: '', contact_id: target }),
    );
    expect(noBody.status).toBe(400);
    expect(((await noBody.json()) as { error: string }).error).toBe('body_required');

    const noContact = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject: 'Hi', body: 'Body' }),
    );
    expect(noContact.status).toBe(400);
    expect(((await noContact.json()) as { error: string }).error).toBe('contact_id_required');
  });

  it('404s a contact from another event, and a nonexistent contact', async () => {
    const eventId = await createEvent();
    const otherEvent = await createEvent({ slug: `preview-other-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await staffSession(eventId);
    const foreign = await createContact(otherEvent, { email: 'preview-foreign@example.com' });

    const foreignRes = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject: 'Hi', body: 'Body', contact_id: foreign }),
    );
    expect(foreignRes.status).toBe(404);
    expect(((await foreignRes.json()) as { error: string }).error).toBe('contact_not_found');

    const missingRes = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(admin.cookie, { subject: 'Hi', body: 'Body', contact_id: 'not-a-real-id' }),
    );
    expect(missingRes.status).toBe(404);
  });

  it('is forbidden to a reviewer and requires authentication', async () => {
    const eventId = await createEvent();
    const target = await createContact(eventId, { email: 'preview-auth@example.com' });
    const reviewer = await staffSession(eventId, 'reviewer');

    const forbidden = await SELF.fetch(
      'https://example.com/app/api/messaging/preview',
      post(reviewer.cookie, { subject: 'Hi', body: 'Body', contact_id: target }),
    );
    expect(forbidden.status).toBe(403);

    const anon = await SELF.fetch('https://example.com/app/api/messaging/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subject: 'Hi', body: 'Body', contact_id: target }),
    });
    expect(anon.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// POST /app/api/messaging/messages/:id/retry (2026-08-12 sweep, defect 3)
// ---------------------------------------------------------------------------

describe('POST /app/api/messaging/messages/:id/retry', () => {
  /** A failed message_log row + its dead-lettered outbox row, as the outbox
   * sweep leaves them after MAX_ATTEMPTS. */
  async function seedFailedMessage(eventId: string, contactId: string, email: string) {
    const msgId = crypto.randomUUID();
    const logKey = `compose:${contactId}:${contactId}:v${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO message_log (id, event_id, template_key, to_email, contact_id, subject, body_html, body_text, status, error, idempotency_key, created_at)
       VALUES (?, ?, 'compose', ?, ?, 'Retry me', '<p>Hello Retry</p>', 'Hello Retry', 'failed', 'provider exploded', ?, ?)`,
    ).bind(msgId, eventId, email, contactId, logKey, ts).run();
    await env.DB.prepare(
      `INSERT INTO outbox (id, kind, idempotency_key, payload, status, attempts, next_attempt_at, last_error, created_at)
       VALUES (?, 'email', ?, ?, 'dead', 8, ?, 'provider exploded', ?)`,
    ).bind(
      crypto.randomUUID(),
      logKey,
      JSON.stringify({ to: email, subject: 'Retry me', html: '<p>Hello Retry</p>', text: 'Hello Retry', log_key: logKey }),
      ts,
      ts,
    ).run();
    return { msgId, logKey };
  }

  it('revives a dead outbox row and delivers, flipping the row to sent', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'retry-target@example.com' });
    const { msgId, logKey } = await seedFailedMessage(eventId, target, 'retry-target@example.com');

    const res = await SELF.fetch(`https://example.com/app/api/messaging/messages/${msgId}/retry`, post(admin.cookie, {}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string; error: string | null };
    expect(body.ok).toBe(true);
    expect(body.status).toBe('sent'); // DEV_MODE console provider delivers inline
    expect(body.error).toBeNull();

    const log = await env.DB.prepare('SELECT status, error FROM message_log WHERE id = ?')
      .bind(msgId)
      .first<{ status: string; error: string | null }>();
    expect(log).toEqual({ status: 'sent', error: null });
    const outbox = await env.DB.prepare('SELECT status FROM outbox WHERE idempotency_key = ?')
      .bind(logKey)
      .first<{ status: string }>();
    expect(outbox?.status).toBe('done');
  });

  it('rebuilds the payload from the stored body when the outbox row is gone', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'retry-orphan@example.com' });
    const { msgId, logKey } = await seedFailedMessage(eventId, target, 'retry-orphan@example.com');
    await env.DB.prepare('DELETE FROM outbox WHERE idempotency_key = ?').bind(logKey).run();

    const res = await SELF.fetch(`https://example.com/app/api/messaging/messages/${msgId}/retry`, post(admin.cookie, {}));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('sent');
  });

  it('refuses a message that is not failed, and a foreign event\'s message', async () => {
    const eventId = await createEvent();
    const otherEvent = await createEvent({ slug: `retry-other-${crypto.randomUUID().slice(0, 8)}` });
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'retry-sent@example.com' });
    const { msgId } = await seedFailedMessage(eventId, target, 'retry-sent@example.com');
    await env.DB.prepare(`UPDATE message_log SET status = 'sent' WHERE id = ?`).bind(msgId).run();

    const notFailed = await SELF.fetch(`https://example.com/app/api/messaging/messages/${msgId}/retry`, post(admin.cookie, {}));
    expect(notFailed.status).toBe(409);
    expect(((await notFailed.json()) as { error: string }).error).toBe('not_failed');

    // Same row, but through a session on a different event: not visible.
    const foreignAdmin = await staffSession(otherEvent);
    await env.DB.prepare(`UPDATE message_log SET status = 'failed' WHERE id = ?`).bind(msgId).run();
    const foreign = await SELF.fetch(`https://example.com/app/api/messaging/messages/${msgId}/retry`, post(foreignAdmin.cookie, {}));
    expect(foreign.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// SPK-14: template overrides
// ---------------------------------------------------------------------------

describe('email template overrides', () => {
  it('lists every shipped template with its default, and reflects an override after a PUT', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);

    const before = await SELF.fetch('https://example.com/app/api/messaging/templates', { headers: { cookie: admin.cookie } });
    expect(before.status).toBe(200);
    const listed = (await before.json()) as {
      items: Array<{ key: string; default_subject: string | null; subject: string | null; overridden: boolean }>;
      merge_fields: Array<{ field: string }>;
    };
    const magic = listed.items.find((t) => t.key === 'magic_link');
    expect(magic).toBeDefined();
    expect(magic!.default_subject).toContain('{{event.name}}');
    expect(magic!.subject).toBeNull();
    expect(magic!.overridden).toBe(false);
    expect(listed.merge_fields.some((f) => f.field === 'first_name')).toBe(true);

    const saved = await SELF.fetch(
      'https://example.com/app/api/messaging/templates/magic_link',
      put(admin.cookie, { subject: 'Your key to {{event.name}}', body_richtext: '<p>Go: {{magic_link}}</p>' }),
    );
    expect(saved.status).toBe(200);

    const after = await SELF.fetch('https://example.com/app/api/messaging/templates', { headers: { cookie: admin.cookie } });
    const relisted = (await after.json()) as { items: Array<{ key: string; subject: string | null; overridden: boolean }> };
    const updated = relisted.items.find((t) => t.key === 'magic_link');
    expect(updated?.subject).toBe('Your key to {{event.name}}');
    expect(updated?.overridden).toBe(true);
    // One row per (event, key) — a second PUT updates rather than duplicates.
    expect(
      await countRows(`SELECT COUNT(*) AS n FROM email_templates WHERE event_id = ? AND key = 'magic_link'`, eventId),
    ).toBe(1);
  });

  it('an override actually drives what gets sent, and clearing it restores the default', async () => {
    const eventId = await createEvent({ name: 'OverrideCon' });
    const admin = await staffSession(eventId);
    const target = await createContact(eventId, { email: 'invited@example.com', first_name: 'Grace' });

    await SELF.fetch(
      'https://example.com/app/api/messaging/templates/magic_link',
      put(admin.cookie, { subject: 'Custom subject for {{event.name}}', body_richtext: '<p>{{magic_link}}</p>' }),
    );
    await SELF.fetch('https://example.com/app/api/messaging/invite-portal', post(admin.cookie, { contact_id: target }));
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE event_id = ? AND subject = 'Custom subject for OverrideCon'`,
        eventId,
      ),
    ).toBe(1);

    // Empty strings clear the override — the code default takes over again.
    const cleared = await SELF.fetch(
      'https://example.com/app/api/messaging/templates/magic_link',
      put(admin.cookie, { subject: '', body_richtext: '' }),
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json() as { overridden: boolean }).overridden).toBe(false);

    await SELF.fetch('https://example.com/app/api/messaging/invite-portal', post(admin.cookie, { contact_id: target }));
    expect(
      await countRows(
        `SELECT COUNT(*) AS n FROM message_log WHERE event_id = ? AND subject = 'Your sign-in link for OverrideCon'`,
        eventId,
      ),
    ).toBe(1);
  });

  it('refuses an unknown template key', async () => {
    const eventId = await createEvent();
    const admin = await staffSession(eventId);
    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/templates/not_a_template',
      put(admin.cookie, { subject: 'Hi' }),
    );
    expect(res.status).toBe(404);
    expect(await countRows('SELECT COUNT(*) AS n FROM email_templates WHERE event_id = ?', eventId)).toBe(0);
  });

  it('is forbidden to a reviewer, for both the list and the write', async () => {
    const eventId = await createEvent();
    const reviewer = await staffSession(eventId, 'reviewer');

    const listed = await SELF.fetch('https://example.com/app/api/messaging/templates', {
      headers: { cookie: reviewer.cookie },
    });
    expect(listed.status).toBe(403);

    const written = await SELF.fetch(
      'https://example.com/app/api/messaging/templates/magic_link',
      put(reviewer.cookie, { subject: 'nope' }),
    );
    expect(written.status).toBe(403);
    expect(await countRows('SELECT COUNT(*) AS n FROM email_templates WHERE event_id = ?', eventId)).toBe(0);
  });
});
