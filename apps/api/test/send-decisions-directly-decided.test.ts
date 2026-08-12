// CFP-14: "Send decision emails" used to notify only rows sitting in
// accept_queue/decline_queue — a submission whose status was set directly to
// Accepted/Declined was silently skipped. Eligibility is now queue rows PLUS
// decided rows never notified (notified_at IS NULL, reachable email); decided
// rows already notified stay skipped and are reported.
//
// Idempotency for the new arm has no status flip to lean on: the expander's
// tick-time `notified_at IS NULL` select guard plus the mailer idempotency
// key (entityId = submission id) replace it — covered below.

import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { sweepBulkJobs } from '../src/jobs/bulkJobs';
import { createContact, createEvent, createEventUser, sessionCookieFor } from './fixtures';

const ts = '2026-08-01T00:00:00Z';

const clearPendingJobs = () =>
  env.DB.prepare("DELETE FROM bulk_jobs WHERE status IN ('pending', 'running')").run();

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
  notifiedAt: string | null = null,
): Promise<string> {
  const id = `sub-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO submissions (id, event_id, code, kind, title, status, submitter_contact_id, notified_at, source, created_at, updated_at)
     VALUES (?, ?, ?, 'abstract', ?, ?, ?, ?, 'manual', ?, ?)`,
  ).bind(id, eventId, `SESS-${id.slice(-6)}`, `Talk ${id.slice(-4)}`, status, submitterId, notifiedAt, ts, ts).run();
  return id;
}

const post = (cookie: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify(body),
});

const send = (cookie: string, body: unknown) =>
  SELF.fetch('https://example.com/app/api/submissions/send-decisions', post(cookie, body));

describe('send-decisions includes directly-decided, never-notified rows (CFP-14)', () => {
  it('a status-set-directly accepted row sends decision_accepted and stamps notified_at', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'direct@example.com', first_name: 'Ada' });
    const direct = await seedSubmission(eventId, speaker, 'accepted');

    const res = await send(cookie, { ids: [direct] });
    const body = (await res.json()) as { accepted: number; resend: number; skipped: number; job_id: string };
    expect(body.accepted).toBe(1);
    expect(body.resend).toBe(1);
    expect(body.skipped).toBe(0);
    expect(body.job_id).not.toBeNull();
    await settleJob(body.job_id);

    const row = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id = ?')
      .bind(direct)
      .first<{ status: string; notified_at: string | null }>();
    expect(row?.status).toBe('accepted');
    expect(row?.notified_at).not.toBeNull();

    const messages = await env.DB.prepare('SELECT template_key, to_email FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .all<{ template_key: string; to_email: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]).toMatchObject({ template_key: 'decision_accepted', to_email: 'direct@example.com' });
  });

  it('an already-notified decided row is skipped and reported, not re-sent', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'notified@example.com' });
    const notified = await seedSubmission(eventId, speaker, 'declined', '2026-08-05T00:00:00Z');

    const res = await send(cookie, { ids: [notified] });
    const body = (await res.json()) as {
      accepted: number; declined: number; skipped: number; skipped_notified: number; job_id: string | null;
    };
    expect(body.accepted + body.declined).toBe(0);
    expect(body.skipped).toBe(1);
    expect(body.skipped_notified).toBe(1);
    expect(body.job_id).toBeNull();
  });

  it('a decided row with no reachable email never enters the job, and the job still finishes', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'ok@example.com' });
    const sendable = await seedSubmission(eventId, speaker, 'accepted');
    const unreachable = await seedSubmission(eventId, null, 'accepted');

    const res = await send(cookie, { ids: [sendable, unreachable] });
    const body = (await res.json()) as {
      accepted: number; skipped: number; skipped_no_submitter: number; job_id: string;
    };
    expect(body.accepted).toBe(1);
    expect(body.skipped).toBe(1); // the unreachable row is out of the send set entirely
    expect(body.skipped_no_submitter).toBe(1);
    await settleJob(body.job_id);

    const polled = (await (
      await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie } })
    ).json()) as { status: string };
    expect(polled.status).toBe('done');
    const row = await env.DB.prepare('SELECT notified_at FROM submissions WHERE id = ?')
      .bind(unreachable)
      .first<{ notified_at: string | null }>();
    expect(row?.notified_at).toBeNull();
  });

  it('a second send over a just-notified row sends nothing (tick-time select guard)', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'twice@example.com' });
    const direct = await seedSubmission(eventId, speaker, 'accepted');

    const first = (await (await send(cookie, { ids: [direct] })).json()) as { job_id: string };
    await settleJob(first.job_id);

    const second = (await (await send(cookie, { ids: [direct] })).json()) as {
      accepted: number; skipped_notified: number; job_id: string | null;
    };
    expect(second.accepted).toBe(0);
    expect(second.skipped_notified).toBe(1);
    expect(second.job_id).toBeNull();

    const messages = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log WHERE to_email = ?')
      .bind('twice@example.com')
      .first<{ n: number }>();
    expect(messages?.n).toBe(1);
  });

  it('a mixed queue + directly-decided batch for one speaker merges into one decision_summary', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'both@example.com', first_name: 'Priya' });
    const queued = await seedSubmission(eventId, speaker, 'accept_queue');
    const direct = await seedSubmission(eventId, speaker, 'declined');

    const res = await send(cookie, { ids: [queued, direct] });
    const body = (await res.json()) as { accepted: number; declined: number; resend: number; job_id: string };
    expect(body.accepted).toBe(1);
    expect(body.declined).toBe(1);
    expect(body.resend).toBe(1);
    await settleJob(body.job_id);

    const messages = await env.DB.prepare('SELECT template_key, idempotency_key FROM message_log WHERE bulk_job_id = ?')
      .bind(body.job_id)
      .all<{ template_key: string; idempotency_key: string }>();
    expect(messages.results).toHaveLength(1);
    expect(messages.results[0]!.template_key).toBe('decision_summary');
    // The merged log key carries the sorted covered-submission ids (D5).
    expect(messages.results[0]!.idempotency_key).toContain(`batch:${[queued, direct].sort().join('+')}`);

    const rows = await env.DB.prepare('SELECT id, status, notified_at FROM submissions WHERE id IN (?, ?)')
      .bind(queued, direct)
      .all<{ id: string; status: string; notified_at: string | null }>();
    const byId = Object.fromEntries(rows.results.map((r) => [r.id, r]));
    expect(byId[queued]!.status).toBe('accepted');
    expect(byId[direct]!.status).toBe('declined');
    expect(byId[queued]!.notified_at).not.toBeNull();
    expect(byId[direct]!.notified_at).not.toBeNull();
  });

  it('preflight+preview renders sample accept/decline emails through the real template pipeline', async () => {
    await clearPendingJobs();
    const eventId = await createEvent();
    const cookie = await staffSession(eventId);
    const speaker = await createContact(eventId, { email: 'preview@example.com', first_name: 'Ada' });
    const accepted = await seedSubmission(eventId, speaker, 'accept_queue');
    const declined = await seedSubmission(eventId, speaker, 'declined');

    const res = await send(cookie, { ids: [accepted, declined], preflight: true, preview: true });
    const body = (await res.json()) as {
      preflight: boolean;
      accepted: number;
      declined: number;
      job_id: string | null;
      previews: {
        accepted: { subject: string; body_html: string; sample_to: string } | null;
        declined: { subject: string; body_html: string; sample_to: string } | null;
        merged_speakers: number;
      };
    };
    expect(body.preflight).toBe(true);
    expect(body.job_id).toBeNull(); // preflight never creates a job
    expect(body.accepted).toBe(1);
    expect(body.declined).toBe(1);
    expect(body.previews.accepted).not.toBeNull();
    expect(body.previews.accepted!.sample_to).toBe('preview@example.com');
    // Merge fields resolved for the sample recipient, not left as {{…}}.
    expect(body.previews.accepted!.body_html).toContain('Ada');
    expect(body.previews.accepted!.body_html).not.toContain('{{');
    expect(body.previews.declined).not.toBeNull();
    // Both rows belong to one speaker → they'd merge into one email.
    expect(body.previews.merged_speakers).toBe(1);

    // Nothing changed state: preview is read-only.
    const row = await env.DB.prepare('SELECT status, notified_at FROM submissions WHERE id = ?')
      .bind(accepted)
      .first<{ status: string; notified_at: string | null }>();
    expect(row?.status).toBe('accept_queue');
    expect(row?.notified_at).toBeNull();
  });
});
