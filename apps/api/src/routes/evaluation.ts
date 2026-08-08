// Review & scoring (docs/06, docs/12 M3): submission status operations and
// the decisions pipeline, evaluation plan/criteria/assignment admin, and the
// reviewer-facing queue + scoring endpoints. Mounted inside /app/api — the
// shared guard already ran (admins everywhere, reviewers on /review/* only).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env } from '../env';
import { sendTemplated } from '../mailer';
import type { SessionPayload } from '../session';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const evaluationRoutes = new Hono<ApiEnv>();

const SUBMISSION_STATUSES = new Set([
  'draft', 'pending', 'accept_queue', 'accepted', 'decline_queue', 'declined', 'withdrawn',
]);

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
 * primary contact (falling back to the submitter). Existing assignments are
 * left alone, so re-sending decisions cannot duplicate work items.
 */
async function autoAssignAcceptTasks(
  c: Context<ApiEnv>,
  eventId: string,
  submission: { id: string; code: string; title: string },
  eventName: string,
  eventSlug: string,
): Promise<number> {
  const db = c.env.DB;
  const { results: tasks } = await db
    .prepare(
      `SELECT id, title, due_at FROM tasks
       WHERE event_id = ? AND assignment_mode = 'automatic' AND "trigger" = 'on_accept' AND target = 'submission'`,
    )
    .bind(eventId)
    .all<{ id: string; title: string; due_at: string | null }>();
  if (tasks.length === 0) return 0;

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

  let created = 0;
  for (const task of tasks) {
    const existing = await db
      .prepare('SELECT id FROM task_assignments WHERE task_id = ? AND contact_id = ? AND submission_id = ?')
      .bind(task.id, owner.id, submission.id)
      .first();
    if (existing) continue;
    const assignmentId = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO task_assignments (id, task_id, contact_id, submission_id, status)
         VALUES (?, ?, ?, ?, 'not_started')`,
      )
      .bind(assignmentId, task.id, owner.id, submission.id)
      .run();
    created += 1;
    const dueLine = task.due_at
      ? `, due ${new Date(task.due_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`
      : '';
    await sendTemplated(c, {
      templateKey: 'task_assigned',
      eventId,
      contactId: owner.id,
      toEmail: owner.email,
      entityId: assignmentId,
      context: {
        event: { name: eventName },
        speaker: { first_name: owner.first_name ?? 'there' },
        task: { title: `${task.title} — ${submission.code}`, due_line: dueLine, url: `${c.env.APP_URL}/portal/${eventSlug}/tasks` },
      },
    });
  }
  return created;
}

// POST /submissions/send-decisions — the batch notify (docs/06 §5). Flips
// accept_queue→accepted / decline_queue→declined, stamps notified_at, sends
// the decision template once per submission (mailer idempotency), and
// auto-assigns on-accept tasks. Other statuses in the selection are skipped.
evaluationRoutes.post('/submissions/send-decisions', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const ids = parseIds(body.ids);
  if (ids.length === 0) return c.json({ error: 'ids_required' }, 400);

  const event = await db
    .prepare('SELECT name, slug FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ name: string; slug: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await db
    .prepare(
      `SELECT s.id, s.code, s.title, s.status, s.submitter_contact_id,
              c.email AS submitter_email, c.first_name AS submitter_first_name
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.event_id = ? AND s.id IN (${placeholders}) AND s.status IN ('accept_queue', 'decline_queue')`,
    )
    .bind(session.eventId, ...ids)
    .all<{ id: string; code: string; title: string; status: string; submitter_contact_id: string | null; submitter_email: string | null; submitter_first_name: string | null }>();

  let accepted = 0;
  let declined = 0;
  let tasksAssigned = 0;
  const ts = nowIso();
  for (const s of results) {
    const isAccept = s.status === 'accept_queue';
    await db
      .prepare('UPDATE submissions SET status = ?, notified_at = ?, updated_at = ? WHERE id = ?')
      .bind(isAccept ? 'accepted' : 'declined', ts, ts, s.id)
      .run();
    if (isAccept) accepted += 1;
    else declined += 1;

    if (s.submitter_email) {
      await sendTemplated(c, {
        templateKey: isAccept ? 'decision_accepted' : 'decision_declined',
        eventId: session.eventId,
        contactId: s.submitter_contact_id,
        toEmail: s.submitter_email,
        entityId: s.id, // one decision email per submission, ever (docs/06 §5)
        context: {
          event: { name: event.name },
          speaker: { first_name: s.submitter_first_name ?? 'there' },
          submission: { title: s.title, code: s.code },
          portal_url: `${c.env.APP_URL}/portal/${event.slug}`,
        },
      });
    }
    if (isAccept) {
      tasksAssigned += await autoAssignAcceptTasks(c, session.eventId, s, event.name, event.slug);
    }
  }
  return c.json({ ok: true, accepted, declined, tasks_assigned: tasksAssigned, skipped: ids.length - results.length });
});

// GET /submissions/:id/detail — the workspace detail tab payload.
evaluationRoutes.get('/submissions/:id/detail', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const id = c.req.param('id');
  const submission = await db
    .prepare(
      `SELECT s.*, t.name AS track_name, ep.name AS plan_name, f.internal_name AS form_name
       FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
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
      `SELECT sp.role, sp.position, sp.is_primary_contact, c.id AS contact_id,
              c.first_name, c.last_name, c.email,
              CASE WHEN c.biography IS NOT NULL AND c.biography != '' THEN 1 ELSE 0 END AS has_bio,
              CASE WHEN c.headshot_asset_id IS NOT NULL THEN 1 ELSE 0 END AS has_headshot
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
evaluationRoutes.get('/evaluation/overview', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
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
    plans: plans.results,
    criteria: criteria.results,
    reviewers: reviewers.results,
    stats: stats.results,
  });
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
evaluationRoutes.get('/review/queue', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
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
  for (const planId of planIds) {
    const { results } = await db
      .prepare('SELECT id, name, description, weight, position FROM scoring_criteria WHERE plan_id = ? ORDER BY position')
      .bind(planId)
      .all();
    criteria[planId] = results;
  }

  // Participants shown unless the plan anonymises submitters (docs/06 §4).
  const participants: Record<string, unknown[]> = {};
  for (const a of assignments) {
    if (a.anonymise_submitters === 1) continue;
    const { results } = await db
      .prepare(
        `SELECT NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), '') AS name, sp.role
         FROM submission_participants sp JOIN contacts c ON c.id = sp.contact_id
         WHERE sp.submission_id = ? ORDER BY sp.position`,
      )
      .bind(a.submission_id)
      .all();
    participants[a.submission_id as string] = results;
  }

  return c.json({ assignments, criteria, participants });
});

/** Recompute the plan's mean weighted_total into submission.rating_cache. */
async function refreshRatingCache(db: D1Database, submissionId: string, planId: string): Promise<void> {
  const avg = await db
    .prepare('SELECT ROUND(AVG(weighted_total), 2) AS v FROM reviews WHERE submission_id = ? AND plan_id = ?')
    .bind(submissionId, planId)
    .first<{ v: number | null }>();
  const row = await db.prepare('SELECT rating_cache FROM submissions WHERE id = ?')
    .bind(submissionId)
    .first<{ rating_cache: string | null }>();
  let cache: Record<string, number> = {};
  try {
    cache = row?.rating_cache ? (JSON.parse(row.rating_cache) as Record<string, number>) : {};
  } catch { /* rebuild */ }
  if (avg?.v === null || avg?.v === undefined) delete cache[planId];
  else cache[planId] = avg.v;
  await db.prepare('UPDATE submissions SET rating_cache = ? WHERE id = ?')
    .bind(JSON.stringify(cache), submissionId)
    .run();
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

  const existing = await db.prepare('SELECT id FROM reviews WHERE assignment_id = ?')
    .bind(assignment.id)
    .first<{ id: string }>();
  const ts = nowIso();
  if (existing) {
    await db
      .prepare('UPDATE reviews SET scores = ?, weighted_total = ?, comment = ?, conflict_of_interest = ? WHERE id = ?')
      .bind(JSON.stringify(scores), weightedTotal, comment, conflict ? 1 : 0, existing.id)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO reviews (id, assignment_id, submission_id, reviewer_contact_id, plan_id,
           scores, weighted_total, comment, conflict_of_interest, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), assignment.id, assignment.submission_id, session.contactId,
        assignment.plan_id, JSON.stringify(scores), weightedTotal, comment, conflict ? 1 : 0, ts)
      .run();
  }
  await db
    .prepare(`UPDATE review_assignments SET status = ?, completed_at = ? WHERE id = ?`)
    .bind(conflict ? 'skipped' : 'complete', ts, assignment.id)
    .run();
  await refreshRatingCache(db, assignment.submission_id, assignment.plan_id);

  const rating = await db
    .prepare('SELECT ROUND(AVG(weighted_total), 2) AS v FROM reviews WHERE submission_id = ? AND plan_id = ?')
    .bind(assignment.submission_id, assignment.plan_id)
    .first<{ v: number | null }>();
  return c.json({ ok: true, weighted_total: weightedTotal, submission_rating: rating?.v ?? null });
});
