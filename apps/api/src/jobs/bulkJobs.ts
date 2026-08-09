// Bulk email job expander (sweep item P2-19), invoked from the cron
// `scheduled` handler right after the outbox sweep so anything it queues
// delivers in the same minute. `POST /submissions/send-decisions` (and, once
// BE-1/BE-3 land their callers, agenda bulk-confirm and dashboard remind-all)
// snapshot a coarse row into bulk_jobs instead of doing N×DB/provider work
// in-request; this sweep claims the oldest job, loads shared event data once,
// and expands a bounded slice of recipients per tick.
//
// Idempotency-key convention (coordinate with BE-3's `GET /bulk-jobs/:id`):
// every expander-driven send passes `entityId = "<jobId>:<naturalEntityId>"`
// to queueTemplated, so the resulting message_log.idempotency_key is
// `<template>:<contact>:<jobId>:<naturalEntityId>:v<version>` — countable by
// `idempotency_key LIKE '%:' || jobId || ':%'`. This is deliberate: mailer's
// key format is `${templateKey}:${contactId}:${entityId}:v${version}`, so a
// bare jobId prefix doesn't line up, but embedding it *inside* entityId does
// and survives the `:v<version>` suffix untouched.

import { queueTemplated, type SendOutcome } from '../mailer';
import { autoAssignAcceptTasksCore } from '../routes/evaluation';
import { sendScheduleEmailsCore } from '../scheduleMail';
import type { Env } from '../env';

const RECIPIENTS_PER_TICK = 50;

interface BulkJobRow {
  id: string;
  event_id: string;
  kind: 'send-decisions' | 'send-confirmations' | 'remind-tasks';
  status: string;
  params_json: string;
  total: number | null;
  enqueued: number;
  created_by: string | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Adapts queueTemplated's richer return to the `send` shape scheduleMail/evaluation expect. */
function queueSend(db: D1Database) {
  return async (args: Parameters<typeof queueTemplated>[1]): Promise<SendOutcome> => {
    const { outcome } = await queueTemplated(db, args);
    return outcome;
  };
}

async function claimJob(db: D1Database): Promise<BulkJobRow | null> {
  const candidate = await db
    .prepare(`SELECT id FROM bulk_jobs WHERE status IN ('pending', 'running') ORDER BY created_at LIMIT 1`)
    .first<{ id: string }>();
  if (!candidate) return null;
  // Conditional UPDATE: claiming a 'running' job just resumes it (a previous
  // tick may have failed partway or hit the recipient limit); claiming a
  // 'pending' job starts it. Either way the WHERE guard means a job another
  // concurrent sweep already moved out of (pending|running) is not reclaimed.
  return await db
    .prepare(
      `UPDATE bulk_jobs SET status = 'running', updated_at = ?
       WHERE id = ? AND status IN ('pending', 'running')
       RETURNING *`,
    )
    .bind(nowIso(), candidate.id)
    .first<BulkJobRow>();
}

async function failJob(db: D1Database, id: string, error: string): Promise<void> {
  await db
    .prepare(`UPDATE bulk_jobs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
    .bind(error.slice(0, 2000), nowIso(), id)
    .run();
}

// ---------------------------------------------------------------------------
// send-decisions
// ---------------------------------------------------------------------------

interface SendDecisionsParams {
  ids: string[];
  include_feedback?: boolean;
}

async function expandSendDecisions(env: Env, job: BulkJobRow, limit: number): Promise<void> {
  const db = env.DB;
  const params = JSON.parse(job.params_json) as SendDecisionsParams;
  const event = await db
    .prepare('SELECT id, name, slug FROM events WHERE id = ?')
    .bind(job.event_id)
    .first<{ id: string; name: string; slug: string }>();
  if (!event) {
    await failJob(db, job.id, 'event_not_found');
    return;
  }
  if (params.ids.length === 0) {
    await db.prepare(`UPDATE bulk_jobs SET status = 'done', updated_at = ? WHERE id = ?`).bind(nowIso(), job.id).run();
    return;
  }

  const placeholders = params.ids.map(() => '?').join(', ');
  const { results: batch } = await db
    .prepare(
      `SELECT s.id, s.code, s.title, s.status, s.submitter_contact_id,
              c.email AS submitter_email, c.first_name AS submitter_first_name
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.event_id = ? AND s.id IN (${placeholders}) AND s.status IN ('accept_queue', 'decline_queue')
       ORDER BY s.id
       LIMIT ?`,
    )
    .bind(job.event_id, ...params.ids, limit)
    .all<{
      id: string; code: string; title: string; status: string;
      submitter_contact_id: string | null; submitter_email: string | null; submitter_first_name: string | null;
    }>();

  const ts = nowIso();
  const send = queueSend(db);
  for (const s of batch) {
    const isAccept = s.status === 'accept_queue';
    // Conditional flip: guards against a concurrent tick (or a resumed job
    // after a mid-tick failure) reprocessing a submission this same sweep
    // already moved out of the queue state.
    const flipped = await db
      .prepare(`UPDATE submissions SET status = ?, notified_at = ?, updated_at = ? WHERE id = ? AND status IN ('accept_queue', 'decline_queue')`)
      .bind(isAccept ? 'accepted' : 'declined', ts, ts, s.id)
      .run();
    if (flipped.meta.changes === 0) continue;

    let reviewerFeedback = '';
    if (params.include_feedback) {
      const { results: comments } = await db
        .prepare(
          `SELECT comment FROM reviews
           WHERE submission_id = ? AND conflict_of_interest = 0 AND comment IS NOT NULL AND TRIM(comment) != ''`,
        )
        .bind(s.id)
        .all<{ comment: string }>();
      if (comments.length > 0) {
        reviewerFeedback = `Reviewer feedback:\n${comments.map((c) => `- ${c.comment.trim()}`).join('\n')}`;
      }
    }

    if (s.submitter_email) {
      await queueTemplated(db, {
        templateKey: isAccept ? 'decision_accepted' : 'decision_declined',
        eventId: job.event_id,
        contactId: s.submitter_contact_id,
        toEmail: s.submitter_email,
        entityId: `${job.id}:${s.id}`,
        context: {
          event: { name: event.name },
          speaker: { first_name: s.submitter_first_name ?? 'there' },
          submission: { title: s.title, code: s.code },
          portal_url: `${env.APP_URL}/portal/${event.slug}`,
          ...(reviewerFeedback ? { reviewer_feedback: reviewerFeedback } : {}),
        },
      });
    }
    if (isAccept) {
      await autoAssignAcceptTasksCore(db, job.event_id, s, event.name, event.slug, env.APP_URL, send, job.id);
    }
  }

  const progress = await db
    .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE id IN (${placeholders}) AND status IN ('accepted', 'declined')`)
    .bind(...params.ids)
    .first<{ n: number }>();
  const enqueued = progress?.n ?? 0;
  const total = job.total ?? params.ids.length;
  await db
    .prepare(`UPDATE bulk_jobs SET enqueued = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(enqueued, enqueued >= total ? 'done' : 'running', nowIso(), job.id)
    .run();
}

// ---------------------------------------------------------------------------
// send-confirmations (agenda bulk schedule-confirm, params written by BE-1)
// ---------------------------------------------------------------------------

interface SendConfirmationsParams {
  session_ids: string[];
}

async function expandSendConfirmations(env: Env, job: BulkJobRow, limit: number): Promise<void> {
  const db = env.DB;
  const params = JSON.parse(job.params_json) as SendConfirmationsParams;
  const total = job.total ?? params.session_ids.length;
  const slice = params.session_ids.slice(job.enqueued, job.enqueued + limit);
  const send = queueSend(db);
  for (const sessionId of slice) {
    await sendScheduleEmailsCore(env, db, sessionId, 'confirmed', send, job.id);
  }
  const enqueued = Math.min(params.session_ids.length, job.enqueued + slice.length);
  await db
    .prepare(`UPDATE bulk_jobs SET enqueued = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(enqueued, enqueued >= total ? 'done' : 'running', nowIso(), job.id)
    .run();
}

// ---------------------------------------------------------------------------
// remind-tasks (dashboard bulk-remind, params written by BE-3)
// ---------------------------------------------------------------------------

interface RemindTasksParams {
  assignment_ids?: string[];
}

async function expandRemindTasks(env: Env, job: BulkJobRow, limit: number): Promise<void> {
  const db = env.DB;
  const params = JSON.parse(job.params_json) as RemindTasksParams;
  const now = new Date().toISOString();
  const event = await db
    .prepare('SELECT id, name, slug FROM events WHERE id = ?')
    .bind(job.event_id)
    .first<{ id: string; name: string; slug: string }>();
  if (!event) {
    await failJob(db, job.id, 'event_not_found');
    return;
  }

  // Reproduces dashboard.ts's remind logic (overdue, incomplete, due-dated
  // assignments), scoped to assignment_ids when the caller narrowed the
  // selection. NOTE: this re-queries "currently overdue" fresh every tick, so
  // the candidate set can grow between ticks if this job runs long — the
  // `enqueued` offset can then skip or (harmlessly, thanks to message_log
  // dedupe) re-touch a boundary row. Acceptable for a coarse admin action;
  // flagged as a TODO rather than adding a snapshot table for this lane.
  let sql = `SELECT ta.id AS assignment_id, ta.contact_id, c.email, c.first_name, t.title AS task_title
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     JOIN contacts c ON c.id = ta.contact_id
     WHERE t.event_id = ? AND ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?`;
  const bindArgs: unknown[] = [job.event_id, now];
  if (params.assignment_ids && params.assignment_ids.length > 0) {
    sql += ` AND ta.id IN (${params.assignment_ids.map(() => '?').join(', ')})`;
    bindArgs.push(...params.assignment_ids);
  }
  sql += ' ORDER BY ta.id';

  const { results: overdue } = await db
    .prepare(sql)
    .bind(...bindArgs)
    .all<{ assignment_id: string; contact_id: string; email: string; first_name: string | null; task_title: string }>();

  const total = job.total ?? overdue.length;
  const slice = overdue.slice(job.enqueued, job.enqueued + limit);
  for (const row of slice) {
    await queueTemplated(db, {
      templateKey: 'task_reminder',
      eventId: job.event_id,
      contactId: row.contact_id,
      toEmail: row.email,
      entityId: `${job.id}:${row.assignment_id}`,
      version: `manual-${now.slice(0, 10)}`,
      context: {
        event: { name: event.name },
        speaker: { first_name: row.first_name ?? 'there' },
        task: { title: row.task_title, due_line: ' — now overdue', url: `${env.APP_URL}/portal/${event.slug}/tasks` },
      },
    });
  }
  const enqueued = Math.min(overdue.length, job.enqueued + slice.length);
  await db
    .prepare(`UPDATE bulk_jobs SET enqueued = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(enqueued, enqueued >= total ? 'done' : 'running', nowIso(), job.id)
    .run();
}

// ---------------------------------------------------------------------------

/** Cron entry point: claim one job, expand up to `limit` recipients, repeat next tick. */
export async function sweepBulkJobs(env: Env, limit = RECIPIENTS_PER_TICK): Promise<void> {
  const job = await claimJob(env.DB);
  if (!job) return;
  try {
    switch (job.kind) {
      case 'send-decisions':
        await expandSendDecisions(env, job, limit);
        break;
      case 'send-confirmations':
        await expandSendConfirmations(env, job, limit);
        break;
      case 'remind-tasks':
        await expandRemindTasks(env, job, limit);
        break;
      default:
        await failJob(env.DB, job.id, `unknown bulk_jobs kind: ${job.kind as string}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Whatever sends/flips happened before the throw already committed
    // individually (each is its own awaited statement, not one batch), so
    // nothing here needs to unwind. If something outside this lane (an admin
    // retry action) moves the job back to 'pending', the next sweep resumes
    // cleanly: status flips are conditional on the pre-flip state and every
    // send is message_log-deduped, so no double work or double email.
    await failJob(env.DB, job.id, message);
  }
}
