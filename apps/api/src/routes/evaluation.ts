// Review & scoring (docs/06, docs/12 M3): submission status operations and
// the decisions pipeline, evaluation plan/criteria/assignment admin, and the
// reviewer-facing queue + scoring endpoints. Mounted inside /app/api — the
// shared guard already ran (admins everywhere, reviewers on /review/* only).

import { Hono } from 'hono';
import type { Context } from 'hono';
import { ALL_PARTICIPANT_ROLES } from '@kms/core';
import type { AppEnv, Env } from '../env';
import type { SendTemplatedArgs } from '../mailer';
import { sendTemplated } from '../mailer';
import { sweepBulkJobs } from '../jobs/bulkJobs';
import { requestMagicLink } from './auth';
import { mintToken } from '../tokens';
import { bumpEventRevision } from '../revision';
import { isWriter } from '../access';
import type { SessionPayload } from '../session';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const evaluationRoutes = new Hono<ApiEnv>();

const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

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

export interface ReviewWindow {
  opens_at: string | null;
  closes_at: string | null;
}

/**
 * ABS-01: a plan may carry an optional review window. Null on either side is
 * "no bound", so a plan that never sets dates is always open — every existing
 * plan keeps its current behaviour.
 */
export function reviewWindowState(
  plan: ReviewWindow,
  now = Date.now(),
): { open: boolean; reason: 'not_yet_open' | 'closed' | null } {
  if (plan.opens_at) {
    const opens = Date.parse(plan.opens_at);
    if (Number.isFinite(opens) && now < opens) return { open: false, reason: 'not_yet_open' };
  }
  if (plan.closes_at) {
    const closes = Date.parse(plan.closes_at);
    if (Number.isFinite(closes) && now > closes) return { open: false, reason: 'closed' };
  }
  return { open: true, reason: null };
}

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
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  const event = await db
    .prepare('SELECT name, slug FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ name: string; slug: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT s.id, s.status, s.notified_at, c.email AS submitter_email
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.event_id = ? AND s.id IN (${placeholders})`,
    )
    .bind(session.eventId, ...ids)
    .all<{ id: string; status: string; notified_at: string | null; submitter_email: string | null }>();

  // Rows outside the queues are skipped; split out those already notified so
  // the UI can say "nothing re-sent" rather than a bare zero (docs/06 §5).
  const queued = results.filter((s) => s.status === 'accept_queue' || s.status === 'decline_queue');
  const skippedNotified = results.filter(
    (s) => s.status !== 'accept_queue' && s.status !== 'decline_queue' && s.notified_at !== null,
  ).length;
  const accepted = queued.filter((s) => s.status === 'accept_queue').length;
  const declined = queued.filter((s) => s.status === 'decline_queue').length;
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
        JSON.stringify({ ids: queued.map((s) => s.id), include_feedback: includeFeedback }),
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
    tasks_assigned: 0,
    skipped: ids.length - queued.length,
    skipped_notified: skippedNotified,
    skipped_no_submitter: queuedNoSubmitter,
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

  const result = await c.env.DB.prepare(
    `UPDATE submissions SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`,
  )
    .bind(...params, id, session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  const row = await c.env.DB.prepare('SELECT * FROM submissions WHERE id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .first();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json(row);
});

// ---------------------------------------------------------------------------
// Submission participants (F14/ABS-11): adding a co-speaker/co-author/etc.
// retroactively — the portal's own submit flow (submit.tsx) already does the
// atomic upsert-contact-by-email version of this; here the admin already
// knows the contact_id (picked from Speakers), so this is a plain insert
// against the existing contact, scoped to the organiser's event.
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

  const submission = await c.env.DB.prepare('SELECT id FROM submissions WHERE id = ? AND event_id = ?')
    .bind(submissionId, session.eventId)
    .first();
  if (!submission) return c.json({ error: 'not_found' }, 404);
  const contact = await c.env.DB.prepare('SELECT id FROM contacts WHERE id = ? AND event_id = ?')
    .bind(contactId, session.eventId)
    .first();
  if (!contact) return c.json({ error: 'contact_not_found' }, 404);

  const { results: existingRows } = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(position), -1) AS max_position FROM submission_participants WHERE submission_id = ?',
  ).bind(submissionId).all<{ max_position: number }>();
  const nextPosition = (existingRows[0]?.max_position ?? -1) + 1;

  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO submission_participants (id, submission_id, contact_id, role, position, is_primary_contact)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, submissionId, contactId, role, nextPosition, body.is_primary_contact === true ? 1 : 0)
      .run();
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

  const [answers, participants, reviews, tags] = await Promise.all([
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
              CASE WHEN c.biography IS NOT NULL AND c.biography != '' THEN 1 ELSE 0 END AS has_bio,
              CASE WHEN c.headshot_asset_id IS NOT NULL THEN 1 ELSE 0 END AS has_headshot,
              c.headshot_asset_id AS headshot_asset_id
       FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    ).bind(id).all(),
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
      `SELECT r.weighted_total, r.comment, r.conflict_of_interest, r.created_at,
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
  });
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
    const [plans, criteria, reviewers, stats, pool, workload] = await Promise.all([
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
        `SELECT epr.plan_id, epr.contact_id FROM evaluation_plan_reviewers epr
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
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO evaluation_plans (id, event_id, name, description, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`,
  )
    .bind(id, session.eventId, name, typeof body.description === 'string' ? body.description : null, nowIso())
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
  const pos = await c.env.DB.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM scoring_criteria WHERE plan_id = ?')
    .bind(planId)
    .first<{ n: number }>();
  await c.env.DB.prepare(
    `INSERT INTO scoring_criteria (id, plan_id, name, description, weight, position)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), planId, name, typeof body.description === 'string' ? body.description : null,
      Number.isFinite(weight) && weight > 0 ? weight : 1, pos?.n ?? 1)
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
        `UPDATE submissions SET evaluation_plan_id = ?
         WHERE id IN (${placeholders}) AND event_id = ? AND evaluation_plan_id IS NULL`,
      )
      .bind(planId, ...ids, session.eventId)
      .run();
  } else {
    const removed = await db
      .prepare(`DELETE FROM evaluation_plan_submissions WHERE plan_id = ? AND submission_id IN (${placeholders})`)
      .bind(planId, ...ids)
      .run();
    changed = removed.meta.changes ?? 0;
    await db
      .prepare(
        `UPDATE submissions SET evaluation_plan_id = NULL
         WHERE id IN (${placeholders}) AND event_id = ? AND evaluation_plan_id = ?`,
      )
      .bind(...ids, session.eventId, planId)
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
  let cursor = 0;
  for (const submission of submissions) {
    const chosen =
      strategy === 'all'
        ? reviewerIds
        : Array.from({ length: perSubmission }, (_, i) => reviewerIds[(cursor + i) % reviewerIds.length]!);
    if (strategy === 'round_robin') cursor = (cursor + perSubmission) % reviewerIds.length;
    for (const reviewerId of chosen) {
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

  await db
    .prepare('INSERT OR IGNORE INTO evaluation_plan_reviewers (plan_id, contact_id, added_at) VALUES (?, ?, ?)')
    .bind(planId, contactId, nowIso())
    .run();
  return c.json({ ok: true, plan_id: planId, contact_id: contactId }, 201);
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
  let contact = await db
    .prepare('SELECT id, email, first_name, last_name FROM contacts WHERE event_id = ? AND lower(email) = ?')
    .bind(session.eventId, email)
    .first<{ id: string; email: string; first_name: string | null; last_name: string | null }>();
  const created = !contact;
  if (!contact) {
    const id = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO contacts (id, event_id, email, first_name, last_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(id, session.eventId, email, first || null, last || null, ts, ts)
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
       JOIN event_users eu ON eu.contact_id = c.id AND eu.event_id = c.event_id
       WHERE c.id = ? AND c.event_id = ?`,
    )
    .bind(c.req.param('contactId'), session.eventId)
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
                r.scores AS my_scores, r.comment AS my_comment, r.conflict_of_interest AS my_conflict
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
          `SELECT id, name, description, weight, position, plan_id FROM scoring_criteria
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
       END
       WHERE id = ?1`,
    )
    .bind(submissionId, planId);
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
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, 5000) : null;

  const { results: criteria } = await db
    .prepare('SELECT id, weight FROM scoring_criteria WHERE plan_id = ?')
    .bind(assignment.plan_id)
    .all<{ id: string; weight: number }>();

  const rawScores = (body.scores ?? {}) as Record<string, unknown>;
  const scores: Record<string, number> = {};
  let weightedSum = 0;
  let weightTotal = 0;
  for (const criterion of criteria) {
    const value = Number(rawScores[criterion.id]);
    if (!Number.isFinite(value)) continue;
    const clamped = Math.min(Math.max(value, assignment.scoring_scale_min), assignment.scoring_scale_max);
    scores[criterion.id] = clamped;
    weightedSum += clamped * criterion.weight;
    weightTotal += criterion.weight;
  }
  if (!conflict && Object.keys(scores).length < criteria.length) {
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
         scores, weighted_total, comment, conflict_of_interest, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(assignment_id) WHERE assignment_id IS NOT NULL DO UPDATE SET
         scores = excluded.scores,
         weighted_total = excluded.weighted_total,
         comment = excluded.comment,
         conflict_of_interest = excluded.conflict_of_interest`,
    )
    .bind(crypto.randomUUID(), assignment.id, assignment.submission_id, session.contactId,
      assignment.plan_id, JSON.stringify(scores), weightedTotal, comment, conflict ? 1 : 0, ts);

  const assignmentUpdate = db
    .prepare(`UPDATE review_assignments SET status = ?, completed_at = ? WHERE id = ?`)
    .bind(conflict ? 'skipped' : 'complete', ts, assignment.id);

  await db.batch([reviewUpsert, assignmentUpdate, ratingCacheStatement(db, assignment.submission_id, assignment.plan_id)]);
  await bumpEventRevision(c.env, session.eventId);

  const rating = await db
    .prepare('SELECT ROUND(AVG(weighted_total), 2) AS v FROM reviews WHERE submission_id = ? AND plan_id = ?')
    .bind(assignment.submission_id, assignment.plan_id)
    .first<{ v: number | null }>();
  return c.json({ ok: true, weighted_total: weightedTotal, submission_rating: rating?.v ?? null });
});
