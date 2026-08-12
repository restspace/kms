// Review & scoring (docs/06, docs/12 M3): submission status operations and
// the decisions pipeline, evaluation plan/criteria/assignment admin, and the
// reviewer-facing queue + scoring endpoints. Mounted inside /app/api — the
// shared guard already ran (admins everywhere, reviewers on /review/* only).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { ALL_PARTICIPANT_ROLES } from '@kms/core';
import { createDb } from '@kms/db';
import type { AppEnv, Env } from '../env';
import type { SendTemplatedArgs } from '../mailer';
import { renderTemplatedPreview, sendTemplated } from '../mailer';
import { APPROVAL_ASK_HTML, sweepBulkJobs } from '../jobs/bulkJobs';
import { requestMagicLink } from './auth';
import { mintToken } from '../tokens';
import { bumpEventRevision } from '../revision';
import { snapshotParticipantsRevision } from '../participants';
import { isWriter } from '../access';
import type { SessionPayload } from '../session';
import { reviewWindowState } from '../reviewWindow';
import {
  addComment,
  appendRationale,
  canReviewerSeeThread,
  loadAuthorName,
  loadThread,
  pseudonymiseReviewerAuthors,
} from '../submissionComments';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const evaluationRoutes = new Hono<ApiEnv>();

const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

// Workplan 13 W3 (D4): employer approval is a flag alongside the accepted
// status, not a status value. NULL = not applicable / not asked. Exported —
// the submissions resource filter (adminApi.ts) validates against this same
// set, the SUBMISSION_STATUSES pattern; the column carries no CHECK so the
// vocabulary can grow here without a migration.
export const APPROVAL_STATES = new Set(['pending', 'granted', 'refused']);

// F14/ABS-11 — kept as a Set for O(1) membership checks; ALL_PARTICIPANT_ROLES
// (packages/core) is the canonical ordered vocabulary, in lockstep with the
// submission_participants.role CHECK constraint (0008 migration).
const PARTICIPANT_ROLES = new Set<string>(ALL_PARTICIPANT_ROLES);

const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Submission status operations
// ---------------------------------------------------------------------------

// PUT /submissions/:id/status — the grid's inline status edit.
evaluationRoutes.put('/submissions/:id/status', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const status = typeof body.status === 'string' ? body.status : '';
  if (!SUBMISSION_STATUSES.has(status)) return c.json({ error: 'invalid_status' }, 400);
  const result = await c.env.DB.prepare(
    'UPDATE submissions SET status = ?, updated_at = ? WHERE id = ? AND event_id = ?',
  )
    .bind(status, nowIso(), c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, status });
});

const APPROVAL_NOTE_MAX_CHARS = 2000;

// PUT /submissions/:id/approval { approval_state?, approval_note? } — the
// inline editor beside the status editor (workplan 13 W3). 'refused' is a
// prompt for a human, never an automatic withdrawal (D7): status is untouched
// by every value here.
evaluationRoutes.put('/submissions/:id/approval', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const sets: string[] = [];
  const params: unknown[] = [];
  if ('approval_state' in body) {
    const v = body.approval_state;
    if (v === null || v === '') {
      sets.push('approval_state = ?');
      params.push(null);
    } else if (typeof v === 'string' && APPROVAL_STATES.has(v)) {
      sets.push('approval_state = ?');
      params.push(v);
    } else {
      return c.json({ error: 'invalid_approval_state', allowed: [...APPROVAL_STATES] }, 400);
    }
  }
  if ('approval_note' in body) {
    const v = body.approval_note;
    if (v !== null && typeof v !== 'string') return c.json({ error: 'invalid_approval_note' }, 400);
    const trimmed = v === null ? null : v.trim();
    sets.push('approval_note = ?');
    params.push(trimmed === null || trimmed === '' ? null : trimmed.slice(0, APPROVAL_NOTE_MAX_CHARS));
  }
  if (sets.length === 0) return c.json({ error: 'no_fields' }, 400);

  const result = await c.env.DB.prepare(
    `UPDATE submissions SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
  )
    .bind(...params, nowIso(), c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  const row = await c.env.DB.prepare(
    'SELECT approval_state, approval_note FROM submissions WHERE id = ? AND event_id = ?',
  )
    .bind(c.req.param('id'), session.eventId)
    .first<{ approval_state: string | null; approval_note: string | null }>();
  return c.json({ ok: true, ...row });
});

function parseIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string').slice(0, 200) : [];
}

// ---------------------------------------------------------------------------
// Plan membership + review window (0012)
// ---------------------------------------------------------------------------

/**
 * SQL predicate for "this submission belongs to this plan", as the union of
 * the 0012 membership table and the legacy `submissions.evaluation_plan_id`
 * column that form routing rules still write on submit. Binds the plan id
 * twice — always spread `planBinds(planId)` where this fragment is used.
 *
 * This union is the fix for the "Assign left the round at 0 submissions" bug:
 * `assign` used to read the legacy column alone, which only a routing rule
 * could ever set, so a hand-made round had an empty submission set and the
 * INSERT loop ran zero times while still answering `{ ok: true }`.
 */
const MEMBER_SQL = (alias = 's') =>
  `(${alias}.evaluation_plan_id = ? OR EXISTS (
      SELECT 1 FROM evaluation_plan_submissions eps
      WHERE eps.plan_id = ? AND eps.submission_id = ${alias}.id))`;

const planBinds = (planId: string): [string, string] => [planId, planId];

/** Submission statuses that can be reviewed — drafts and withdrawals cannot. */
const REVIEWABLE_STATUS_SQL = `status NOT IN ('draft', 'withdrawn')`;

/**
 * ABS-07: the anonymise flag reverted to unchecked after a refetch. The
 * accepted-fields list only ever matched `typeof v === 'boolean'`, so any
 * other truthy spelling a client might send (1/0, "true"/"false" — what a
 * form post or a non-JS client produces) fell straight through the whole
 * `sets` builder and the handler still answered `{ ok: true }` with a 200:
 * a silent no-op that reads to the UI as "saved" and to the next GET as
 * "never happened". Parse permissively, and reject what we cannot read
 * instead of pretending it was stored.
 */
function parseBoolish(raw: unknown): boolean | null {
  if (raw === true || raw === 1 || raw === '1' || raw === 'true') return true;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return null;
}

/** ISO-8601 text or null; anything unparseable is rejected by the caller. */
function parseIsoOrNull(raw: unknown): { ok: true; value: string | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false };
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return { ok: false };
  return { ok: true, value: new Date(ms).toISOString() };
}

// Moved to ../reviewWindow so the submission-comment gate (workplan 7 D3) can
// share the derivation; re-exported to keep this module the reference point.
export { reviewWindowState, type ReviewWindow } from '../reviewWindow';

// POST /submissions/bulk-status — queue moves from the bulk-action bar.
evaluationRoutes.post('/submissions/bulk-status', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = parseIds(body.ids);
  const status = typeof body.status === 'string' ? body.status : '';
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);
  if (!SUBMISSION_STATUSES.has(status)) return c.json({ error: 'invalid_status' }, 400);
  const placeholders = ids.map(() => '?').join(', ');
  const result = await c.env.DB.prepare(
    `UPDATE submissions SET status = ?, updated_at = ? WHERE event_id = ? AND id IN (${placeholders})`,
  )
    .bind(status, nowIso(), session.eventId, ...ids)
    .run();
  return c.json({ ok: true, changed: result.meta.changes });
});

/**
 * Auto-assign on-accept tasks (docs/05 §6, docs/06 §5): automatic tasks with
 * trigger on_accept and a submission target attach to the submission's
 * primary contact (falling back to the submitter). Set-based `INSERT OR
 * IGNORE … SELECT` against the unique (task_id, contact_id, submission_id)
 * index (0005) makes this safe to re-run: `RETURNING` only reports rows this
 * call actually created, so already-assigned tasks are silently skipped and
 * never re-emailed (sweep item P1-5). `send` is injected so the same core
 * works from a request (sendTemplated, immediate attempt) and from the bulk
 * job expander (queueTemplated, cron has no request Context). The entity id
 * is always the plain assignment id — an expander tags its sends with
 * `bulkJobId` instead, keeping batch membership out of the idempotency key
 * (see jobs/bulkJobs.ts).
 */
export async function autoAssignAcceptTasksCore(
  db: D1Database,
  eventId: string,
  submission: { id: string; code: string; title: string },
  eventName: string,
  eventSlug: string,
  appUrl: string,
  send: (args: SendTemplatedArgs) => Promise<unknown>,
): Promise<number> {
  const { results: tasks } = await db
    .prepare(
      `SELECT id, title, due_at FROM tasks
       WHERE event_id = ? AND assignment_mode = 'automatic' AND "trigger" = 'on_accept' AND target = 'submission'`,
    )
    .bind(eventId)
    .all<{ id: string; title: string; due_at: string | null }>();
  if (tasks.length === 0) return 0;
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  const owner = await db
    .prepare(
      `SELECT c.id, c.email, c.first_name FROM contacts c
       WHERE c.id = COALESCE(
         (SELECT sp.contact_id FROM submission_participants sp
          WHERE sp.submission_id = ?1 AND sp.is_primary_contact = 1 LIMIT 1),
         (SELECT s.submitter_contact_id FROM submissions s WHERE s.id = ?1))`,
    )
    .bind(submission.id)
    .first<{ id: string; email: string; first_name: string | null }>();
  if (!owner) return 0;

  const { results: inserted } = await db
    .prepare(
      `INSERT OR IGNORE INTO task_assignments (id, task_id, contact_id, submission_id, status)
       SELECT lower(hex(randomblob(16))), t.id, ?, ?, 'not_started'
       FROM tasks t
       WHERE t.event_id = ? AND t.assignment_mode = 'automatic' AND t."trigger" = 'on_accept' AND t.target = 'submission'
       RETURNING id, task_id`,
    )
    .bind(owner.id, submission.id, eventId)
    .all<{ id: string; task_id: string }>();

  for (const row of inserted) {
    const task = taskById.get(row.task_id);
    if (!task) continue;
    const dueLine = task.due_at
      ? `, due ${new Date(task.due_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
      : '';
    await send({
      templateKey: 'task_assigned',
      eventId,
      contactId: owner.id,
      toEmail: owner.email,
      entityId: row.id,
      context: {
        event: { name: eventName },
        speaker: { first_name: owner.first_name ?? 'there' },
        task: { title: `${task.title} — ${submission.code}`, due_line: dueLine, url: `${appUrl}/portal/${eventSlug}/tasks` },
      },
    });
  }
  return inserted.length;
}
// Note: no request-path wrapper here (unlike sendScheduleEmails/Core) —
// auto-assign is now only ever triggered from the bulk_jobs expander
// (jobs/bulkJobs.ts), since send-decisions moved off the request path
// entirely (sweep item P2-19). Call autoAssignAcceptTasksCore directly with
// `(args) => sendTemplated(c, args)` if a future request-path caller needs
// the immediate-attempt behaviour.

// POST /submissions/send-decisions — the batch notify (docs/06 §5, sweep item
// P2-19). No longer sends in-request: validates the selection, snapshots it
// into a bulk_jobs row, and returns immediately. The cron expander
// (jobs/bulkJobs.ts) does the actual flip/send/auto-assign work in bounded
// ticks. The response keeps the legacy shape the SPA reads — accepted/
// declined are cheap counts of the validated selection (what *will* happen),
// tasks_assigned is always 0 here since tasks are assigned during expansion.
evaluationRoutes.post('/submissions/send-decisions', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = parseIds(body.ids);
  const includeFeedback = body.include_feedback === true;
  // Workplan 10 §4: `preflight: true` computes and returns — without creating
  // a job — the usual counts plus speakers_with_pending, so the UI can warn
  // about mixed-completeness speakers before anything sends.
  // `hold_contact_ids` excludes those speakers' rows from this send (their
  // rows stay in queue states, visible as "staged" on the dashboard — no new
  // status, no new table). `pending_note` rides into params_json and controls
  // the merged email's still-under-review line.
  const preflight = body.preflight === true;
  const holdContactIds = Array.isArray(body.hold_contact_ids)
    ? body.hold_contact_ids.filter((x): x is string => typeof x === 'string')
    : [];
  const pendingNote = body.pending_note !== false;
  // Workplan 13 W3: opt-in per send, never the default — adds the
  // {{approval_ask}} block to accept emails and flags the covered accepted
  // submissions approval_state='pending' (see jobs/bulkJobs.ts).
  const approvalAsk = body.approval_ask === true;
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  const event = await db
    .prepare('SELECT name, slug FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ name: string; slug: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  const placeholders = ids.map(() => '?').join(', ');
  // Mirrors expandSendDecisions' fallback (jobs/bulkJobs.ts): a submitter with
  // no usable email still counts as reachable here if another participant on
  // the submission has one, so this upfront preflight count doesn't overstate
  // skipped_no_submitter versus what actually sends.
  const { results } = await db
    .prepare(
      `SELECT s.id, s.title, s.code, s.status, s.notified_at, s.submitter_contact_id,
              COALESCE(NULLIF(c.email, ''), fb.email) AS submitter_email,
              COALESCE(c.first_name, fb.first_name) AS submitter_first_name
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       LEFT JOIN (
         SELECT sp.submission_id, c2.email, c2.first_name,
                ROW_NUMBER() OVER (PARTITION BY sp.submission_id ORDER BY sp.position) AS rn
         FROM submission_participants sp
         JOIN contacts c2 ON c2.id = sp.contact_id
         WHERE NULLIF(c2.email, '') IS NOT NULL
       ) fb ON fb.submission_id = s.id AND fb.rn = 1
       WHERE s.event_id = ? AND s.id IN (${placeholders})`,
    )
    .bind(session.eventId, ...ids)
    .all<{
      id: string; title: string; code: string; status: string; notified_at: string | null;
      submitter_contact_id: string | null; submitter_email: string | null; submitter_first_name: string | null;
    }>();

  // Send-eligible (CFP-14): queue rows as always, PLUS rows already decided
  // directly (status set to accepted/declined without the queue step) that
  // were never notified — previously these were silently skipped. A decided
  // row with no reachable email is excluded here rather than in the expander:
  // it has no status flip to perform and no email to send, so admitting it
  // would leave the job a row it can never make progress on.
  const isQueue = (s: { status: string }) => s.status === 'accept_queue' || s.status === 'decline_queue';
  const isDecided = (s: { status: string }) => s.status === 'accepted' || s.status === 'declined';
  const allQueued = results.filter(isQueue);
  const decidedUnnotified = results.filter((s) => isDecided(s) && s.notified_at === null && s.submitter_email);
  const decidedNoEmail = results.filter((s) => isDecided(s) && s.notified_at === null && !s.submitter_email).length;
  const allEligible = [...allQueued, ...decidedUnnotified];
  // Already-notified decided rows stay skipped, and are reported so the UI
  // can say "nothing re-sent" rather than a bare zero (docs/06 §5).
  const skippedNotified = results.filter((s) => !isQueue(s) && s.notified_at !== null).length;

  if (preflight) {
    // For each distinct submitter in the eligible selection: their *other*
    // submissions still undecided — status not in (accepted, declined,
    // withdrawn) and not part of this selection. `draft` is excluded by
    // decision (§4): a never-submitted draft shouldn't hold a decision email.
    const speakerIds = [...new Set(allEligible.map((s) => s.submitter_contact_id).filter((x): x is string => x !== null))];
    const speakersWithPending: Array<{
      contact_id: string; name: string; pending_count: number; pending_titles: string[];
    }> = [];
    if (speakerIds.length > 0) {
      const speakerPh = speakerIds.map(() => '?').join(', ');
      const { results: pending } = await db
        .prepare(
          `SELECT s.submitter_contact_id AS contact_id, s.title,
                  c.first_name, c.last_name, c.email
           FROM submissions s
           JOIN contacts c ON c.id = s.submitter_contact_id
           WHERE s.event_id = ? AND s.submitter_contact_id IN (${speakerPh})
             AND s.status NOT IN ('accepted', 'declined', 'withdrawn', 'draft')
             AND s.id NOT IN (${placeholders})
           ORDER BY s.submitter_contact_id, s.created_at`,
        )
        .bind(session.eventId, ...speakerIds, ...ids)
        .all<{ contact_id: string; title: string; first_name: string | null; last_name: string | null; email: string }>();
      for (const row of pending) {
        const last = speakersWithPending[speakersWithPending.length - 1];
        if (last && last.contact_id === row.contact_id) {
          last.pending_count += 1;
          if (last.pending_titles.length < 3) last.pending_titles.push(row.title);
        } else {
          speakersWithPending.push({
            contact_id: row.contact_id,
            name: [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email,
            pending_count: 1,
            pending_titles: [row.title],
          });
        }
      }
    }
    // CFP-14 review step: `preview: true` additionally renders the accept and
    // decline emails for a real sample recipient — through the exact
    // override/theme/template pipeline the expander uses
    // (renderTemplatedPreview), so what the dialog shows cannot drift from
    // what sends. `null` on a side means no rows there, or the template is
    // disabled (the dialog warns). `merged_speakers` counts speakers with ≥2
    // eligible rows, who receive one combined decision_summary instead.
    let previews: Record<string, unknown> | undefined;
    if (body.preview === true) {
      const portalUrl = `${c.env.APP_URL}/portal/${event.slug}`;
      const renderFor = async (s: (typeof allEligible)[number] | undefined, accept: boolean) => {
        if (!s || !s.submitter_email) return null;
        const rendered = await renderTemplatedPreview(db, {
          templateKey: accept ? 'decision_accepted' : 'decision_declined',
          eventId: session.eventId,
          context: {
            event: { name: event.name },
            speaker: { first_name: s.submitter_first_name ?? 'there' },
            submission: { title: s.title, code: s.code },
            portal_url: portalUrl,
            ...(accept && approvalAsk ? { approval_ask: APPROVAL_ASK_HTML } : {}),
          },
        });
        return rendered ? { ...rendered, sample_to: s.submitter_email } : null;
      };
      const bySpeaker = new Map<string, number>();
      for (const s of allEligible) {
        if (s.submitter_contact_id) bySpeaker.set(s.submitter_contact_id, (bySpeaker.get(s.submitter_contact_id) ?? 0) + 1);
      }
      previews = {
        accepted: await renderFor(
          allEligible.find((s) => (s.status === 'accept_queue' || s.status === 'accepted') && s.submitter_email),
          true,
        ),
        declined: await renderFor(
          allEligible.find((s) => (s.status === 'decline_queue' || s.status === 'declined') && s.submitter_email),
          false,
        ),
        merged_speakers: [...bySpeaker.values()].filter((n) => n >= 2).length,
      };
    }

    return c.json({
      ok: true,
      preflight: true,
      accepted: allEligible.filter((s) => s.status === 'accept_queue' || s.status === 'accepted').length,
      declined: allEligible.filter((s) => s.status === 'decline_queue' || s.status === 'declined').length,
      resend: decidedUnnotified.length,
      tasks_assigned: 0,
      skipped: ids.length - allEligible.length,
      skipped_notified: skippedNotified,
      skipped_no_submitter: allQueued.filter((s) => !s.submitter_email).length + decidedNoEmail,
      speakers_with_pending: speakersWithPending,
      ...(previews ? { previews } : {}),
      job_id: null,
    });
  }

  // Hold filtering happens here, before the ids are snapshotted into the job
  // — not in the expander's select (deliberate deviation from the plan doc's
  // §4 sketch): job.total is the snapshot length, so ids the expander would
  // filter out could never be counted and the job would sit 'running'
  // forever. Held rows simply never enter the job; they stay queued.
  const holdSet = new Set(holdContactIds);
  const queued = holdSet.size > 0
    ? allEligible.filter((s) => s.submitter_contact_id === null || !holdSet.has(s.submitter_contact_id))
    : allEligible;
  const held = allEligible.length - queued.length;
  const accepted = queued.filter((s) => s.status === 'accept_queue' || s.status === 'accepted').length;
  const declined = queued.filter((s) => s.status === 'decline_queue' || s.status === 'declined').length;
  const resend = queued.filter((s) => isDecided(s)).length;
  // CFP-14: a submission with no submitter contact (or a submitter with no
  // email — common on admin-created records) still gets its status flipped
  // by the expander, but no email ever queues and notified_at stays unset.
  // Surfacing the count upfront (additive — existing clients ignore it) lets
  // the UI say "2 sent, 1 skipped (no submitter)" instead of implying every
  // decision was communicated. `GET /app/api/bulk-jobs/:id` reports the same
  // count post-expansion via `skipped_no_submitter` once sends have run.
  const queuedNoSubmitter = queued.filter((s) => !s.submitter_email).length;

  let jobId: string | null = null;
  if (queued.length > 0) {
    jobId = crypto.randomUUID();
    const ts = nowIso();
    await db
      .prepare(
        `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
         VALUES (?, ?, 'send-decisions', 'pending', ?, ?, 0, ?, ?, ?)`,
      )
      .bind(
        jobId,
        session.eventId,
        JSON.stringify({ ids: queued.map((s) => s.id), include_feedback: includeFeedback, pending_note: pendingNote, approval_ask: approvalAsk }),
        queued.length,
        session.contactId,
        ts,
        ts,
      )
      .run();
    // Expand now rather than on the next cron tick, so the decision toast's
    // first polls see real progress instead of "0/N processed" for up to a
    // minute (same dead-minute fix as dashboard /remind).
    try {
      c.executionCtx.waitUntil(sweepBulkJobs(c.env));
    } catch {
      await sweepBulkJobs(c.env); // environments without an execution context (tests)
    }
  }

  return c.json({
    ok: true,
    accepted,
    declined,
    resend,
    tasks_assigned: 0,
    skipped: ids.length - allEligible.length,
    skipped_notified: skippedNotified,
    skipped_no_submitter: queuedNoSubmitter + decidedNoEmail,
    held,
    job_id: jobId,
  });
});

// ---------------------------------------------------------------------------
// Submission field edit (F14/ABS-11): the admin edit form previously only
// exposed title/description/format via the inline notes/status paths — this
// is the general-purpose PUT the RecordForm-backed submissions edit tab
// calls. Mirrors restApi.ts's pickSubmissionFields (the /api/v1 surface's
// version), duplicated deliberately rather than imported: that file's
// comment already warns its field whitelist is under concurrent edit
// elsewhere and asks callers not to share it.
// ---------------------------------------------------------------------------

const SUBMISSION_WRITE_FIELDS = ['description', 'format', 'level', 'language'] as const;

/** POST /submissions — manual create (source='manual'), same code scheme as restApi.ts. */
evaluationRoutes.post('/submissions', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return c.json({ error: 'title_required' }, 400);

  const fields: Record<string, string | null> = {};
  for (const field of SUBMISSION_WRITE_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v === null || v === '') fields[field] = null;
    else if (typeof v === 'string') fields[field] = v;
  }

  let trackId: string | null = null;
  if (typeof body.track_id === 'string' && body.track_id) {
    const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
      .bind(body.track_id, session.eventId)
      .first();
    if (!track) return c.json({ error: 'invalid_track' }, 400);
    trackId = body.track_id;
  }
  let roomId: string | null = null;
  if (typeof body.room_id === 'string' && body.room_id) {
    const room = await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND event_id = ?')
      .bind(body.room_id, session.eventId)
      .first();
    if (!room) return c.json({ error: 'invalid_room' }, 400);
    roomId = body.room_id;
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  const result = await c.env.DB.prepare(
    `INSERT INTO submissions
       (id, event_id, code, kind, title, description, status, format, level, language, track_id, room_id, source, created_at, updated_at)
     SELECT ?, ?,
       'SESS-' || (COALESCE((SELECT MAX(CAST(SUBSTR(code,6) AS INTEGER)) FROM submissions WHERE event_id=? AND code LIKE 'SESS-%'),0)+1),
       'abstract', ?, ?, 'pending', ?, ?, ?, ?, ?, 'manual', ?, ?`,
  )
    .bind(
      id, session.eventId, session.eventId,
      title, fields.description ?? null,
      fields.format ?? null, fields.level ?? null, fields.language ?? null,
      trackId, roomId,
      ts, ts,
    )
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'create_failed' }, 422);
  await bumpEventRevision(c.env, session.eventId);
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE id = ?').bind(id).first();
  return c.json(row, 201);
});

/** PUT /submissions/:id — title/description/format/level/language/track/room. */
evaluationRoutes.put('/submissions/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const sets: string[] = [];
  const params: unknown[] = [];

  if ('title' in body) {
    const v = typeof body.title === 'string' ? body.title.trim() : '';
    if (!v) return c.json({ error: 'title_required' }, 400);
    sets.push('title = ?');
    params.push(v);
  }
  for (const field of SUBMISSION_WRITE_FIELDS) {
    if (!(field in body)) continue;
    const v = body[field];
    if (v !== null && typeof v !== 'string') return c.json({ error: `invalid_${field}` }, 400);
    sets.push(`${field} = ?`);
    params.push(v === '' ? null : v);
  }
  // content_approved (0010 migration, CNT-12/w3): the public-visibility gate,
  // independent of the acceptance `status`. Accepts booleans and 0/1 so both
  // a checkbox-style client and a raw toggle can drive it.
  if ('content_approved' in body) {
    const v = body.content_approved;
    if (v !== true && v !== false && v !== 0 && v !== 1) {
      return c.json({ error: 'invalid_content_approved' }, 400);
    }
    sets.push('content_approved = ?');
    params.push(v === true || v === 1 ? 1 : 0);
  }
  if ('track_id' in body) {
    const v = body.track_id;
    if (v === null || v === '') {
      sets.push('track_id = ?');
      params.push(null);
    } else if (typeof v === 'string') {
      const track = await c.env.DB.prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
        .bind(v, session.eventId)
        .first();
      if (!track) return c.json({ error: 'invalid_track' }, 400);
      sets.push('track_id = ?');
      params.push(v);
    } else {
      return c.json({ error: 'invalid_track' }, 400);
    }
  }
  if ('room_id' in body) {
    const v = body.room_id;
    if (v === null || v === '') {
      sets.push('room_id = ?');
      params.push(null);
    } else if (typeof v === 'string') {
      const room = await c.env.DB.prepare('SELECT id FROM rooms WHERE id = ? AND event_id = ?')
        .bind(v, session.eventId)
        .first();
      if (!room) return c.json({ error: 'invalid_room' }, 400);
      sets.push('room_id = ?');
      params.push(v);
    } else {
      return c.json({ error: 'invalid_room' }, 400);
    }
  }

  if (sets.length === 0) return c.json({ error: 'no_fields' }, 400);
  sets.push('updated_at = ?');
  params.push(nowIso());

  // Content history (CFP content-revisions): snapshot the PRE-edit
  // title/description before the UPDATE lands, batched with it so the
  // snapshot and the change it precedes commit together. Only worth a row
  // when this edit actually touches one of those fields — a format/track/
  // room-only PUT leaves no content to have "reverted".
  const statements: D1PreparedStatement[] = [];
  if ('title' in body || 'description' in body) {
    const before = await c.env.DB.prepare(
      'SELECT title, description FROM submissions WHERE id = ? AND event_id = ?',
    )
      .bind(id, session.eventId)
      .first<{ title: string; description: string | null }>();
    if (before) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO content_revisions
             (id, event_id, submission_id, title, description, edited_by, edited_by_name, source, edited_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'admin', ?)`,
        ).bind(
          crypto.randomUUID(),
          session.eventId,
          id,
          before.title,
          before.description,
          session.contactId,
          await loadAuthorName(c.env.DB, session.contactId),
          nowIso(),
        ),
      );
    }
  }
  statements.push(
    c.env.DB.prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`).bind(
      ...params,
      id,
      session.eventId,
    ),
  );
  const batchResults = await c.env.DB.batch(statements);
  const updateResult = batchResults[batchResults.length - 1];
  if (!updateResult || updateResult.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

/**
 * GET /submissions/:id/revisions — content history (admin/owner + reviewer
 * seats, same guard as every other /app/api route mounted through
 * adminApiRoutes). Newest first; each row is a pre-edit snapshot, so reading
 * them in order reconstructs "what did this say before edit N" without any
 * rollback machinery — none is built here by design.
 */
evaluationRoutes.get('/submissions/:id/revisions', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const submission = await c.env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first();
  if (!submission) return c.json({ error: 'not_found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, title, description, edited_by, edited_by_name, source, edited_at
     FROM content_revisions
     WHERE submission_id = ? AND event_id = ?
     ORDER BY edited_at DESC, id DESC`,
  )
    .bind(id, session.eventId)
    .all();
  return c.json({ items: results ?? [] });
});

// ---------------------------------------------------------------------------
// Submission participants (F14/ABS-11): adding a co-speaker/co-author/etc.
// retroactively — the portal's own submit flow (submit.tsx) already does the
// atomic upsert-contact-by-email version of this; here the admin already
// knows the contact_id (picked from Speakers), so this is a plain insert
// against the existing contact, scoped to the organiser's event.
//
// Workplan 14 F5 (decision D7): the eval sweep's ABS complaint ("co-author
// cannot be added after acceptance") was investigated against this endpoint
// specifically — unlike the speaker portal (portal.ts's isEditLocked), it has
// never gated on submission status, so an organiser could already add/edit/
// remove participants on a decided (accepted/declined) submission; there was
// no status check to "drop" here. What WAS missing is traceability: unlike
// the submission title/description path just above, no snapshot was taken
// before the roster changed. snapshotParticipantsRevision (moved to
// ../participants.ts for ABS-11, shared with the portal's co-author routes)
// closes that gap so a post-decision participant change is now provable, the
// same way D7 asks for, while the speaker portal stays locked exactly as
// before.
// ---------------------------------------------------------------------------

/** POST /submissions/:id/participants { contact_id, role, is_primary_contact? } */
evaluationRoutes.post('/submissions/:id/participants', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const submissionId = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  const role = typeof body.role === 'string' ? body.role : 'speaker';
  if (!contactId) return c.json({ error: 'contact_id_required' }, 400);
  if (!PARTICIPANT_ROLES.has(role)) {
    return c.json({ error: 'invalid_role', allowed: [...PARTICIPANT_ROLES] }, 400);
  }

  // No status gate: adding a participant is allowed regardless of whether
  // this submission has already been decided (D7) — the speaker portal is
  // the only surface where post-decision edits stay locked.
  const submission = await c.env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND event_id = ?')
    .bind(submissionId, session.eventId)
    .first();
  if (!submission) return c.json({ error: 'not_found' }, 404);
  // 0015: the join to event_contacts is the tenancy guard the old
  // `contacts.event_id = ?` was — a contact from a sibling event in the same
  // org must not be seatable on this event's submission.
  // job_title/company double as the W1c provenance stamp below: the join row
  // freezes what THIS event's profile said at link time (D3).
  const contact = await c.env.DB.prepare(
    `SELECT c.id, ec.job_title, ec.company FROM contacts c
     JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
     WHERE c.id = ?`,
  )
    .bind(session.eventId, contactId)
    .first<{ id: string; job_title: string | null; company: string | null }>();
  if (!contact) return c.json({ error: 'contact_not_found' }, 404);

  const { results: existingRows } = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS max_position FROM submission_participants WHERE submission_id = ?',
  ).bind(submissionId).all<{ max_position: number }>();
  const nextPosition = (existingRows[0]?.max_position ?? -1) + 1;

  const id = crypto.randomUUID();
  const ts = nowIso();
  const revisionStmt = await snapshotParticipantsRevision(c.env.DB, {
    eventId: session.eventId,
    submissionId,
    editedBy: session.contactId,
    editedByName: await loadAuthorName(c.env.DB, session.contactId),
    editedAt: ts,
    source: 'admin',
  });
  const insertStmt = c.env.DB.prepare(
    `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact, title_at_time, org_at_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, submissionId, contactId, role, nextPosition, body.is_primary_contact === true ? 1 : 0, contact.job_title, contact.company);
  try {
    await c.env.DB.batch([revisionStmt, insertStmt]);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'already_participant' }, 409);
    throw err;
  }
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, id }, 201);
});

/** PUT /submissions/:id/participants/:participantId { role } */
evaluationRoutes.put('/submissions/:id/participants/:participantId', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const role = typeof body.role === 'string' ? body.role : '';
  if (!PARTICIPANT_ROLES.has(role)) {
    return c.json({ error: 'invalid_role', allowed: [...PARTICIPANT_ROLES] }, 400);
  }
  try {
    const result = await c.env.DB.prepare(
      `UPDATE submission_participants SET role = ?
       WHERE id = ? AND submission_id = ?
         AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
    )
      .bind(role, c.req.param('participantId'), c.req.param('id'), session.eventId)
      .run();
    if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    if (message.includes('UNIQUE')) return c.json({ error: 'already_participant' }, 409);
    throw err;
  }
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// PUT /submissions/:id/participants/:participantId/confirm { confirmed: boolean }
//
// SPK-04/w2: confirmed_at previously only got set once, automatically, when
// a submitter added themself as a participant (submit.tsx) — there was no
// endpoint to change it afterwards, so the dashboard's "Confirmed N /
// Awaiting confirmation M" stat (routes/dashboard.ts, keyed off this same
// column) was effectively read-only trivia: an organiser could see it but
// never act on it, and a co-speaker added later by staff could never be
// marked confirmed at all. This lets an organiser flip it either way from
// the submission's participant list (workspace/extras.tsx).
evaluationRoutes.put('/submissions/:id/participants/:participantId/confirm', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const confirmed = body.confirmed === true || body.confirmed === 1;
  const result = await c.env.DB.prepare(
    `UPDATE submission_participants SET confirmed_at = ?
     WHERE id = ? AND submission_id = ?
       AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
  )
    .bind(confirmed ? nowIso() : null, c.req.param('participantId'), c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, confirmed });
});

/** DELETE /submissions/:id/participants/:participantId */
evaluationRoutes.delete('/submissions/:id/participants/:participantId', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const result = await c.env.DB.prepare(
    `DELETE FROM submission_participants
     WHERE id = ? AND submission_id = ?
       AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
  )
    .bind(c.req.param('participantId'), c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// GET /submissions/:id/detail — the workspace detail tab payload.
evaluationRoutes.get('/submissions/:id/detail', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const id = c.req.param('id');
  const submission = await db
    .prepare(
      `SELECT s.*, t.name AS track_name, r.name AS room_name, ep.name AS plan_name, f.internal_name AS form_name
       FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN rooms r ON r.id = s.room_id
       LEFT JOIN evaluation_plans ep ON ep.id = s.evaluation_plan_id
       LEFT JOIN submission_forms f ON f.id = s.form_id
       WHERE s.id = ? AND s.event_id = ?`,
    )
    .bind(id, session.eventId)
    .first<Record<string, unknown>>();
  if (!submission) return c.json({ error: 'not_found' }, 404);

  const [answers, participants, reviews, tags, comments] = await Promise.all([
    db.prepare(
      `SELECT COALESCE(q.label, f.label) AS label, a.value_json, q.position
       FROM submission_answers a
       JOIN form_questions q ON q.id = a.question_id
       JOIN field_definitions f ON f.id = q.field_id
       WHERE a.submission_id = ? ORDER BY q.position`,
    ).bind(id).all(),
    db.prepare(
      `SELECT sp.id AS participant_id, sp.role, sp.position, sp.is_primary_contact, sp.confirmed_at, c.id AS contact_id,
              c.first_name, c.last_name, c.email,
              CASE WHEN ec.biography IS NOT NULL AND ec.biography != '' THEN 1 ELSE 0 END AS has_bio,
              CASE WHEN ec.headshot_asset_id IS NOT NULL THEN 1 ELSE 0 END AS has_headshot,
              ec.headshot_asset_id AS headshot_asset_id
       FROM submission_participants sp
       JOIN contacts c ON c.id = sp.contact_id
       -- 0015: bio/headshot live on the event_contacts row for THIS event, so a
       -- speaker who filled them in on another event in the org still reads as
       -- incomplete here. LEFT so a participant with no membership row (which
       -- should not happen) is still listed, just with both flags clear, rather
       -- than silently dropping off the submission.
       LEFT JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?2
       WHERE sp.submission_id = ?1 ORDER BY sp.position`,
    ).bind(id, session.eventId).all(),
    // Every review recorded against this submission in *any* round of this
    // event. It used to filter on `submissions.evaluation_plan_id`, which
    // since 0012 is only the legacy routing column: a submission routed to
    // plan A and then put into round B by an organiser keeps A there, so
    // reviews saved in B were written, aggregated and counted but never
    // read back — the detail said "No reviews yet" while the dashboard said
    // 1/1 done. Reviews of a round the submission was later removed from
    // stay visible too; they are a record of work done, and the plan name
    // says which round each one belongs to.
    db.prepare(
      `SELECT r.weighted_total, r.conflict_of_interest, r.created_at,
              r.plan_id, p.name AS plan_name,
              NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS reviewer_name
       FROM reviews r
       JOIN contacts c ON c.id = r.reviewer_contact_id
       JOIN evaluation_plans p ON p.id = r.plan_id
       WHERE r.submission_id = ? AND p.event_id = ?
       ORDER BY p.created_at, r.created_at`,
    ).bind(id, session.eventId).all(),
    db.prepare(
      `SELECT tg.name FROM submission_tags st JOIN tags tg ON tg.id = st.tag_id WHERE st.submission_id = ?`,
    ).bind(id).all(),
    loadThread(db, id),
  ]);

  // Per-round means, additive alongside the flat `reviews` list above. The
  // grid's rating_cache-derived column deliberately pools every plan's
  // reviews into one number (adminApi.ts's `rating` expression, kept as-is —
  // it fixed reviews that were invisible after a submission moved rounds);
  // but a single pooled 3.9 on the detail page hides that it is blending
  // scores from independent evaluation criteria/scales across rounds. This
  // mirrors ratingCacheStatement's own AVG(weighted_total) per plan_id so a
  // round's mean here always matches what rating_cache would say for that
  // plan — same rows, same aggregation, just grouped instead of pooled.
  const planMeans = new Map<string, { plan_id: string; plan_name: string | null; mean: number; count: number }>();
  for (const row of reviews.results as Array<{ plan_id: string; plan_name: string | null; weighted_total: number }>) {
    let entry = planMeans.get(row.plan_id);
    if (!entry) {
      entry = { plan_id: row.plan_id, plan_name: row.plan_name, mean: 0, count: 0 };
      planMeans.set(row.plan_id, entry);
    }
    entry.mean += row.weighted_total;
    entry.count += 1;
  }
  const review_plan_means = [...planMeans.values()].map((entry) => ({
    ...entry,
    mean: Math.round((entry.mean / entry.count) * 100) / 100,
  }));

  return c.json({
    submission,
    answers: answers.results,
    participants: participants.results,
    reviews: reviews.results,
    review_plan_means,
    tags: tags.results.map((t) => (t as { name: string }).name),
    comments,
  });
});

// POST /submissions/:id/comments — organiser reply on the discussion thread
// (workplan 7). Append-only: there is deliberately no update or delete route.
evaluationRoutes.post('/submissions/:id/comments', async (c) => {
  const session = c.get('session');
  // The shared guard already refuses reviewers outside /review/*; this is the
  // explicit second lock, matching PUT /submissions/:id/notes.
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const id = c.req.param('id');
  const submission = await db
    .prepare('SELECT id FROM submissions WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first<{ id: string }>();
  if (!submission) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.body !== 'string') return c.json({ error: 'empty_body' }, 400);
  const commentId = await addComment(db, {
    eventId: session.eventId,
    submissionId: id,
    authorContactId: session.contactId,
    authorRole: session.role,
    authorName: await loadAuthorName(db, session.contactId),
    body: body.body,
  });
  if (!commentId) return c.json({ error: 'empty_body' }, 400);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, id: commentId, comments: await loadThread(db, id) });
});

// ---------------------------------------------------------------------------
// Evaluation plan admin
// ---------------------------------------------------------------------------

// GET /evaluation/overview — plans + criteria + progress + the reviewer pool.
// Always answers with the four arrays, empty ones included: a brand-new event
// with no plan, no criteria and no assignments is a valid, renderable state,
// not an error. Failures answer with JSON too — the admin section shows the
// machine code, where an unhandled throw would give it an HTML body it cannot
// parse (which is what stranded it on "Loading…").
evaluationRoutes.get('/evaluation/overview', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  try {
    const [plans, criteria, reviewers, stats, pool, workload, queueTotals] = await Promise.all([
      db.prepare('SELECT * FROM evaluation_plans WHERE event_id = ? ORDER BY created_at').bind(session.eventId).all(),
      db.prepare(
        `SELECT sc.* FROM scoring_criteria sc
         JOIN evaluation_plans p ON p.id = sc.plan_id
         WHERE p.event_id = ? ORDER BY sc.plan_id, sc.position`,
      ).bind(session.eventId).all(),
      db.prepare(
        `SELECT c.id, c.email, NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS name
         FROM event_users eu JOIN contacts c ON c.id = eu.contact_id
         WHERE eu.event_id = ? AND eu.role IN ('reviewer', 'admin', 'owner')
         ORDER BY c.last_name`,
      ).bind(session.eventId).all(),
      // `submissions` counts plan *membership* (0012 table ∪ the legacy
      // routing column), which is what Assign now deals out — before, this
      // number and the assign query could only ever be 0 for a hand-made plan.
      db.prepare(
        `SELECT p.id AS plan_id,
                (SELECT COUNT(*) FROM submissions s
                  WHERE s.event_id = p.event_id
                    AND (s.evaluation_plan_id = p.id OR EXISTS (
                          SELECT 1 FROM evaluation_plan_submissions eps
                          WHERE eps.plan_id = p.id AND eps.submission_id = s.id))) AS submissions,
                (SELECT COUNT(*) FROM review_assignments ra WHERE ra.plan_id = p.id) AS assignments,
                (SELECT COUNT(*) FROM review_assignments ra WHERE ra.plan_id = p.id AND ra.status = 'complete') AS completed
         FROM evaluation_plans p WHERE p.event_id = ?`,
      ).bind(session.eventId).all(),
      db.prepare(
        `SELECT epr.plan_id, epr.contact_id, epr.max_assignments FROM evaluation_plan_reviewers epr
         JOIN evaluation_plans p ON p.id = epr.plan_id WHERE p.event_id = ?`,
      ).bind(session.eventId).all(),
      // Per-reviewer workload for the progress view (docs/06 §4) — also what
      // the "Remind lagging" action reads to decide who is behind.
      db.prepare(
        `SELECT ra.plan_id, ra.reviewer_contact_id AS contact_id,
                COUNT(*) AS assigned,
                SUM(CASE WHEN ra.status IN ('complete', 'skipped') THEN 1 ELSE 0 END) AS completed
         FROM review_assignments ra JOIN evaluation_plans p ON p.id = ra.plan_id
         WHERE p.event_id = ?
         GROUP BY ra.plan_id, ra.reviewer_contact_id`,
      ).bind(session.eventId).all(),
      // Per-reviewer totals matching what GET /review/queue actually hands
      // that reviewer: summed across every *active* plan they're assigned to,
      // not grouped per plan like `workload` above. `workload` stays
      // per-plan (the Assign panel balances load *within* one plan), but a
      // per-plan number read as "their assignment count" undercounts the
      // instant a reviewer sits on two active plans at once — this is the
      // figure that agrees with their queue.
      db.prepare(
        `SELECT ra.reviewer_contact_id AS contact_id,
                COUNT(*) AS assigned,
                SUM(CASE WHEN ra.status IN ('complete', 'skipped') THEN 1 ELSE 0 END) AS completed
         FROM review_assignments ra JOIN evaluation_plans p ON p.id = ra.plan_id
         WHERE p.event_id = ? AND p.status = 'active'
         GROUP BY ra.reviewer_contact_id`,
      ).bind(session.eventId).all(),
    ]);
    // ABS-07: this payload carries the plan flags the editor re-renders from
    // (anonymise, window, status). It must never be answered from a cache —
    // a stale overview is exactly what "the checkbox reverted" looks like.
    c.header('Cache-Control', 'no-store');
    return c.json({
      plans: plans.results ?? [],
      criteria: criteria.results ?? [],
      reviewers: reviewers.results ?? [],
      stats: stats.results ?? [],
      pool: pool.results ?? [],
      workload: workload.results ?? [],
      // Additive: the reviewer's true cross-plan queue size (see the query
      // above). Existing clients reading `workload` per-plan are unaffected.
      queue_totals: queueTotals.results ?? [],
    });
  } catch (err) {
    console.error('evaluation/overview failed', err);
    return c.json({ error: 'overview_failed' }, 500);
  }
});

evaluationRoutes.post('/evaluation/plans', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New plan';

  // ABS-01: optional scale at creation time — same validation as the PUT
  // route, minus the reviews-exist lock (a brand-new plan cannot have any).
  const min = 'scoring_scale_min' in body ? Number(body.scoring_scale_min) : 1;
  const max = 'scoring_scale_max' in body ? Number(body.scoring_scale_max) : 5;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || min >= max || max - min > 19) {
    return c.json({ error: 'invalid_scale' }, 400);
  }

  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, description, status, anonymise_submitters, scoring_scale_min, scoring_scale_max, created_at)
     VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
  )
    .bind(id, session.eventId, name, typeof body.description === 'string' ? body.description : null, min, max, nowIso())
    .run();
  // Seed one criterion. A plan with no scoring_criteria rows renders a
  // scorecard with nothing to score, and the reviewer's Save is rejected for
  // having no scores — a brand-new plan was unusable until the organiser
  // happened to notice it needed criteria added first. One weight-1 "Overall"
  // row makes the plan work out of the box; it is renameable and deletable
  // like any other, so this costs an organiser who wants their own scheme
  // nothing but a rename.
  await c.env.DB.prepare(
    `INSERT INTO scoring_criteria (id, plan_id, name, description, weight, position)
     VALUES (?, ?, 'Overall', NULL, 1, 1)`,
  )
    .bind(crypto.randomUUID(), id)
    .run();
  return c.json({ ok: true, id }, 201);
});

evaluationRoutes.put('/evaluation/plans/:id', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) { sets.push('name = ?'); params.push(body.name.trim()); }
  if (typeof body.description === 'string' || body.description === null) { sets.push('description = ?'); params.push(body.description); }
  if (body.status === 'draft' || body.status === 'active' || body.status === 'closed') { sets.push('status = ?'); params.push(body.status); }
  if ('anonymise_submitters' in body) {
    const anon = parseBoolish(body.anonymise_submitters);
    if (anon === null) return c.json({ error: 'invalid_anonymise_submitters' }, 400);
    sets.push('anonymise_submitters = ?');
    params.push(anon ? 1 : 0);
  }
  // ABS-01 review window. Both are optional and independently clearable —
  // send '' or null to remove a bound and go back to "always open".
  for (const key of ['opens_at', 'closes_at'] as const) {
    if (key in body) {
      const parsed = parseIsoOrNull(body[key]);
      if (!parsed.ok) return c.json({ error: `invalid_${key}` }, 400);
      sets.push(`${key} = ?`);
      params.push(parsed.value);
    }
  }
  // ABS-01 per-round scoring scale. Reviewer save (POST /review/assignments/:id)
  // already clamps to whatever min/max the plan carries and the queue payload
  // already builds its buttons from them — only this write path was missing.
  // A scale change is refused once any review has been recorded against the
  // plan (409 scale_locked_reviews_exist): a review's stored score was clamped
  // to, and its weighted_total computed against, the *old* bounds, so silently
  // moving the bounds under it would make that score mean something different
  // than what the reviewer actually submitted.
  if ('scoring_scale_min' in body || 'scoring_scale_max' in body) {
    const current = await c.env.DB.prepare(
      'SELECT scoring_scale_min, scoring_scale_max FROM evaluation_plans WHERE id = ? AND event_id = ?',
    )
      .bind(c.req.param('id'), session.eventId)
      .first<{ scoring_scale_min: number; scoring_scale_max: number }>();
    if (!current) return c.json({ error: 'not_found' }, 404);
    const min = 'scoring_scale_min' in body ? Number(body.scoring_scale_min) : current.scoring_scale_min;
    const max = 'scoring_scale_max' in body ? Number(body.scoring_scale_max) : current.scoring_scale_max;
    if (
      !Number.isInteger(min) || !Number.isInteger(max) ||
      min < 0 || min >= max || max - min > 19
    ) {
      return c.json({ error: 'invalid_scale' }, 400);
    }
    if (min !== current.scoring_scale_min || max !== current.scoring_scale_max) {
      const hasReviews = await c.env.DB.prepare('SELECT 1 FROM reviews WHERE plan_id = ? LIMIT 1')
        .bind(c.req.param('id'))
        .first();
      if (hasReviews) return c.json({ error: 'scale_locked_reviews_exist' }, 409);
      sets.push('scoring_scale_min = ?', 'scoring_scale_max = ?');
      params.push(min, max);
    }
  }
  if (sets.length === 0) return c.json({ error: 'no_fields' }, 400);
  const result = await c.env.DB.prepare(
    `UPDATE evaluation_plans SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`,
  )
    .bind(...params, c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  // Answer with the stored row (ABS-07): the client can then render what the
  // database actually holds instead of trusting its own optimistic guess and
  // discovering on the next refetch that the write never landed.
  const plan = await c.env.DB.prepare('SELECT * FROM evaluation_plans WHERE id = ? AND event_id = ?')
    .bind(c.req.param('id'), session.eventId)
    .first<Record<string, unknown>>();
  return c.json({ ok: true, plan });
});

// 0026 — criterion field types. 'score' is the numeric scale row everything
// predating 0026 already is; 'choice' is a dropdown whose allowed values live
// in `options` (JSON array of strings); 'text' is a long-text comment field.
// choice/text never join the weighted numeric aggregate — see the save route.
const CRITERION_KINDS = new Set(['score', 'choice', 'text']);

/**
 * Validate a criterion kind + options pair from a request body.
 * Returns null on a malformed pair; the caller answers 400.
 */
function parseCriterionKind(body: Record<string, unknown>): { kind: string; options: string | null } | null {
  const kind = typeof body.kind === 'string' && body.kind ? body.kind : 'score';
  if (!CRITERION_KINDS.has(kind)) return null;
  if (kind !== 'choice') return { kind, options: null };
  const raw = body.options;
  const list = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter((v) => v !== '')
    : [];
  if (list.length < 2) return null; // a dropdown with fewer than two options is not a choice
  return { kind, options: JSON.stringify(list.slice(0, 50)) };
}

evaluationRoutes.post('/evaluation/plans/:id/criteria', async (c) => {
  const session = c.get('session');
  const planId = c.req.param('id');
  const plan = await c.env.DB.prepare('SELECT id FROM evaluation_plans WHERE id = ? AND event_id = ?')
    .bind(planId, session.eventId)
    .first();
  if (!plan) return c.json({ error: 'not_found' }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Criterion';
  const weight = Number(body.weight);
  const kindSpec = parseCriterionKind(body);
  if (!kindSpec) return c.json({ error: 'invalid_criterion_kind' }, 400);
  const pos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM scoring_criteria WHERE plan_id = ?')
    .bind(planId)
    .first<{ n: number }>();
  await c.env.DB.prepare(
    `INSERT INTO scoring_criteria (id, plan_id, name, description, weight, position, kind, options)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), planId, name, typeof body.description === 'string' ? body.description : null,
      Number.isFinite(weight) && weight > 0 ? weight : 1, pos?.n ?? 1, kindSpec.kind, kindSpec.options)
    .run();
  return c.json({ ok: true }, 201);
});

evaluationRoutes.put('/evaluation/criteria/:id', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (typeof body.name === 'string' && body.name.trim()) { sets.push('name = ?'); params.push(body.name.trim()); }
  const weight = Number(body.weight);
  if (Number.isFinite(weight) && weight > 0) { sets.push('weight = ?'); params.push(weight); }
  if ('kind' in body || 'options' in body) {
    const kindSpec = parseCriterionKind(body);
    if (!kindSpec) return c.json({ error: 'invalid_criterion_kind' }, 400);
    sets.push('kind = ?', 'options = ?');
    params.push(kindSpec.kind, kindSpec.options);
  }
  if (sets.length === 0) return c.json({ ok: true });
  const result = await c.env.DB.prepare(
    `UPDATE scoring_criteria SET ${sets.join(', ')}
     WHERE id = ? AND plan_id IN (SELECT id FROM evaluation_plans WHERE event_id = ?)`,
  )
    .bind(...params, c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

evaluationRoutes.delete('/evaluation/criteria/:id', async (c) => {
  const session = c.get('session');
  await c.env.DB.prepare(
    `DELETE FROM scoring_criteria
     WHERE id = ? AND plan_id IN (SELECT id FROM evaluation_plans WHERE event_id = ?)`,
  )
    .bind(c.req.param('id'), session.eventId)
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Plan submission membership (docs/06 §4 "Submissions … by filter … or by
// explicit selection"). Until 0012 this had no API and no UI at all, which is
// why Assign had nothing to deal out.
// ---------------------------------------------------------------------------

/** Shared plan lookup, scoped to the session's event. */
async function loadPlan(
  db: D1Database,
  planId: string,
  eventId: string,
): Promise<{ id: string; name: string; status: string; opens_at: string | null; closes_at: string | null } | null> {
  return db
    .prepare('SELECT id, name, status, opens_at, closes_at FROM evaluation_plans WHERE id = ? AND event_id = ?')
    .bind(planId, eventId)
    .first();
}

/**
 * GET /evaluation/plans/:id/submissions — every reviewable submission on the
 * event with a `member` flag, plus the distinct tracks/formats/statuses the
 * filter row offers. One payload drives both halves of the picker (the filter
 * + "Add matching", and the explicit checkbox list).
 */
evaluationRoutes.get('/evaluation/plans/:id/submissions', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const planId = c.req.param('id');
  const plan = await loadPlan(db, planId, session.eventId);
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const { results: items } = await db
    .prepare(
      `SELECT s.id, s.code, s.title, s.status, s.format, s.track_id, t.name AS track_name,
              CASE WHEN ${MEMBER_SQL('s')} THEN 1 ELSE 0 END AS member,
              (SELECT COUNT(*) FROM review_assignments ra
                WHERE ra.plan_id = ? AND ra.submission_id = s.id) AS assignments
       FROM submissions s LEFT JOIN tracks t ON t.id = s.track_id
       WHERE s.event_id = ? AND s.${REVIEWABLE_STATUS_SQL}
       ORDER BY s.created_at`,
    )
    .bind(...planBinds(planId), planId, session.eventId)
    .all<Record<string, unknown>>();

  const { results: tracks } = await db
    .prepare('SELECT id, name FROM tracks WHERE event_id = ? ORDER BY position, name')
    .bind(session.eventId)
    .all<{ id: string; name: string }>();
  const formats = [
    ...new Set(items.map((i) => i.format).filter((f): f is string => typeof f === 'string' && f !== '')),
  ].sort();

  return c.json({ items, tracks, formats });
});

/**
 * POST /evaluation/plans/:id/submissions — add or remove submissions.
 * Body: `{ mode: 'add' | 'remove', submission_ids?: string[], filter?: {…} }`.
 * Explicit ids and a filter may be combined; a filter with no fields set
 * matches every reviewable submission on the event, which is the "add
 * everything" case an organiser reaches for first.
 *
 * The legacy `submissions.evaluation_plan_id` is kept in step so the grid's
 * `Ratings: <plan>` column and the REST payloads keep working: adding stamps
 * it only when it is still NULL (never stealing a submission from another
 * round), removing clears it only when it points at this round.
 */
evaluationRoutes.post('/evaluation/plans/:id/submissions', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const planId = c.req.param('id');
  const plan = await loadPlan(db, planId, session.eventId);
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const mode = body.mode === 'remove' ? 'remove' : 'add';
  const explicit = parseIds(body.submission_ids);
  const filter = (body.filter ?? null) as Record<string, unknown> | null;

  const where: string[] = ['s.event_id = ?', `s.${REVIEWABLE_STATUS_SQL}`];
  const binds: unknown[] = [session.eventId];
  if (explicit.length > 0) {
    where.push(`s.id IN (${explicit.map(() => '?').join(', ')})`);
    binds.push(...explicit);
  } else if (!filter) {
    return c.json({ error: 'selection_required' }, 400);
  }
  if (filter) {
    if (typeof filter.track_id === 'string' && filter.track_id) { where.push('s.track_id = ?'); binds.push(filter.track_id); }
    if (typeof filter.format === 'string' && filter.format) { where.push('s.format = ?'); binds.push(filter.format); }
    if (typeof filter.status === 'string' && filter.status) {
      if (!SUBMISSION_STATUSES.has(filter.status)) return c.json({ error: 'invalid_status' }, 400);
      where.push('s.status = ?');
      binds.push(filter.status);
    }
    if (typeof filter.q === 'string' && filter.q.trim()) {
      where.push('(s.title LIKE ? OR s.code LIKE ?)');
      binds.push(`%${filter.q.trim()}%`, `%${filter.q.trim()}%`);
    }
  }

  const { results: matched } = await db
    .prepare(`SELECT s.id FROM submissions s WHERE ${where.join(' AND ')}`)
    .bind(...binds)
    .all<{ id: string }>();
  const ids = matched.map((r) => r.id);
  if (ids.length === 0) return c.json({ ok: true, matched: 0, changed: 0, total: await memberCount(db, planId, session.eventId) });

  const placeholders = ids.map(() => '?').join(', ');
  const ts = nowIso();
  let changed = 0;
  if (mode === 'add') {
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO evaluation_plan_submissions (plan_id, submission_id, added_at)
         SELECT ?, s.id, ? FROM submissions s WHERE s.id IN (${placeholders})`,
      )
      .bind(planId, ts, ...ids)
      .run();
    changed = inserted.meta.changes ?? 0;
    await db
      .prepare(
        `UPDATE submissions SET evaluation_plan_id = ?, updated_at = ?
         WHERE id IN (${placeholders}) AND event_id = ? AND evaluation_plan_id IS NULL`,
      )
      .bind(planId, ts, ...ids, session.eventId)
      .run();
  } else {
    const removed = await db
      .prepare(`DELETE FROM evaluation_plan_submissions WHERE plan_id = ? AND submission_id IN (${placeholders})`)
      .bind(planId, ...ids)
      .run();
    changed = removed.meta.changes ?? 0;
    await db
      .prepare(
        `UPDATE submissions SET evaluation_plan_id = NULL, updated_at = ?
         WHERE id IN (${placeholders}) AND event_id = ? AND evaluation_plan_id = ?`,
      )
      .bind(ts, ...ids, session.eventId, planId)
      .run();
    // Assignments for a submission no longer in the round would otherwise
    // linger in reviewers' queues.
    await db
      .prepare(
        `DELETE FROM review_assignments
         WHERE plan_id = ? AND status IN ('pending', 'in_progress') AND submission_id IN (${placeholders})`,
      )
      .bind(planId, ...ids)
      .run();
  }

  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, matched: ids.length, changed, total: await memberCount(db, planId, session.eventId) });
});

async function memberCount(db: D1Database, planId: string, eventId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM submissions s
       WHERE s.event_id = ? AND s.${REVIEWABLE_STATUS_SQL} AND ${MEMBER_SQL('s')}`,
    )
    .bind(eventId, ...planBinds(planId))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// POST /evaluation/plans/:id/assign — create review assignments for every
// submission *in the plan* (0012 membership ∪ the legacy routing column).
// 'all' gives each reviewer everything; 'round_robin' deals N reviewers per
// submission in rotation. INSERT OR IGNORE + the UNIQUE(plan, submission,
// reviewer) index make re-runs additive, never duplicating (docs/06
// acceptance #1). Chosen reviewers are recorded as the plan's pool so the
// editor re-opens with the same people ticked and reminders have a scope.
evaluationRoutes.post('/evaluation/plans/:id/assign', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const planId = c.req.param('id');
  const plan = await db.prepare('SELECT id FROM evaluation_plans WHERE id = ? AND event_id = ?')
    .bind(planId, session.eventId)
    .first();
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const reviewerIds = parseIds(body.reviewer_contact_ids);
  if (reviewerIds.length === 0) return c.json({ error: 'reviewers_required' }, 400);

  // Every reviewer id must be an event_users member of this plan's event
  // with an eligible role (sweep item P1-5 acceptance).
  const reviewerPlaceholders = reviewerIds.map(() => '?').join(', ');
  const { results: validReviewers } = await db
    .prepare(
      `SELECT DISTINCT contact_id FROM event_users
       WHERE event_id = ? AND role IN ('reviewer', 'admin', 'owner') AND contact_id IN (${reviewerPlaceholders})`,
    )
    .bind(session.eventId, ...reviewerIds)
    .all<{ contact_id: string }>();
  if (validReviewers.length !== new Set(reviewerIds).size) {
    return c.json({ error: 'invalid_reviewer' }, 400);
  }

  const strategy = body.strategy === 'round_robin' ? 'round_robin' : 'all';
  const perSubmission = Math.max(1, Math.min(Number(body.per_submission) || 2, reviewerIds.length));

  // Optional explicit scope: assign only these submissions (they must already
  // be members). Omitted → the whole round.
  const only = parseIds(body.submission_ids);
  const scope = only.length > 0 ? ` AND s.id IN (${only.map(() => '?').join(', ')})` : '';
  const { results: submissions } = await db
    .prepare(
      `SELECT s.id FROM submissions s
       WHERE s.event_id = ? AND s.${REVIEWABLE_STATUS_SQL} AND ${MEMBER_SQL('s')}${scope}
       ORDER BY s.created_at`,
    )
    .bind(session.eventId, ...planBinds(planId), ...only)
    .all<{ id: string }>();

  // ABS-06 per-reviewer cap (evaluation_plan_reviewers.max_assignments, NULL
  // = uncapped). Loaded up front, alongside every pair already assigned in
  // this plan, so the in-loop counting stays exact under INSERT OR IGNORE: a
  // pair that already exists doesn't consume capacity a second time on a
  // re-run, and a freshly-capped reviewer's *existing* load still counts
  // toward their cap from the start.
  const { results: capRows } = await db
    .prepare('SELECT contact_id, max_assignments FROM evaluation_plan_reviewers WHERE plan_id = ?')
    .bind(planId)
    .all<{ contact_id: string; max_assignments: number | null }>();
  const caps = new Map(capRows.map((r) => [r.contact_id, r.max_assignments]));
  const { results: existingRows } = await db
    .prepare('SELECT reviewer_contact_id, submission_id FROM review_assignments WHERE plan_id = ?')
    .bind(planId)
    .all<{ reviewer_contact_id: string; submission_id: string }>();
  const existingPairs = new Set(existingRows.map((r) => `${r.reviewer_contact_id}|${r.submission_id}`));
  const counts = new Map<string, number>();
  for (const row of existingRows) {
    counts.set(row.reviewer_contact_id, (counts.get(row.reviewer_contact_id) ?? 0) + 1);
  }
  const atCap = (reviewerId: string): boolean => {
    const cap = caps.get(reviewerId);
    return cap != null && (counts.get(reviewerId) ?? 0) >= cap;
  };

  const statements: D1PreparedStatement[] = [];
  const ts = nowIso();
  // The plan's reviewer pool — so re-opening the editor pre-ticks the same
  // people, and "remind all lagging" knows who the round belongs to.
  for (const reviewerId of new Set(reviewerIds)) {
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO evaluation_plan_reviewers (plan_id, contact_id, added_at) VALUES (?, ?, ?)`,
      ).bind(planId, reviewerId, ts),
    );
  }
  // Submissions that ended up with fewer reviewers than requested because
  // every remaining candidate was at (or over) their cap.
  const unassigned: Array<{ submission_id: string; short: number }> = [];
  let cursor = 0;
  for (const submission of submissions) {
    let chosen: string[];
    if (strategy === 'all') {
      // An already-assigned pair is kept regardless of cap (it consumes no
      // new capacity — INSERT OR IGNORE simply no-ops it); a not-yet-assigned
      // reviewer at cap is left out.
      chosen = reviewerIds.filter(
        (id) => existingPairs.has(`${id}|${submission.id}`) || !atCap(id),
      );
    } else {
      chosen = [];
      // Scan at most reviewerIds.length candidates from the cursor, skipping
      // capped reviewers, so a fully-capped pool cannot loop forever.
      for (let i = 0; i < reviewerIds.length && chosen.length < perSubmission; i += 1) {
        const id = reviewerIds[(cursor + i) % reviewerIds.length]!;
        if (existingPairs.has(`${id}|${submission.id}`) || !atCap(id)) chosen.push(id);
      }
      cursor = (cursor + perSubmission) % reviewerIds.length;
    }
    const desired = strategy === 'all' ? reviewerIds.length : perSubmission;
    if (chosen.length < desired) unassigned.push({ submission_id: submission.id, short: desired - chosen.length });
    for (const reviewerId of chosen) {
      const key = `${reviewerId}|${submission.id}`;
      if (!existingPairs.has(key)) {
        existingPairs.add(key);
        counts.set(reviewerId, (counts.get(reviewerId) ?? 0) + 1);
      }
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO review_assignments (id, plan_id, submission_id, reviewer_contact_id, status, assigned_at)
           VALUES (?, ?, ?, ?, 'pending', ?)`,
        ).bind(crypto.randomUUID(), planId, submission.id, reviewerId, ts),
      );
    }
  }
  const before = await db.prepare('SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ?')
    .bind(planId)
    .first<{ n: number }>();
  if (statements.length > 0) await db.batch(statements);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ?')
    .bind(planId)
    .first<{ n: number }>();
  await bumpEventRevision(c.env, session.eventId);
  return c.json({
    ok: true,
    total_assignments: count?.n ?? 0,
    // `created` distinguishes "re-ran an already-assigned round" (0) from
    // "the round has no submissions" (submissions === 0) — the UI says which.
    created: Math.max(0, (count?.n ?? 0) - (before?.n ?? 0)),
    submissions: submissions.length,
    unassigned,
  });
});

// ---------------------------------------------------------------------------
// Plan reviewer pool (evaluation_plan_reviewers, 0012)
//
// The pool was write-only: `assign` INSERT-OR-IGNOREs the ticked reviewers and
// nothing ever deleted a row, so unchecking somebody in the editor changed a
// local checkbox, the next Assign (or the next reload) read the pool back from
// the database and the reviewer reappeared ticked — the "removals don't
// persist" defect. These two endpoints are the missing half.
// ---------------------------------------------------------------------------

/** A contact who may sit in a plan's pool: seated on the event, eligible role. */
async function eligibleReviewer(db: D1Database, eventId: string, contactId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS n FROM event_users
       WHERE event_id = ? AND contact_id = ? AND role IN ('reviewer', 'admin', 'owner')`,
    )
    .bind(eventId, contactId)
    .first();
  return row !== null;
}

/** POST /evaluation/plans/:id/reviewers { contact_id } — pool without assigning. */
evaluationRoutes.post('/evaluation/plans/:id/reviewers', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const planId = c.req.param('id');
  const plan = await loadPlan(db, planId, session.eventId);
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (!contactId) return c.json({ error: 'contact_id_required' }, 400);
  if (!(await eligibleReviewer(db, session.eventId, contactId))) {
    return c.json({ error: 'invalid_reviewer' }, 400);
  }

  // ABS-06: optional per-reviewer workload cap for this plan. Sending null
  // clears it back to uncapped; anything else must be a whole number >= 1.
  // Omitting the field entirely (the plain "tick this reviewer into the
  // pool" call every other caller makes) must leave an existing cap alone —
  // this endpoint doubles as plain pool-add and there is no reason a tick
  // with no opinion about capacity should silently wipe one out.
  const capProvided = 'max_assignments' in body;
  let maxAssignments: number | null = null;
  if (capProvided && body.max_assignments !== null) {
    const n = Number(body.max_assignments);
    if (!Number.isInteger(n) || n < 1) return c.json({ error: 'invalid_max_assignments' }, 400);
    maxAssignments = n;
  }

  if (capProvided) {
    await db
      .prepare(
        `INSERT INTO evaluation_plan_reviewers (plan_id, contact_id, added_at, max_assignments) VALUES (?, ?, ?, ?)
         ON CONFLICT (plan_id, contact_id) DO UPDATE SET max_assignments = excluded.max_assignments`,
      )
      .bind(planId, contactId, nowIso(), maxAssignments)
      .run();
  } else {
    await db
      .prepare('INSERT OR IGNORE INTO evaluation_plan_reviewers (plan_id, contact_id, added_at) VALUES (?, ?, ?)')
      .bind(planId, contactId, nowIso())
      .run();
  }
  const stored = await db
    .prepare('SELECT max_assignments FROM evaluation_plan_reviewers WHERE plan_id = ? AND contact_id = ?')
    .bind(planId, contactId)
    .first<{ max_assignments: number | null }>();
  return c.json({ ok: true, plan_id: planId, contact_id: contactId, max_assignments: stored?.max_assignments ?? null }, 201);
});

/**
 * DELETE /evaluation/plans/:id/reviewers/:contactId — take a reviewer out of
 * the round. Their *outstanding* assignments go with them (leaving them in a
 * queue the organiser has just removed them from is the same lingering-work
 * bug the submission-removal path already fixes), but anything already
 * complete or skipped is kept: those rows own real scores and the round's
 * aggregates depend on them.
 */
evaluationRoutes.delete('/evaluation/plans/:id/reviewers/:contactId', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const planId = c.req.param('id');
  const contactId = c.req.param('contactId');
  const plan = await loadPlan(db, planId, session.eventId);
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const removedAssignments = await db
    .prepare(
      `DELETE FROM review_assignments
       WHERE plan_id = ? AND reviewer_contact_id = ? AND status IN ('pending', 'in_progress')`,
    )
    .bind(planId, contactId)
    .run();
  await db
    .prepare('DELETE FROM evaluation_plan_reviewers WHERE plan_id = ? AND contact_id = ?')
    .bind(planId, contactId)
    .run();

  await bumpEventRevision(c.env, session.eventId);
  return c.json({
    ok: true,
    plan_id: planId,
    contact_id: contactId,
    removed_assignments: removedAssignments.meta.changes ?? 0,
  });
});

// ---------------------------------------------------------------------------
// Reviewer provisioning + nudges (CFP-10 / ABS-09)
// ---------------------------------------------------------------------------

/**
 * POST /evaluation/reviewers — create or look up a contact by email and seat
 * them as a reviewer on the event (docs/06 §4: "reviewers are contacts with
 * the reviewer role"). Optionally drops them into a plan's pool.
 *
 * There was previously no path to a usable reviewer at all: the reviewer list
 * only ever showed people already seated in Settings, so a fresh event could
 * configure a round it had nobody to run. An existing owner/admin seat is
 * never downgraded — they are already eligible reviewers.
 */
evaluationRoutes.post('/evaluation/reviewers', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: 'invalid_email' }, 400);

  const rawName = typeof body.name === 'string' ? body.name.trim() : '';
  const first = typeof body.first_name === 'string' && body.first_name.trim()
    ? body.first_name.trim()
    : rawName.split(/\s+/)[0] ?? '';
  const last = typeof body.last_name === 'string' && body.last_name.trim()
    ? body.last_name.trim()
    : rawName.split(/\s+/).slice(1).join(' ');

  const ts = nowIso();
  // 0015: dedupe scope is the ORG, not the event. A reviewer already known to
  // a sibling event is the same person — reuse that identity and attach it to
  // this event below, rather than minting a second contact the unique index on
  // (org_id, lower(email)) would reject anyway.
  const org = await db
    .prepare('SELECT org_id FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ org_id: string }>();
  if (!org) return c.json({ error: 'not_found' }, 404);

  let contact = await db
    .prepare('SELECT id, email, first_name, last_name FROM contacts WHERE org_id = ? AND lower(email) = ?')
    .bind(org.org_id, email)
    .first<{ id: string; email: string; first_name: string | null; last_name: string | null }>();
  const created = !contact;
  if (!contact) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO contacts (id, org_id, email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, org.org_id, email, first || null, last || null, ts, ts)
      .run();
    contact = { id, email, first_name: first || null, last_name: last || null };
  } else if (first || last) {
    // Fill blanks only — never overwrite a name the contact already has.
    await db
      .prepare(
        `UPDATE contacts SET first_name = COALESCE(NULLIF(first_name, ''), ?),
                             last_name = COALESCE(NULLIF(last_name, ''), ?), updated_at = ?
         WHERE id = ?`,
      )
      .bind(first || null, last || null, ts, contact.id)
      .run();
  }

  // Membership is its own row now: a contact with no event_contacts row exists
  // in the org but appears on no roster at all. attachToEvent is idempotent and
  // seeds this event's profile from their most recent event in the same org.
  await createDb(c.env.DB).contacts.attachToEvent(session.eventId, contact.id, 'admin');

  await db
    .prepare(
      `INSERT OR IGNORE INTO event_users (event_id, contact_id, role, invited_at)
       VALUES (?, ?, 'reviewer', ?)`,
    )
    .bind(session.eventId, contact.id, ts)
    .run();

  const planId = typeof body.plan_id === 'string' ? body.plan_id : '';
  if (planId) {
    const plan = await loadPlan(db, planId, session.eventId);
    if (!plan) return c.json({ error: 'not_found' }, 404);
    await db
      .prepare('INSERT OR IGNORE INTO evaluation_plan_reviewers (plan_id, contact_id, added_at) VALUES (?, ?, ?)')
      .bind(planId, contact.id, ts)
      .run();
  }

  await bumpEventRevision(c.env, session.eventId);
  const name = [contact.first_name ?? first, contact.last_name ?? last].filter(Boolean).join(' ').trim();
  return c.json({ ok: true, id: contact.id, email: contact.email, name: name || null, created }, created ? 201 : 200);
});

/**
 * POST /evaluation/reviewers/:contactId/signin-link — mint a magic link so a
 * reviewer can actually get in, and hand the organiser something they can pass
 * on when the mail path cannot serve them.
 *
 * CFP-11: this used to delegate the whole decision to `requestMagicLink`
 * (auth.ts), including whether to surface the link inline. That function's
 * demo carve-out is scoped to two *seeded* identities — the demo organiser and
 * the demo speaker of the first event in the database — so on the demo
 * instance (DEMO_RESET=on, DEV_MODE off) the only link the button could ever
 * reveal belonged to the organiser, never to the reviewer it was clicked for;
 * for everybody else it answered `dev_link: null` and relied on an email the
 * demo cannot send. The link is therefore minted here, against the target
 * contact, whenever the instance is in demo/dev mode — the surfaced link is
 * bound to `contact.id` by construction and cannot be the caller's — and the
 * response names the reviewer it belongs to so the UI can never mislabel it.
 * The ordinary (production) path is unchanged: requestMagicLink, one token,
 * the template pipeline, a message_log row.
 */
evaluationRoutes.post('/evaluation/reviewers/:contactId/signin-link', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const contact = await db
    .prepare(
      `SELECT c.id, c.email, NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS name
       FROM contacts c
       JOIN event_users eu ON eu.contact_id = c.id AND eu.event_id = ?
       WHERE c.id = ?`,
    )
    .bind(session.eventId, c.req.param('contactId'))
    .first<{ id: string; email: string; name: string | null }>();
  if (!contact) return c.json({ error: 'not_found' }, 404);

  const event = await db
    .prepare('SELECT id, name, slug FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ id: string; name: string; slug: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  const identity = { contact_id: contact.id, email: contact.email, name: contact.name };

  // Demo instance, DEV_MODE off: mint here for *this* contact and show it.
  // No email — the demo has no deliverable mail path, and a link the organiser
  // can copy is the only way a reviewer account is reachable at all.
  if (c.env.DEV_MODE !== 'on' && c.env.DEMO_RESET === 'on') {
    const { raw: token, statement } = await mintToken(c.env.DB, {
      contactId: contact.id,
      eventId: event.id,
      purpose: 'portal-login',
      redirectTo: '/app',
    });
    await statement.run();
    return c.json({
      ok: true,
      ...identity,
      dev_link: `${c.env.APP_URL}/auth/callback?t=${token}`,
      emailed: false,
    });
  }

  // requestMagicLink is typed against the bare AppEnv context; this route's
  // context only adds a `session` variable on top of the same bindings.
  const { devLink } = await requestMagicLink(c as unknown as Context<AppEnv>, {
    email: contact.email.toLowerCase(),
    event: { id: event.id, name: event.name },
    redirectTo: '/app',
    // A reviewer invited from the evaluation screen was added by staff, not by
    // the CFP — only matters when this call is the one that creates the roster row.
    attachSource: 'admin',
  });
  return c.json({ ok: true, ...identity, dev_link: devLink, emailed: true });
});

/**
 * POST /evaluation/plans/:id/remind — nudge reviewers with outstanding
 * assignments (ABS-09). Body `{ contact_ids?: string[] }`; omit it to remind
 * everyone who is lagging. Reviewers with nothing outstanding are never
 * mailed. Idempotency key carries the date, so a second click on the same day
 * is a no-op rather than a second email.
 */
evaluationRoutes.post('/evaluation/plans/:id/remind', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const db = c.env.DB;
  const planId = c.req.param('id');
  const plan = await loadPlan(db, planId, session.eventId);
  if (!plan) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const only = parseIds(body.contact_ids);
  const scope = only.length > 0 ? ` AND ra.reviewer_contact_id IN (${only.map(() => '?').join(', ')})` : '';

  const { results: lagging } = await db
    .prepare(
      `SELECT ra.reviewer_contact_id AS contact_id, c.email, c.first_name,
              COUNT(*) AS outstanding
       FROM review_assignments ra JOIN contacts c ON c.id = ra.reviewer_contact_id
       WHERE ra.plan_id = ? AND ra.status IN ('pending', 'in_progress')${scope}
       GROUP BY ra.reviewer_contact_id, c.email, c.first_name`,
    )
    .bind(planId, ...only)
    .all<{ contact_id: string; email: string; first_name: string | null; outstanding: number }>();

  const event = await db
    .prepare('SELECT name FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ name: string }>();
  const reviewUrl = `${c.env.APP_URL}/app`;
  const day = nowIso().slice(0, 10);

  let sent = 0;
  for (const reviewer of lagging) {
    // Inline template rather than a new DEFAULT_TEMPLATES key: the send still
    // renders, themes, logs to message_log and retries through the outbox
    // exactly like a stored template (mailer.resolveOverride).
    const outcome = await sendTemplated(c, {
      templateKey: 'reviewer_reminder',
      eventId: session.eventId,
      contactId: reviewer.contact_id,
      toEmail: reviewer.email,
      entityId: `${planId}:${day}`,
      context: {
        event: { name: event?.name ?? '' },
        reviewer: { first_name: reviewer.first_name ?? 'there' },
        plan: { name: plan.name },
        outstanding: String(reviewer.outstanding),
        review_url: reviewUrl,
      },
      template: {
        subject: 'Reviews outstanding: {{plan.name}} — {{event.name}}',
        body: `<p>Hi {{reviewer.first_name}},</p>
<p>You have <strong>{{outstanding}}</strong> submission(s) still to review in <strong>{{plan.name}}</strong> for {{event.name}}.</p>
<p><a href="{{review_url}}" class="btn">Open your review queue</a></p>`,
      },
    });
    if (outcome === 'queued') sent += 1;
  }

  return c.json({
    ok: true,
    sent,
    lagging: lagging.map((r) => ({ contact_id: r.contact_id, outstanding: r.outstanding })),
  });
});

// ---------------------------------------------------------------------------
// Reviewer surface (guard allows reviewers here)
// ---------------------------------------------------------------------------

// GET /review/queue — my assignments with the submission, plan and criteria.
// Wrapped end-to-end: any D1/runtime failure here used to propagate as an
// unhandled exception, which the client sees as a bare network-level "Failed
// to fetch" instead of a renderable error (manual review, admin Review
// section). Criteria and participants are also fetched as two batched
// IN (…) queries instead of one D1 round trip per plan/submission — the old
// N+1 loop scaled with assignment count and, alongside not being guarded for
// an empty id list, was the more likely source of a request timing out
// mid-flight (which also presents to fetch() as a network error, not a 5xx).
evaluationRoutes.get('/review/queue', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  try {
    const { results: assignments } = await db
      .prepare(
        `SELECT ra.id, ra.status, ra.plan_id, ra.submission_id,
                p.name AS plan_name, p.description AS plan_description,
                p.anonymise_submitters, p.scoring_scale_min, p.scoring_scale_max,
                p.opens_at AS plan_opens_at, p.closes_at AS plan_closes_at,
                s.code, s.title, s.description, s.format, s.level, s.language,
                t.name AS track_name,
                r.scores AS my_scores, r.conflict_of_interest AS my_conflict,
                -- reviews.comment is deprecated (workplan 7 §3): the rationale
                -- lives in the thread now, so the form prefill reads the
                -- assignment's most recent kind='rationale' comment.
                (SELECT sc.body FROM submission_comments sc
                 WHERE sc.assignment_id = ra.id AND sc.kind = 'rationale'
                 ORDER BY sc.created_at DESC, sc.id DESC LIMIT 1) AS my_comment
         FROM review_assignments ra
         JOIN evaluation_plans p ON p.id = ra.plan_id
         JOIN submissions s ON s.id = ra.submission_id
         LEFT JOIN tracks t ON t.id = s.track_id
         LEFT JOIN reviews r ON r.assignment_id = ra.id
         WHERE ra.reviewer_contact_id = ? AND p.event_id = ? AND p.status = 'active'
         ORDER BY CASE ra.status WHEN 'complete' THEN 1 ELSE 0 END, s.created_at`,
      )
      .bind(session.contactId, session.eventId)
      .all<Record<string, unknown>>();

    // ABS-01: an assignment in a plan outside its review window is still
    // listed (so the reviewer can see what is coming/what closed) but carries
    // the flags the queue needs to show a closed notice and disable saving.
    // The server refuses the write regardless — see POST /review/assignments.
    const now = Date.now();
    for (const a of assignments) {
      const state = reviewWindowState(
        { opens_at: (a.plan_opens_at as string | null) ?? null, closes_at: (a.plan_closes_at as string | null) ?? null },
        now,
      );
      a.plan_open = state.open ? 1 : 0;
      a.plan_window_reason = state.reason;
    }

    const planIds = [...new Set(assignments.map((a) => a.plan_id as string))];
    const criteria: Record<string, unknown[]> = {};
    for (const planId of planIds) criteria[planId] = [];
    if (planIds.length > 0) {
      const placeholders = planIds.map(() => '?').join(', ');
      const { results } = await db
        .prepare(
          `SELECT id, name, description, weight, position, kind, options, plan_id FROM scoring_criteria
           WHERE plan_id IN (${placeholders}) ORDER BY plan_id, position`,
        )
        .bind(...planIds)
        .all<{ plan_id: string } & Record<string, unknown>>();
      for (const row of results) {
        const { plan_id, ...rest } = row;
        criteria[plan_id]!.push(rest);
      }
    }

    // ABS-07 — participants are shown unless the plan anonymises submitters
    // (docs/06 §4), and the redaction is done *here*, not in the client: an
    // anonymised submission's identity never enters the response, so it cannot
    // leak through devtools, a copied payload or a UI that forgot to hide it.
    // Anonymised submissions still get an explicit empty list rather than a
    // missing key, so "hidden" is a stated fact the client can render.
    const anonymised = new Set(
      assignments.filter((a) => a.anonymise_submitters === 1).map((a) => a.submission_id as string),
    );
    const submissionIds = [
      ...new Set(
        assignments.filter((a) => a.anonymise_submitters !== 1).map((a) => a.submission_id as string),
      ),
    ].filter((id) => !anonymised.has(id));
    const participants: Record<string, unknown[]> = {};
    for (const id of anonymised) participants[id] = [];
    for (const id of submissionIds) participants[id] = [];
    if (submissionIds.length > 0) {
      const placeholders = submissionIds.map(() => '?').join(', ');
      const { results } = await db
        .prepare(
          `SELECT sp.submission_id,
                  NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS name,
                  sp.role
           FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
           WHERE sp.submission_id IN (${placeholders}) ORDER BY sp.submission_id, sp.position`,
        )
        .bind(...submissionIds)
        .all<{ submission_id: string } & Record<string, unknown>>();
      for (const row of results) {
        const { submission_id, ...rest } = row;
        participants[submission_id]!.push(rest);
      }
    }

    return c.json({ assignments, criteria, participants });
  } catch (err) {
    console.error('GET /review/queue failed', err);
    const message = err instanceof Error ? err.message : 'unknown_error';
    return c.json({ error: 'review_queue_failed', message }, 500);
  }
});

/**
 * Recompute the plan's mean weighted_total into submission.rating_cache — one
 * aggregate UPDATE, no read-modify-write (sweep item P1-5). rating_cache is
 * `{ "<plan_id>": <mean> }` across every plan the submission has ever been
 * scored under, so this only ever touches the one key for this plan_id via
 * json_set/json_remove, leaving other plans' cached values untouched even
 * under concurrent saves on different plans.
 */
function ratingCacheStatement(db: D1Database, submissionId: string, planId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE submissions SET rating_cache = CASE
         WHEN (SELECT AVG(weighted_total) FROM reviews WHERE submission_id = ?1 AND plan_id = ?2) IS NULL
           THEN json_remove(COALESCE(rating_cache, '{}'), '$."' || ?2 || '"')
         ELSE json_set(COALESCE(rating_cache, '{}'), '$."' || ?2 || '"',
           (SELECT ROUND(AVG(weighted_total), 2) FROM reviews WHERE submission_id = ?1 AND plan_id = ?2))
       END, updated_at = ?3
       WHERE id = ?1`,
    )
    .bind(submissionId, planId, new Date().toISOString());
}

// POST /review/assignments/:id — save scores. Upserts the review, computes
// weighted_total = Σ(score×weight)/Σ(weight), completes the assignment and
// refreshes rating_cache (docs/06 §4 aggregation).
evaluationRoutes.post('/review/assignments/:id', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const assignment = await db
    .prepare(
      `SELECT ra.id, ra.plan_id, ra.submission_id, p.scoring_scale_min, p.scoring_scale_max,
              p.status AS plan_status, p.opens_at, p.closes_at
       FROM review_assignments ra JOIN evaluation_plans p ON p.id = ra.plan_id
       WHERE ra.id = ? AND ra.reviewer_contact_id = ? AND p.event_id = ?`,
    )
    .bind(c.req.param('id'), session.contactId, session.eventId)
    .first<{
      id: string; plan_id: string; submission_id: string;
      scoring_scale_min: number; scoring_scale_max: number;
      plan_status: string; opens_at: string | null; closes_at: string | null;
    }>();
  if (!assignment) return c.json({ error: 'not_found' }, 404);

  // ABS-01 server-side gate: the window (and a closed plan) blocks the write,
  // not just the UI. Null dates mean "always open", so untouched plans are
  // unaffected.
  const window = reviewWindowState(assignment);
  if (!window.open || assignment.plan_status === 'closed') {
    return c.json(
      {
        error: 'review_closed',
        reason: assignment.plan_status === 'closed' ? 'plan_closed' : window.reason,
        opens_at: assignment.opens_at,
        closes_at: assignment.closes_at,
      },
      403,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const conflict = body.conflict_of_interest === true;
  // The wire field is still `comment`, but it lands in the thread as a
  // kind='rationale' comment (workplan 7 §3); reviews.comment is deprecated
  // and no longer written.
  const comment = typeof body.comment === 'string' ? body.comment : '';

  const { results: criteria } = await db
    .prepare('SELECT id, weight, kind, options FROM scoring_criteria WHERE plan_id = ?')
    .bind(assignment.plan_id)
    .all<{ id: string; weight: number; kind: string; options: string | null }>();

  // 0026 — criterion kinds. Only 'score' rows join the weighted numeric
  // aggregate; a 'choice' answer must be one of the criterion's options and is
  // stored as its string; 'text' is an optional free-text answer. The
  // completeness rule stays "answer everything that can be scored": score and
  // choice rows are required, text is not.
  const rawScores = (body.scores ?? {}) as Record<string, unknown>;
  const scores: Record<string, number | string> = {};
  let weightedSum = 0;
  let weightTotal = 0;
  let required = 0;
  let answered = 0;
  for (const criterion of criteria) {
    const raw = rawScores[criterion.id];
    if (criterion.kind === 'text') {
      if (typeof raw === 'string' && raw.trim() !== '') scores[criterion.id] = raw.trim().slice(0, 2000);
      continue;
    }
    if (criterion.kind === 'choice') {
      required += 1;
      let allowed: string[] = [];
      try {
        const parsed = JSON.parse(criterion.options ?? '[]') as unknown;
        if (Array.isArray(parsed)) allowed = parsed.filter((v): v is string => typeof v === 'string');
      } catch { /* malformed options: nothing is selectable */ }
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw !== 'string' || !allowed.includes(raw)) {
        return c.json({ error: 'invalid_choice', criterion_id: criterion.id }, 400);
      }
      scores[criterion.id] = raw;
      answered += 1;
      continue;
    }
    required += 1;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.min(Math.max(value, assignment.scoring_scale_min), assignment.scoring_scale_max);
    scores[criterion.id] = clamped;
    weightedSum += clamped * criterion.weight;
    weightTotal += criterion.weight;
    answered += 1;
  }
  if (!conflict && answered < required) {
    return c.json({ error: 'all_criteria_required' }, 400);
  }
  const weightedTotal = conflict || weightTotal === 0 ? null : Math.round((weightedSum / weightTotal) * 100) / 100;

  const ts = nowIso();

  // Single INSERT … ON CONFLICT(assignment_id) DO UPDATE against the 0005
  // partial unique index — no SELECT-then-branch, so two concurrent saves for
  // the same assignment leave exactly one reviews row with the last writer's
  // content (sweep item P1-5 acceptance). All three writes (review, assignment
  // status, rating cache) commit together in one batch.
  const reviewUpsert = db
    .prepare(
      `INSERT INTO reviews (id, assignment_id, submission_id, reviewer_contact_id, plan_id,
         scores, weighted_total, conflict_of_interest, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assignment_id) WHERE assignment_id IS NOT NULL DO UPDATE SET
         scores = excluded.scores,
         weighted_total = excluded.weighted_total,
         conflict_of_interest = excluded.conflict_of_interest,
         updated_at = excluded.updated_at`,
    )
    .bind(crypto.randomUUID(), assignment.id, assignment.submission_id, session.contactId,
      assignment.plan_id, JSON.stringify(scores), weightedTotal, conflict ? 1 : 0, ts, ts);

  const assignmentUpdate = db
    .prepare(`UPDATE review_assignments SET status = ?, completed_at = ? WHERE id = ?`)
    .bind(conflict ? 'skipped' : 'complete', ts, assignment.id);

  await db.batch([reviewUpsert, assignmentUpdate, ratingCacheStatement(db, assignment.submission_id, assignment.plan_id)]);

  // Fold the rationale into the discussion thread (workplan 7 §3). Posted
  // blind — writing it never requires reading the thread, so the D3 gate
  // holds. appendRationale suppresses the no-op re-save; a genuinely revised
  // rationale appends a second row (D4: append-only).
  await appendRationale(db, {
    eventId: session.eventId,
    submissionId: assignment.submission_id,
    planId: assignment.plan_id,
    assignmentId: assignment.id,
    authorContactId: session.contactId,
    authorName: await loadAuthorName(db, session.contactId),
    body: comment,
  });
  await bumpEventRevision(c.env, session.eventId);

  const rating = await db
    .prepare('SELECT ROUND(AVG(weighted_total), 2) AS v FROM reviews WHERE submission_id = ? AND plan_id = ?')
    .bind(assignment.submission_id, assignment.plan_id)
    .first<{ v: number | null }>();
  return c.json({ ok: true, weighted_total: weightedTotal, submission_rating: rating?.v ?? null });
});

// ---------------------------------------------------------------------------
// Reviewer discussion thread (workplan 7). Lives under /review/* so the
// adminApi guard's reviewer carve-out applies unchanged.
// ---------------------------------------------------------------------------

/** The assignment row a reviewer thread route hangs off, or null → 404. */
async function reviewerAssignment(
  db: D1Database,
  assignmentId: string,
  contactId: string,
  eventId: string,
): Promise<{ id: string; plan_id: string; submission_id: string; anonymise_submitters: number } | null> {
  return db
    .prepare(
      `SELECT ra.id, ra.plan_id, ra.submission_id, p.anonymise_submitters
       FROM review_assignments ra JOIN evaluation_plans p ON p.id = ra.plan_id
       WHERE ra.id = ? AND ra.reviewer_contact_id = ? AND p.event_id = ?`,
    )
    .bind(assignmentId, contactId, eventId)
    .first<{ id: string; plan_id: string; submission_id: string; anonymise_submitters: number }>();
}

// GET /review/assignments/:id/comments — the thread, once the D3 gate opens.
// The gate is server-side: a still-pending reviewer gets a bare 403 with no
// counts, authors or excerpts — the rows never leave the server.
evaluationRoutes.get('/review/assignments/:id/comments', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const assignment = await reviewerAssignment(db, c.req.param('id'), session.contactId, session.eventId);
  if (!assignment) return c.json({ error: 'not_found' }, 404);
  if (!(await canReviewerSeeThread(db, session.contactId, assignment.submission_id))) {
    return c.json({ error: 'review_not_submitted' }, 403);
  }
  const thread = await loadThread(db, assignment.submission_id);
  return c.json({
    comments: assignment.anonymise_submitters === 1 ? pseudonymiseReviewerAuthors(thread) : thread,
  });
});

// POST /review/assignments/:id/comments — reviewer reply. Same gate as the
// read: joining the discussion and reading it unlock together (D3).
evaluationRoutes.post('/review/assignments/:id/comments', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const assignment = await reviewerAssignment(db, c.req.param('id'), session.contactId, session.eventId);
  if (!assignment) return c.json({ error: 'not_found' }, 404);
  if (!(await canReviewerSeeThread(db, session.contactId, assignment.submission_id))) {
    return c.json({ error: 'review_not_submitted' }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.body !== 'string') return c.json({ error: 'empty_body' }, 400);
  const commentId = await addComment(db, {
    eventId: session.eventId,
    submissionId: assignment.submission_id,
    planId: assignment.plan_id,
    assignmentId: assignment.id,
    authorContactId: session.contactId,
    authorRole: 'reviewer',
    authorName: await loadAuthorName(db, session.contactId),
    body: body.body,
    kind: 'discussion',
  });
  if (!commentId) return c.json({ error: 'empty_body' }, 400);
  await bumpEventRevision(c.env, session.eventId);
  const thread = await loadThread(db, assignment.submission_id);
  return c.json({
    ok: true,
    id: commentId,
    comments: assignment.anonymise_submitters === 1 ? pseudonymiseReviewerAuthors(thread) : thread,
  });
});
