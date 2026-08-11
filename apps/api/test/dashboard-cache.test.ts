// Dashboard revision-first caching (sweep item P2-16) and the bulk-remind job.

import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { bumpEventRevision } from '../src/revision';
import { jsonReq, seedContact, seedEvent, seedStaff, seedSubmission, seedTask } from './fixtures-admin';

const getDashboard = (cookie: string, etag?: string) =>
  SELF.fetch('https://example.com/app/api/dashboard', {
    headers: { cookie, accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) },
  });

describe('GET /app/api/dashboard', () => {
  it('answers 304 from the revision alone, and re-issues an ETag after a bump', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');

    const first = await getDashboard(admin.cookie);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"r/);

    const second = await getDashboard(admin.cookie, etag!);
    expect(second.status).toBe(304);

    await bumpEventRevision(env, eventId);
    const third = await getDashboard(admin.cookie, etag!);
    expect(third.status).toBe(200);
    expect(third.headers.get('etag')).not.toBe(etag);
  });

  it('serves the payload from KV without touching D1 again', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'speaker@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted', submitter_contact_id: speaker });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    const warm = await getDashboard(admin.cookie);
    const before = (await warm.json()) as { kpis: { accepted_speakers: number } };
    expect(before.kpis.accepted_speakers).toBe(1);

    // Wipe the underlying rows *without* bumping the revision: a cache hit is
    // the only way the same numbers can still come back.
    await env.DB.prepare('DELETE FROM submission_participants').run();
    await env.DB.prepare('DELETE FROM submissions WHERE event_id = ?').bind(eventId).run();

    const cached = await getDashboard(admin.cookie);
    expect(cached.status).toBe(200);
    const after = (await cached.json()) as { kpis: { accepted_speakers: number }; now: string };
    expect(after.kpis.accepted_speakers).toBe(1);
    expect(after.now).toBeTruthy();
  });

  it('counts outstanding and overdue tasks through the grouped aggregate', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'busy@example.com' });
    const submission = await seedSubmission(eventId, { status: 'accepted' });
    await env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, 'speaker', 0, 1)`,
    ).bind(`sp-${crypto.randomUUID()}`, submission, speaker).run();

    const overdueTask = await seedTask(eventId, { title: 'Slides', due_at: '2020-01-01T00:00:00Z', action_type: 'file_upload' });
    const openTask = await seedTask(eventId, { title: 'Bio', due_at: null });
    for (const [id, task] of [['ta-a', overdueTask], ['ta-b', openTask]] as const) {
      await env.DB.prepare(
        'INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, \'not_started\')',
      ).bind(`${id}-${crypto.randomUUID().slice(0, 6)}`, task, speaker).run();
    }

    const res = await getDashboard(admin.cookie);
    const body = (await res.json()) as {
      tracking: { outstanding_tasks: number; top_speakers: Array<{ outstanding: number; overdue: number }>; assets: Array<{ missing_slides: number }> };
    };
    expect(body.tracking.outstanding_tasks).toBe(2);
    expect(body.tracking.top_speakers[0]).toMatchObject({ outstanding: 2, overdue: 1 });
    expect(body.tracking.assets[0]).toMatchObject({ missing_slides: 1 });
  });
});

describe('POST /app/api/dashboard/remind', () => {
  it('enqueues a bulk job instead of sending inline', async () => {
    const eventId = await seedEvent();
    const admin = await seedStaff(eventId, 'admin');
    const speaker = await seedContact(eventId, { email: 'late@example.com' });
    const task = await seedTask(eventId, { due_at: '2020-01-01T00:00:00Z' });
    await env.DB.prepare(
      'INSERT INTO task_assignments (id, task_id, contact_id, status) VALUES (?, ?, ?, \'not_started\')',
    ).bind(`ta-${crypto.randomUUID().slice(0, 8)}`, task, speaker).run();

    const res = await SELF.fetch('https://example.com/app/api/dashboard/remind', jsonReq(admin.cookie, {}));
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; job_id: string; sent: number; skipped: number; total: number };
    expect(body).toMatchObject({ ok: true, sent: 0, skipped: 0, total: 1 });

    // The route kicks the expander via waitUntil; wait for the background
    // expansion to reach a terminal state before asserting.
    let jobStatus = '';
    for (let i = 0; i < 50 && jobStatus !== 'done' && jobStatus !== 'failed'; i++) {
      const r = await env.DB.prepare('SELECT status FROM bulk_jobs WHERE id = ?')
        .bind(body.job_id).first<{ status: string }>();
      jobStatus = r?.status ?? '';
      if (jobStatus !== 'done' && jobStatus !== 'failed') await new Promise((rs) => setTimeout(rs, 100));
    }

    const job = await env.DB.prepare('SELECT kind, status, total, params_json FROM bulk_jobs WHERE id = ?')
      .bind(body.job_id).first<{ kind: string; status: string; total: number; params_json: string }>();
    // The route now kicks the expander before returning (dead-minute fix for
    // CNT-08: the dashboard poll otherwise reads "0/N queued" until the next
    // cron tick), so a small job is fully expanded by the time the response
    // lands. The response body itself still reports frozen zeros.
    expect(job).toMatchObject({ kind: 'remind-tasks', status: 'done', total: 1 });
    expect(JSON.parse(job!.params_json).assignment_ids).toHaveLength(1);

    // The expander delivered inline (console provider): one logged message.
    const messages = await env.DB.prepare('SELECT COUNT(*) AS n FROM message_log WHERE event_id = ?')
      .bind(eventId).first<{ n: number }>();
    expect(messages?.n).toBe(1);

    const status = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie: admin.cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ id: body.job_id, kind: 'remind-tasks', status: 'done', total: 1, enqueued: 1, sent: 1, failed: 0 });

    // Progress is read back through message_log.bulk_job_id (migration 0014).
    // The idempotency key deliberately no longer carries the job id: it names
    // the message, so that a re-send of the same message collides with it.
    const ts = '2026-08-01T00:00:00Z';
    for (const [n, state] of [[1, 'sent'], [2, 'sent'], [3, 'failed']] as const) {
      await env.DB.prepare(
        `INSERT INTO message_log (id, event_id, template_key, to_email, contact_id, status, idempotency_key, bulk_job_id, created_at)
         VALUES (?, ?, 'task_reminder', 'late@example.com', ?, ?, ?, ?, ?)`,
      ).bind(`ml-${n}-${crypto.randomUUID().slice(0, 6)}`, eventId, speaker, state, `task_reminder:${speaker}:assign-${n}:v1`, body.job_id, ts).run();
    }
    await env.DB.prepare('UPDATE bulk_jobs SET enqueued = 3, status = \'running\' WHERE id = ?').bind(body.job_id).run();

    const progressed = await SELF.fetch(`https://example.com/app/api/bulk-jobs/${body.job_id}`, { headers: { cookie: admin.cookie } });
    // 3 synthetic rows + the 1 the inline expansion really sent above.
    expect(await progressed.json()).toMatchObject({ status: 'running', enqueued: 3, sent: 3, failed: 1 });
  });

  it('404s a bulk job from another event', async () => {
    const mine = await seedEvent();
    const theirs = await seedEvent();
    const admin = await seedStaff(mine, 'admin');
    const ts = '2026-08-01T00:00:00Z';
    await env.DB.prepare(
      `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_at, updated_at)
       VALUES ('job-foreign', ?, 'remind-tasks', 'pending', '{}', 0, 0, ?, ?)`,
    ).bind(theirs, ts, ts).run();

    const res = await SELF.fetch('https://example.com/app/api/bulk-jobs/job-foreign', { headers: { cookie: admin.cookie } });
    expect(res.status).toBe(404);
  });
});
