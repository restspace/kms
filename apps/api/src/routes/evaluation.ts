// Review & scoring (docs/06, docs/12 M3): submission status operations and
// the decisions pipeline, evaluation plan/criteria/assignment admin, and the
// reviewer-facing queue + scoring endpoints. Mounted inside /app/api — the
// shared guard already ran (admins everywhere, reviewers on /review/* only).

import { Hono } from 'hono';
import { ALL_PARTICIPANT_ROLES } from '@kms/core';
import type { Env } from '../env';
import type { SendTemplatedArgs } from '../mailer';
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
 * job expander (queueTemplated, cron has no request Context) — the expander
 * passes `entityPrefix` so its keys carry the job id per the bulk-job
 * idempotency convention (see jobs/bulkJobs.ts).
 */
export async function autoAssignAcceptTasksCore(
  db: D1Database,
  eventId: string,
  submission: { id: string; code: string; title: string },
  eventName: string,
  eventSlug: string,
  appUrl: string,
  send: (args: SendTemplatedArgs) => Promise<unknown>,
  entityPrefix?: string,
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
      entityId: entityPrefix ? `${entityPrefix}:${row.id}` : row.id,
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
      `SELECT s.id, s.status, s.notified_at
       FROM submissions s
       WHERE s.event_id = ? AND s.id IN (${placeholders})`,
    )
    .bind(session.eventId, ...ids)
    .all<{ id: string; status: string; notified_at: string | null }>();

  // Rows outside the queues are skipped; split out those already notified so
  // the UI can say "nothing re-sent" rather than a bare zero (docs/06 §5).
  const queued = results.filter((s) => s.status === 'accept_queue' || s.status === 'decline_queue');
  const skippedNotified = results.filter(
    (s) => s.status !== 'accept_queue' && s.status !== 'decline_queue' && s.notified_at !== null,
  ).length;
  const accepted = queued.filter((s) => s.status === 'accept_queue').length;
  const declined = queued.filter((s) => s.status === 'decline_queue').length;

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
  }

  return c.json({
    ok: true,
    accepted,
    declined,
    tasks_assigned: 0,
    skipped: ids.length - queued.length,
    skipped_notified: skippedNotified,
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
      `SELECT sp.id AS participant_id, sp.role, sp.position, sp.is_primary_contact, c.id AS contact_id,
              c.first_name, c.last_name, c.email,
              CASE WHEN c.biography IS NOT NULL AND c.biography != '' THEN 1 ELSE 0 END AS has_bio,
              CASE WHEN c.headshot_asset_id IS NOT NULL THEN 1 ELSE 0 END AS has_headshot,
              c.headshot_asset_id AS headshot_asset_id
       FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
       WHERE sp.submission_id = ? ORDER BY sp.position`,
    ).bind(id).all(),
    db.prepare(
      `SELECT r.weighted_total, r.comment, r.conflict_of_interest, r.created_at,
              NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS reviewer_name
       FROM reviews r JOIN contacts c ON c.id = r.reviewer_contact_id
       WHERE r.submission_id = ? AND r.plan_id = (SELECT evaluation_plan_id FROM submissions WHERE id = ?)
       ORDER BY r.created_at`,
    ).bind(id, id).all(),
    db.prepare(
      `SELECT tg.name FROM submission_tags st JOIN tags tg ON tg.id = st.tag_id WHERE st.submission_id = ?`,
    ).bind(id).all(),
  ]);

  return c.json({
    submission,
    answers: answers.results,
    participants: participants.results,
    reviews: reviews.results,
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
    const [plans, criteria, reviewers, stats] = await Promise.all([
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
      db.prepare(
        `SELECT p.id AS plan_id,
                (SELECT COUNT(*) FROM submissions s WHERE s.evaluation_plan_id = p.id) AS submissions,
                (SELECT COUNT(*) FROM review_assignments ra WHERE ra.plan_id = p.id) AS assignments,
                (SELECT COUNT(*) FROM review_assignments ra WHERE ra.plan_id = p.id AND ra.status = 'complete') AS completed
         FROM evaluation_plans p WHERE p.event_id = ?`,
      ).bind(session.eventId).all(),
    ]);
    return c.json({
      plans: plans.results ?? [],
      criteria: criteria.results ?? [],
      reviewers: reviewers.results ?? [],
      stats: stats.results ?? [],
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
  if (typeof body.anonymise_submitters === 'boolean') { sets.push('anonymise_submitters = ?'); params.push(body.anonymise_submitters ? 1 : 0); }
  if (sets.length === 0) return c.json({ ok: true });
  const result = await c.env.DB.prepare(
    `UPDATE evaluation_plans SET ${sets.join(', ')} WHERE id = ? AND event_id = ?`,
  )
    .bind(...params, c.req.param('id'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
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

// POST /evaluation/plans/:id/assign — create review assignments for every
// submission on the plan. 'all' gives each reviewer everything; 'round_robin'
// deals N reviewers per submission in rotation. INSERT OR IGNORE + the
// UNIQUE(plan, submission, reviewer) index make re-runs additive, never
// duplicating (docs/06 acceptance #1).
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

  const { results: submissions } = await db
    .prepare(`SELECT id FROM submissions WHERE evaluation_plan_id = ? AND status NOT IN ('draft', 'withdrawn')`)
    .bind(planId)
    .all<{ id: string }>();

  const statements: D1PreparedStatement[] = [];
  const ts = nowIso();
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
  if (statements.length > 0) await db.batch(statements);
  const count = await db.prepare('SELECT COUNT(*) AS n FROM review_assignments WHERE plan_id = ?')
    .bind(planId)
    .first<{ n: number }>();
  return c.json({ ok: true, total_assignments: count?.n ?? 0, submissions: submissions.length });
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

    // Participants shown unless the plan anonymises submitters (docs/06 §4).
    const submissionIds = [
      ...new Set(
        assignments.filter((a) => a.anonymise_submitters !== 1).map((a) => a.submission_id as string),
      ),
    ];
    const participants: Record<string, unknown[]> = {};
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
      `SELECT ra.id, ra.plan_id, ra.submission_id, p.scoring_scale_min, p.scoring_scale_max
       FROM review_assignments ra JOIN evaluation_plans p ON p.id = ra.plan_id
       WHERE ra.id = ? AND ra.reviewer_contact_id = ? AND p.event_id = ?`,
    )
    .bind(c.req.param('id'), session.contactId, session.eventId)
    .first<{ id: string; plan_id: string; submission_id: string; scoring_scale_min: number; scoring_scale_max: number }>();
  if (!assignment) return c.json({ error: 'not_found' }, 404);

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
