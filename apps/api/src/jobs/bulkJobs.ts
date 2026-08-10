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
  kind: 'send-decisions' | 'send-confirmations' | 'remind-tasks' | 'compose';
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
    // already moved out of the queue state. The decision itself (accepted/
    // declined) is a distinct fact from whether anyone was told about it —
    // notified_at is deliberately NOT set here (CFP-14 fix): stamping it
    // unconditionally on flip is what let the UI show a "Notified <date>"
    // checkmark for admin-created submissions with no submitter contact,
    // even though nothing was ever queued or sent. It is set below, only
    // after a send actually succeeds.
    const flipped = await db
      .prepare(`UPDATE submissions SET status = ?, updated_at = ? WHERE id = ? AND status IN ('accept_queue', 'decline_queue')`)
      .bind(isAccept ? 'accepted' : 'declined', ts, s.id)
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
      const { outcome } = await queueTemplated(db, {
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
      // 'queued' is a fresh send; 'duplicate' means an earlier tick (or an
      // earlier click of the same bulk action) already queued/sent this
      // exact (template, contact, entity) — both count as "notified".
      // 'template_disabled' means the event has switched this template off:
      // nothing was sent, so notified_at must stay unset, same as the
      // no-submitter case.
      if (outcome === 'queued' || outcome === 'duplicate') {
        await db.prepare(`UPDATE submissions SET notified_at = COALESCE(notified_at, ?) WHERE id = ?`).bind(ts, s.id).run();
      }
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

  // The candidate list is *frozen* at creation time (dashboard.ts's
  // POST /remind always resolves and writes a concrete `assignment_ids`
  // array, even for "remind all" — never omits it), and `job.total` is that
  // array's length. Bug fixed here (CNT-08): this used to re-derive the
  // "currently overdue" set fresh on every tick and slice *that* by
  // `job.enqueued`. If even one targeted assignment stopped matching between
  // job creation and this tick — completed by the speaker, its task's
  // due_at edited, whatever — the live-requeried set shrank below `total`
  // and `enqueued` could never reach it: the job sat in 'running' with
  // enqueued stuck at 0 forever (reproduced in
  // test/bulkjobs-expander-remind.test.ts). Paginating the frozen id list
  // instead — the same pattern expandSendConfirmations/expandCompose use —
  // guarantees `enqueued` reaches `total` in a bounded number of ticks
  // regardless of what happens to the underlying rows meanwhile: a slice
  // that no longer qualifies (already complete, no longer overdue, or the
  // id no longer exists) is simply skipped, not re-attempted.
  const ids = params.assignment_ids ?? [];
  const total = job.total ?? ids.length;
  if (ids.length === 0) {
    await db.prepare(`UPDATE bulk_jobs SET status = 'done', updated_at = ? WHERE id = ?`).bind(nowIso(), job.id).run();
    return;
  }

  const event = await db
    .prepare('SELECT id, name, slug FROM events WHERE id = ?')
    .bind(job.event_id)
    .first<{ id: string; name: string; slug: string }>();
  if (!event) {
    await failJob(db, job.id, 'event_not_found');
    return;
  }

  const slice = ids.slice(job.enqueued, job.enqueued + limit);
  if (slice.length > 0) {
    const placeholders = slice.map(() => '?').join(', ');
    const { results: rows } = await db
      .prepare(
        `SELECT ta.id AS assignment_id, ta.contact_id, c.email, c.first_name, t.title AS task_title
         FROM task_assignments ta
         JOIN tasks t ON t.id = ta.task_id
         JOIN contacts c ON c.id = ta.contact_id
         WHERE t.event_id = ? AND ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?
           AND ta.id IN (${placeholders})`,
      )
      .bind(job.event_id, now, ...slice)
      .all<{ assignment_id: string; contact_id: string; email: string; first_name: string | null; task_title: string }>();

    for (const row of rows) {
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
  }
  const enqueued = Math.min(ids.length, job.enqueued + slice.length);
  await db
    .prepare(`UPDATE bulk_jobs SET enqueued = ?, status = ?, updated_at = ? WHERE id = ?`)
    .bind(enqueued, enqueued >= total ? 'done' : 'running', nowIso(), job.id)
    .run();
}

// ---------------------------------------------------------------------------
// compose (organiser-authored message, params written by messagingAdmin.ts)
// ---------------------------------------------------------------------------

interface ComposeParams {
  subject: string;
  body: string;
  contact_ids: string[];
}

/**
 * Same shape as expandSendDecisions: the recipient list was frozen at compose
 * time, so a tick is just "take the next `limit` ids and queue one render
 * each". The subject/body ride along as an inline template
 * (`queueTemplated`'s `template` arg) rather than an email_templates row, so
 * merge fields, theming, the text alternative and message_log dedupe all
 * behave exactly as they do for a system template — the only difference is
 * where the two strings came from.
 *
 * Merge context is per recipient (`{{first_name}}`, `{{email}}`, …) plus the
 * shared event/portal values; the field list is documented to organisers as
 * COMPOSE_MERGE_FIELDS in messagingAdmin.ts and must be kept in step with it.
 */
async function expandCompose(env: Env, job: BulkJobRow, limit: number): Promise<void> {
  const db = env.DB;
  const params = JSON.parse(job.params_json) as ComposeParams;
  const event = await db
    .prepare('SELECT id, name, slug FROM events WHERE id = ?')
    .bind(job.event_id)
    .first<{ id: string; name: string; slug: string }>();
  if (!event) {
    await failJob(db, job.id, 'event_not_found');
    return;
  }

  const total = job.total ?? params.contact_ids.length;
  const slice = params.contact_ids.slice(job.enqueued, job.enqueued + limit);
  if (slice.length > 0) {
    const placeholders = slice.map(() => '?').join(', ');
    const { results: contacts } = await db
      .prepare(
        `SELECT id, email, first_name, last_name, company, job_title
         FROM contacts WHERE event_id = ? AND id IN (${placeholders})`,
      )
      .bind(job.event_id, ...slice)
      .all<{
        id: string; email: string; first_name: string | null; last_name: string | null;
        company: string | null; job_title: string | null;
      }>();
    const byId = new Map(contacts.map((c) => [c.id, c]));

    // Iterate the *snapshot* order, not the query results: a contact deleted
    // between compose and expansion is skipped without shifting the offset,
    // so `enqueued` stays a truthful cursor into contact_ids.
    for (const contactId of slice) {
      const contact = byId.get(contactId);
      if (!contact) continue;
      const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.email;
      const recipientContext = {
        first_name: contact.first_name ?? 'there',
        last_name: contact.last_name ?? '',
        full_name: fullName,
        email: contact.email,
        company: contact.company ?? '',
        job_title: contact.job_title ?? '',
      };
      await queueTemplated(db, {
        templateKey: 'compose',
        eventId: job.event_id,
        contactId: contact.id,
        toEmail: contact.email,
        entityId: `${job.id}:${contact.id}`,
        template: { subject: params.subject, body: params.body },
        context: {
          ...recipientContext,
          // Also reachable under the names system templates use, so an
          // organiser copying wording out of a template keeps working.
          speaker: recipientContext,
          contact: recipientContext,
          event: { name: event.name },
          portal_url: `${env.APP_URL}/portal/${event.slug}`,
        },
      });
    }
  }

  const enqueued = Math.min(params.contact_ids.length, job.enqueued + slice.length);
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
      case 'compose':
        await expandCompose(env, job, limit);
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
