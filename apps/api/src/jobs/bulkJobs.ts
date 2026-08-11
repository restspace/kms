// Bulk email job expander (sweep item P2-19), invoked from the cron
// `scheduled` handler right after the outbox sweep so anything it queues
// delivers in the same minute. `POST /submissions/send-decisions` (and, once
// BE-1/BE-3 land their callers, agenda bulk-confirm and dashboard remind-all)
// snapshot a coarse row into bulk_jobs instead of doing N×DB/provider work
// in-request; this sweep claims the oldest job, loads shared event data once,
// and expands a bounded slice of recipients per tick.
//
// Idempotency-key convention (coordinate with BE-3's `GET /bulk-jobs/:id`):
// expander-driven sends pass the *natural* entity id to queueTemplated and
// name their job separately, via `bulkJobId` — which mailer.ts writes to
// message_log.bulk_job_id, so a job's messages are countable by
// `bulk_job_id = ?`.
//
// This used to work the other way round: `entityId = "<jobId>:<naturalId>"`,
// making the key `<template>:<contact>:<jobId>:<naturalId>:v<version>` and
// the count a `LIKE '%:'||jobId||':%'`. That put the job id inside the
// UNIQUE column whose entire job is to be *stable* across re-sends, and a
// fresh job id per press is exactly what a re-send looks like. Reminders —
// the one flow with no second guard like submissions.notified_at — therefore
// re-sent on every "Remind all" press. Migration 0014 splits the two facts:
// the key names the message, the column names the batch. Don't merge them
// again.

import { createDb } from '@kms/db';
import { eventLocalDay } from '@kms/core';
import { deliverEmail, queueTemplated, type OutboxEmailPayload, type SendOutcome } from '../mailer';
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

/**
 * Adapts queueTemplated's richer return to the `send` shape
 * scheduleMail/evaluation expect, stamping every send with the job it came
 * from so those callers never have to know about bulk jobs at all.
 */
function queueSend(db: D1Database, bulkJobId: string) {
  return async (args: Parameters<typeof queueTemplated>[1]): Promise<SendOutcome> => {
    const { outcome } = await queueTemplated(db, { ...args, bulkJobId });
    return outcome;
  };
}

/**
 * Context-free sibling of mailer.ts's `attemptImmediate` (bulk expanders run
 * from the cron `scheduled` handler, which has no Hono `Context`/`waitUntil`
 * to hand it): claim the just-queued outbox row and deliver inline, awaited,
 * instead of leaving it for the *next* cron tick's `sweepOutbox`.
 *
 * This matters specifically for remind-tasks (CNT-08 follow-up): the sweep
 * order in index.ts is sweepReminders -> sweepOutbox -> sweepBulkJobs, so an
 * outbox row this expander enqueues is invisible to *this* tick's
 * sweepOutbox — it would otherwise sit `queued` until the next tick. But
 * `bulk_jobs.status` flips to 'done' as soon as `enqueued` reaches `total`,
 * which happens in *this* tick, right after the queueTemplated calls above
 * return. The dashboard's poll loop stops polling the moment it sees 'done'
 * and reports whatever `message_log` shows *right then* — so without this,
 * every remind-all run reported "0 reminders sent" even though the messages
 * were sent a few seconds later by the next tick, invisibly to the admin who
 * already dismissed the banner. Delivering inline means the message_log rows
 * this tick creates are already 'sent' (or 'failed') by the time `enqueued`
 * reaches `total`, so the completion banner's count is the true one.
 *
 * Failure just leaves the outbox row claimed with a 5-minute lease, same as
 * attemptImmediate — the regular sweepOutbox reclaims and retries it once
 * that lease expires; nothing here needs to duplicate its backoff/dead-letter
 * logic.
 */
async function deliverNow(db: D1Database, env: Env, logKey: string, payload: OutboxEmailPayload): Promise<void> {
  const claimed = await db
    .prepare(
      `UPDATE outbox SET status = 'in_flight', next_attempt_at = ?
       WHERE idempotency_key = ? AND status = 'pending'
       RETURNING id`,
    )
    .bind(new Date(Date.now() + 5 * 60_000).toISOString(), logKey)
    .first<{ id: string }>();
  if (!claimed) return;
  try {
    await deliverEmail(db, env, payload);
    await createDb(db).outbox.markDoneByKey(logKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    console.error(`bulk remind: immediate send failed (${logKey}):`, message);
    // Count the attempt toward the normal backoff/dead-letter sequence instead
    // of leaving the row in_flight until the passive claim lease expires.
    await createDb(db).outbox.markFailed(claimed.id, message);
  }
}

/** How long a mid-tick claim blocks other sweeps if its worker dies there. A
 * live tick expands at most RECIPIENTS_PER_TICK sends, well under this. */
const CLAIM_LEASE_MS = 5 * 60_000;

async function claimJob(db: D1Database): Promise<BulkJobRow | null> {
  // Exclusive claim (migration 0016): a 'pending' job is claimable, and a
  // 'running' job only when no expander is inside a tick on it right now —
  // claim_expires_at NULL (last tick finished; resume it) or expired (a
  // worker died mid-tick; take over). This used to accept any
  // (pending|running) row, which let the request-path waitUntil kick and the
  // cron sweep expand the same job concurrently — the second claimant judged
  // the job complete off the first one's half-committed work and marked it
  // 'done' before the sends and notified_at stamps had happened. One
  // statement, so candidate selection and claim are atomic; sweepBulkJobs
  // releases the lease when the tick's expander returns.
  const now = Date.now();
  return await db
    .prepare(
      `UPDATE bulk_jobs SET status = 'running', claim_expires_at = ?1, updated_at = ?2
       WHERE id = (
         SELECT id FROM bulk_jobs
         WHERE status = 'pending'
            OR (status = 'running' AND (claim_expires_at IS NULL OR claim_expires_at < ?2))
         ORDER BY created_at LIMIT 1
       )
       RETURNING *`,
    )
    .bind(new Date(now + CLAIM_LEASE_MS).toISOString(), new Date(now).toISOString())
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
  const send = queueSend(db, job.id);
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
      // Reviewer rationales live in the submission_comments thread since
      // workplan 7 (reviews.comment is deprecated). Feedback is each
      // assignment's most recent kind='rationale' row — append-only means a
      // revised rationale is a newer row, and only the latest should be sent.
      // Discussion rows are never included (D5: the thread is internal); the
      // conflict-of-interest exclusion carries over via the reviews join.
      const { results: comments } = await db
        .prepare(
          `SELECT body AS comment FROM (
             SELECT sc.body, sc.id,
                    ROW_NUMBER() OVER (
                      PARTITION BY COALESCE(sc.assignment_id, sc.id)
                      ORDER BY sc.created_at DESC, sc.id DESC) AS rn
             FROM submission_comments sc
             LEFT JOIN reviews r ON r.assignment_id = sc.assignment_id
             WHERE sc.submission_id = ? AND sc.kind = 'rationale'
               AND COALESCE(r.conflict_of_interest, 0) = 0
           ) WHERE rn = 1 AND TRIM(body) != ''
           ORDER BY id`,
        )
        .bind(s.id)
        .all<{ comment: string }>();
      if (comments.length > 0) {
        reviewerFeedback = `Reviewer feedback:\n${comments.map((c) => `- ${c.comment.trim()}`).join('\n')}`;
      }
    }

    if (s.submitter_email) {
      const { outcome, payload } = await queueTemplated(db, {
        templateKey: isAccept ? 'decision_accepted' : 'decision_declined',
        eventId: job.event_id,
        contactId: s.submitter_contact_id,
        toEmail: s.submitter_email,
        entityId: s.id,
        bulkJobId: job.id,
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
      // Deliver inline, exactly as expandRemindTasks and
      // expandSendConfirmations already do — see deliverNow's doc comment.
      // CFP defect: this expander was the one that never did. It flipped
      // bulk_jobs to 'done' the moment every submission was processed, while
      // the message_log rows it had just written were still 'queued' awaiting
      // the next tick's sweepOutbox. GET /bulk-jobs/:id counts only
      // status='sent'/'failed', so the poll that settled on 'done' read
      // sent=0, failed=0 and the toast said "No decision emails were sent."
      // — for mail that was queued, was delivered seconds later, and had
      // already stamped notified_at on the submission.
      if (outcome === 'queued' && payload) await deliverNow(db, env, payload.log_key, payload);
    }
    if (isAccept) {
      await autoAssignAcceptTasksCore(db, job.event_id, s, event.name, event.slug, env.APP_URL, send);
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
  const send = queueSend(db, job.id);
  for (const sessionId of slice) {
    await sendScheduleEmailsCore(env, db, sessionId, 'confirmed', send);
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
    .prepare('SELECT id, name, slug, timezone FROM events WHERE id = ?')
    .bind(job.event_id)
    .first<{ id: string; name: string; slug: string; timezone: string }>();
  if (!event) {
    await failJob(db, job.id, 'event_not_found');
    return;
  }

  // The day that makes a reminder "already sent today" is the day where the
  // *event* is, not where this worker runs — see core/time.ts. A UTC-derived
  // day rolls over mid-afternoon for US events, which would hand a second
  // press a fresh key and let the duplicate through.
  const day = eventLocalDay(now, event.timezone);

  const slice = ids.slice(job.enqueued, job.enqueued + limit);
  let duplicates = 0;
  if (slice.length > 0) {
    const placeholders = slice.map(() => '?').join(', ');
    // LEFT JOIN contacts, not the inner join this used to be: an inner join
    // silently dropped an overdue assignment whose contact has no email (or
    // was deleted) from `rows` with no trace anywhere, which is exactly the
    // "disqualified with no explanation" shape CNT-08 described. Every id
    // still matching the same overdue predicate the dashboard panel and
    // POST /remind use (t.event_id, ta.status != 'complete', t.due_at) now
    // comes back, so a missing email is a countable, reportable skip instead
    // of a silent no-op.
    const { results: rows } = await db
      .prepare(
        `SELECT ta.id AS assignment_id, ta.contact_id, c.email, c.first_name, t.title AS task_title
         FROM task_assignments ta
         JOIN tasks t ON t.id = ta.task_id
         LEFT JOIN contacts c ON c.id = ta.contact_id
         WHERE t.event_id = ? AND ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?
           AND ta.id IN (${placeholders})`,
      )
      .bind(job.event_id, now, ...slice)
      .all<{
        assignment_id: string; contact_id: string; email: string | null; first_name: string | null; task_title: string;
      }>();

    for (const row of rows) {
      if (!row.email || row.email.trim() === '') continue; // no address to mail — counted by GET /bulk-jobs/:id's skipped_no_email
      const { outcome, payload } = await queueTemplated(db, {
        templateKey: 'task_reminder',
        eventId: job.event_id,
        contactId: row.contact_id,
        toEmail: row.email,
        entityId: row.assignment_id,
        bulkJobId: job.id,
        version: `manual-${day}`,
        context: {
          event: { name: event.name },
          speaker: { first_name: row.first_name ?? 'there' },
          task: { title: row.task_title, due_line: ' — now overdue', url: `${env.APP_URL}/portal/${event.slug}/tasks` },
        },
      });
      // Deliver inline rather than waiting for the next cron tick's
      // sweepOutbox — see deliverNow's doc comment for why that's required
      // for the completion banner's sent count to be truthful.
      if (outcome === 'queued' && payload) await deliverNow(db, env, payload.log_key, payload);
      // 'duplicate' means the UNIQUE idempotency key caught a reminder this
      // contact already had for this assignment today — the guarantee
      // working, not a failure. Count it so the completion banner can say
      // "0 sent, 2 already reminded today" rather than a bare "0 sent" that
      // reads like something broke.
      if (outcome === 'duplicate') duplicates += 1;
    }
  }
  const enqueued = Math.min(ids.length, job.enqueued + slice.length);
  await db
    .prepare(
      `UPDATE bulk_jobs SET enqueued = ?, status = ?, skipped_duplicate = skipped_duplicate + ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(enqueued, enqueued >= total ? 'done' : 'running', duplicates, nowIso(), job.id)
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
      // 0015: mirrors resolveAudience's shape. The event_contacts join re-pins
      // the frozen ids to this job's event — a contact removed from the roster
      // between compose and expansion drops out, exactly as the deleted-contact
      // case below does — and supplies company/job_title, which are per-event
      // profile now: the merge fields must render the title this event holds.
      .prepare(
        `SELECT c.id, c.email, c.first_name, c.last_name, ec.company, ec.job_title
         FROM event_contacts ec
         JOIN contacts c ON c.id = ec.contact_id
         WHERE ec.event_id = ? AND c.id IN (${placeholders})`,
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
      const { outcome, payload } = await queueTemplated(db, {
        templateKey: 'compose',
        eventId: job.event_id,
        contactId: contact.id,
        toEmail: contact.email,
        entityId: contact.id,
        bulkJobId: job.id,
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
      // Deliver inline rather than waiting for the next cron tick's
      // sweepOutbox (CNT-08, same disease as expandRemindTasks — see
      // deliverNow's doc comment): the sweep order in index.ts is
      // sweepReminders -> sweepOutbox -> sweepBulkJobs, so an outbox row this
      // expander enqueues is invisible to *this* tick's sweepOutbox and would
      // otherwise sit 'queued' until the next tick, while bulk_jobs.status
      // already flips to 'done' this tick and the compose dialog's poll loop
      // stops polling and reports a stale zero sent-count.
      if (outcome === 'queued' && payload) await deliverNow(db, env, payload.log_key, payload);
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
  } finally {
    // Release the claim lease taken in claimJob. The expander's own final
    // UPDATE decided the status (done/running/failed); clearing the lease
    // afterwards is what makes a still-'running' multi-tick job claimable by
    // the next sweep. Skipped only if the worker dies mid-tick, in which case
    // the lease expiry reopens the job.
    await env.DB.prepare(`UPDATE bulk_jobs SET claim_expires_at = NULL WHERE id = ?`).bind(job.id).run();
  }
}
