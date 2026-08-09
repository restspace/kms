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
    expect(job?.status).toBe('pending');
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

    await sweepBulkJobs(env, 50);

    const job = await env.DB.prepare('SELECT status, enqueued, total FROM bulk_jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: string; enqueued: number; total: number }>();
    expect(job?.status).toBe('done');
    expect(job?.enqueued).toBe(2);

    const { results: logs } = await env.DB.prepare(
      `SELECT to_email, subject, template_key, contact_id FROM message_log
       WHERE idempotency_key LIKE '%:' || ? || ':%' ORDER BY to_email`,
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
      `SELECT payload FROM outbox WHERE idempotency_key LIKE '%:' || ? || ':%' ORDER BY idempotency_key`,
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
    const admin = await staffSession(eventId);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push(await createContact(eventId, { email: `bulk${i}@example.com` }));

    const res = await SELF.fetch(
      'https://example.com/app/api/messaging/compose',
      post(admin.cookie, { subject: 'Tick', body: 'Body', audience: 'selected', contact_ids: ids }),
    );
    const { job_id: jobId } = (await res.json()) as { job_id: string };

    await sweepBulkJobs(env, 2);
    let job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string; enqueued: number }>();
    expect(job?.enqueued).toBe(2);
    expect(job?.status).toBe('running');

    await sweepBulkJobs(env, 2);
    job = await env.DB.prepare('SELECT status, enqueued FROM bulk_jobs WHERE id = ?').bind(jobId).first<{ status: string; enqueued: number }>();
    expect(job?.enqueued).toBe(3);
    expect(job?.status).toBe('done');

    expect(
      await countRows(`SELECT COUNT(*) AS n FROM message_log WHERE idempotency_key LIKE '%:' || ? || ':%'`, jobId),
    ).toBe(3);
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
