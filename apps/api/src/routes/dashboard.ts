// Dashboards (docs/09, docs/12 M5). One GET serves all three fixed layouts —
// Today, Speaker Tracking, Submissions Pipeline — because they share most
// aggregates and a single payload keeps the 15-second poll to one request.
// Freshness comes from ETag/If-None-Match: aggregates are recomputed per read
// (the event fits in a handful of indexed queries) and an unchanged payload
// costs a 304. Conflict counts reuse the @kms/core engine via the agenda
// loaders so the dashboard can never disagree with the agenda screen.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { computeConflicts } from '@kms/core';
import type { AgendaRoomInput } from '@kms/core';
import type { AccessEnv } from '../access';
import { sweepBulkJobs } from '../jobs/bulkJobs';
import { getEventRevision } from '../revision';
import { loadIgnored, loadSessions, toEngineInput } from './agenda';

type ApiEnv = AccessEnv;

/** Payload cache lifetime; the revision key makes staleness impossible, this
 * is only the backstop for a bump that never landed (KV write failure). */
const DASHBOARD_CACHE_TTL_SECONDS = 600;

export const dashboardRoutes = new Hono<ApiEnv>();

interface EventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
}

export interface SpeakerAggRow {
  contact_id: string;
  name: string | null;
  email: string;
  mobile_phone: string | null;
  arrived_at: string | null;
  arrival_marked_by: string | null;
  missing_bio: number;
  missing_headshot: number;
  missing_slides: number;
  outstanding: number;
  overdue: number;
  confirmed: number;
}

/**
 * One pass over accepted speakers: readiness (bio/headshot/slides), task
 * counters, confirmation state — plus phone and arrival for the green room.
 * Shared by the dashboard and the green room (workplan 12) so the two screens
 * can never disagree about who is missing what. The task counters come from
 * one grouped aggregate joined in, not three correlated subqueries per
 * contact (sweep item P2-16).
 */
export async function speakerTracking(
  db: D1Database,
  eventId: string,
  now: string,
): Promise<SpeakerAggRow[]> {
  const { results } = await db.prepare(
    `SELECT c.id AS contact_id,
            NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
            c.email,
            c.mobile_phone,
            ec.arrived_at,
            ec.arrival_marked_by,
            CASE WHEN ec.biography IS NULL OR ec.biography = '' THEN 1 ELSE 0 END AS missing_bio,
            CASE WHEN ec.headshot_asset_id IS NULL THEN 1 ELSE 0 END AS missing_headshot,
            COALESCE(tg.missing_slides, 0) AS missing_slides,
            COALESCE(tg.outstanding, 0) AS outstanding,
            COALESCE(tg.overdue, 0) AS overdue,
            CASE WHEN cf.contact_id IS NULL THEN 0 ELSE 1 END AS confirmed
     FROM contacts c
     -- 0015: membership guard AND the source of the profile columns. Bio and
     -- headshot are per-event, so a speaker who wrote a bio at another event
     -- in the org still reads as missing one here — the panel is about what
     -- THIS event has on file.
     JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?1
     JOIN (SELECT DISTINCT sp.contact_id
           FROM submission_participants sp
           JOIN submissions s ON s.id = sp.submission_id
           WHERE s.event_id = ?1 AND s.status = 'accepted') acc ON acc.contact_id = c.id
     LEFT JOIN (SELECT ta.contact_id,
                       -- A contact can carry more than one file_upload
                       -- assignment (e.g. co-presenting a second accepted
                       -- talk, or an unrelated upload task an organiser
                       -- added). Counting *any* incomplete one flagged
                       -- "missing slides" even after the presentation
                       -- upload itself was done, contradicting the Tasks
                       -- tab where that assignment showed complete with
                       -- uploaded versions. A completed file_upload
                       -- assignment now counts as "slides present" outright;
                       -- only contacts with file_upload assignments and
                       -- none of them complete are still flagged.
                       CASE WHEN SUM(CASE WHEN t.action_type = 'file_upload' AND ta.status = 'complete' THEN 1 ELSE 0 END) > 0 THEN 0
                            WHEN SUM(CASE WHEN t.action_type = 'file_upload' THEN 1 ELSE 0 END) > 0 THEN 1
                            ELSE 0 END AS missing_slides,
                       SUM(CASE WHEN ta.status != 'complete' THEN 1 ELSE 0 END) AS outstanding,
                       SUM(CASE WHEN ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?2 THEN 1 ELSE 0 END) AS overdue
                FROM task_assignments ta
                JOIN tasks t ON t.id = ta.task_id
                WHERE t.event_id = ?1
                GROUP BY ta.contact_id) tg ON tg.contact_id = c.id
     LEFT JOIN (SELECT DISTINCT sp2.contact_id
                FROM submission_participants sp2
                JOIN submissions s2 ON s2.id = sp2.submission_id
                WHERE s2.event_id = ?1 AND s2.status = 'accepted'
                  AND sp2.confirmed_at IS NOT NULL) cf ON cf.contact_id = c.id
     ORDER BY outstanding DESC, overdue DESC, name`,
  ).bind(eventId, now).all<SpeakerAggRow>();
  return results;
}

interface OverdueRow {
  assignment_id: string;
  contact_id: string;
  name: string | null;
  email: string;
  task_title: string;
  due_at: string;
}

/** Calendar day of a UTC instant in the event's timezone (YYYY-MM-DD). */
function dayInTz(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso));
}

const fullName = (name: string | null, email: string): string => name || email;

async function dashboardPayload(c: Context<ApiEnv>) {
  const session = c.get('session');
  const db = c.env.DB;
  const eventId = session.eventId;
  const now = new Date().toISOString();

  const [
    event,
    statusRows,
    speakerAgg,
    overdueRows,
    formRows,
    recentRows,
    pacingRows,
    roleRows,
    kindStatusRows,
    reviewerRows,
    reviewStats,
    planRows,
    trackRows,
    funnelRow,
    roomRows,
    sessions,
    ignored,
    approvalRows,
  ] = await Promise.all([
    db.prepare('SELECT id, name, slug, timezone, starts_at, ends_at FROM events WHERE id = ?').bind(eventId).first<EventRow>(),
    db.prepare('SELECT status, COUNT(*) AS n FROM submissions WHERE event_id = ? GROUP BY status').bind(eventId).all<{ status: string; n: number }>(),
    // One pass over accepted speakers powers the stat, the confirmation mix,
    // top-by-outstanding and asset completeness — shared with the green room.
    speakerTracking(db, eventId, now),
    db.prepare(
      `SELECT ta.id AS assignment_id, ta.contact_id,
              NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
              c.email, t.title AS task_title, t.due_at
       FROM task_assignments ta
       JOIN tasks t ON t.id = ta.task_id
       JOIN contacts c ON c.id = ta.contact_id
       WHERE t.event_id = ? AND ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?
       ORDER BY t.due_at, name`,
    ).bind(eventId, now).all<OverdueRow>(),
    db.prepare(
      `SELECT f.id, f.internal_name, f.status, f.close_at,
              (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id AND s.status != 'draft') AS submission_count,
              (SELECT COUNT(*) FROM submissions s WHERE s.form_id = f.id AND s.status = 'draft') AS draft_count
       FROM submission_forms f WHERE f.event_id = ? ORDER BY f.created_at`,
    ).bind(eventId).all(),
    db.prepare(
      `SELECT s.id, s.code, s.title, s.status, s.source, s.created_at, t.name AS track_name,
              NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS submitter_name
       FROM submissions s
       LEFT JOIN tracks t ON t.id = s.track_id
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.event_id = ? AND s.status != 'draft'
       ORDER BY s.created_at DESC LIMIT 8`,
    ).bind(eventId).all(),
    db.prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM submissions WHERE event_id = ? AND status != 'draft'
       GROUP BY day ORDER BY day`,
    ).bind(eventId).all<{ day: string; n: number }>(),
    db.prepare(
      `SELECT sp.role, COUNT(DISTINCT sp.contact_id) AS n
       FROM submission_participants sp
       JOIN submissions s ON s.id = sp.submission_id
       WHERE s.event_id = ? GROUP BY sp.role ORDER BY n DESC`,
    ).bind(eventId).all<{ role: string; n: number }>(),
    db.prepare(
      `SELECT kind, status, COUNT(*) AS n FROM submissions
       WHERE event_id = ? AND status IN ('accepted', 'pending') GROUP BY kind, status`,
    ).bind(eventId).all<{ kind: string; status: string; n: number }>(),
    db.prepare(
      `SELECT NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
              c.email, COUNT(*) AS assigned,
              SUM(CASE WHEN ra.status = 'complete' THEN 1 ELSE 0 END) AS completed
       FROM review_assignments ra
       JOIN evaluation_plans ep ON ep.id = ra.plan_id
       JOIN contacts c ON c.id = ra.reviewer_contact_id
       WHERE ep.event_id = ? GROUP BY ra.reviewer_contact_id ORDER BY assigned DESC`,
    ).bind(eventId).all<{ name: string | null; email: string; assigned: number; completed: number }>(),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM reviews r JOIN evaluation_plans ep ON ep.id = r.plan_id
               WHERE ep.event_id = ?1) AS reviews,
              (SELECT COUNT(DISTINCT r.submission_id) FROM reviews r JOIN evaluation_plans ep ON ep.id = r.plan_id
               WHERE ep.event_id = ?1) AS evaluated,
              (SELECT COUNT(*) FROM review_assignments ra JOIN evaluation_plans ep ON ep.id = ra.plan_id
               WHERE ep.event_id = ?1 AND ra.status = 'in_progress') AS in_progress`,
    ).bind(eventId).first<{ reviews: number; evaluated: number; in_progress: number }>(),
    db.prepare(
      `SELECT ep.name, COUNT(r.id) AS n FROM evaluation_plans ep
       LEFT JOIN reviews r ON r.plan_id = ep.id
       WHERE ep.event_id = ? GROUP BY ep.id ORDER BY n DESC`,
    ).bind(eventId).all<{ name: string; n: number }>(),
    db.prepare(
      `SELECT COALESCE(t.name, 'No track') AS name, COUNT(*) AS n
       FROM submissions s LEFT JOIN tracks t ON t.id = s.track_id
       WHERE s.event_id = ? AND s.status != 'draft' GROUP BY t.id ORDER BY n DESC`,
    ).bind(eventId).all<{ name: string; n: number }>(),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM submissions WHERE event_id = ?1 AND status != 'draft') AS received,
              (SELECT COUNT(DISTINCT r.submission_id) FROM reviews r
               JOIN submissions s ON s.id = r.submission_id WHERE s.event_id = ?1) AS reviewed,
              (SELECT COUNT(*) FROM submissions WHERE event_id = ?1
               AND status IN ('accepted', 'declined', 'accept_queue', 'decline_queue')) AS decided,
              (SELECT COUNT(*) FROM submissions WHERE event_id = ?1 AND status = 'accepted') AS accepted,
              (SELECT COUNT(*) FROM submissions WHERE event_id = ?1 AND status = 'accepted'
               AND starts_at IS NOT NULL AND room_id IS NOT NULL) AS scheduled`,
    ).bind(eventId).first<{ received: number; reviewed: number; decided: number; accepted: number; scheduled: number }>(),
    db.prepare('SELECT id, name, capacity FROM rooms WHERE event_id = ? ORDER BY position').bind(eventId).all<AgendaRoomInput & { capacity: number | null }>(),
    loadSessions(db, eventId),
    loadIgnored(c.env.KV, eventId),
    // Workplan 13 W3: accepted-but-awaiting-employer-approval, for the
    // tracking board's "Approval pending" panel — "approval chatter peaks
    // about a month out" is only actionable if it is visible a month out.
    db.prepare(
      `SELECT s.id AS submission_id, s.code, s.title, s.approval_note, s.starts_at,
              s.submitter_contact_id AS contact_id,
              NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
              c.email
       FROM submissions s
       LEFT JOIN contacts c ON c.id = s.submitter_contact_id
       WHERE s.event_id = ? AND s.approval_state = 'pending'`,
    ).bind(eventId).all<{
      submission_id: string; code: string; title: string; approval_note: string | null;
      starts_at: string | null; contact_id: string | null; name: string | null; email: string | null;
    }>(),
  ]);

  if (!event) return null;

  const status: Record<string, number> = {};
  for (const row of statusRows.results) status[row.status] = row.n;
  const n = (key: string) => status[key] ?? 0;

  const speakers = speakerAgg;
  const outstandingTotal = speakers.reduce((sum, s) => sum + s.outstanding, 0);
  const missingBio = speakers.filter((s) => s.missing_bio === 1);
  const missingHeadshot = speakers.filter((s) => s.missing_headshot === 1);
  const missingAny = speakers.filter((s) => s.missing_bio === 1 || s.missing_headshot === 1 || s.missing_slides > 0);

  // Conflicts through the shared engine, honouring the agenda's ignore list.
  const ignoredSet = new Set(ignored);
  const conflicts = computeConflicts(toEngineInput(sessions), roomRows.results, {
    starts_at: event.starts_at,
    ends_at: event.ends_at,
  }).filter((cf) => !ignoredSet.has(cf.signature));
  const conflictCounts = {
    error: conflicts.filter((cf) => cf.severity === 'error').length,
    warning: conflicts.filter((cf) => cf.severity === 'warning').length,
    info: conflicts.filter((cf) => cf.severity === 'info').length,
  };

  const scheduled = sessions.filter((s) => s.starts_at !== null && s.room_id !== null);
  const unscheduledCount = sessions.length - scheduled.length;
  const perDay = new Map<string, number>();
  for (const s of scheduled) {
    const day = dayInTz(s.starts_at as string, event.timezone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const perRoom = new Map<string, number>();
  for (const s of scheduled) {
    const room = roomRows.results.find((r) => r.id === s.room_id)?.name ?? 'Unknown room';
    perRoom.set(room, (perRoom.get(room) ?? 0) + 1);
  }

  // The "Also check" strip (docs/09 §1) — each key maps to a deep-link client-side.
  const plur = (count: number, one: string, many: string) => (count === 1 ? one : many);
  const nudges: Array<{ key: string; count: number; text: string }> = [];
  if (unscheduledCount > 0) {
    nudges.push({
      key: 'unscheduled',
      count: unscheduledCount,
      text: `${unscheduledCount} accepted ${plur(unscheduledCount, 'session still needs', 'sessions still need')} a time slot on the agenda.`,
    });
  }
  if (n('pending') > 0) {
    nudges.push({
      key: 'pending',
      count: n('pending'),
      text: `${n('pending')} ${plur(n('pending'), 'submission is', 'submissions are')} awaiting a decision.`,
    });
  }
  const staged = n('accept_queue') + n('decline_queue');
  if (staged > 0) {
    nudges.push({
      key: 'staged',
      count: staged,
      text: `${staged} ${plur(staged, 'decision is', 'decisions are')} staged but the speakers haven't been told yet.`,
    });
  }
  if (missingBio.length > 0 || missingHeadshot.length > 0) {
    const affected = new Set([...missingBio, ...missingHeadshot].map((s) => s.contact_id)).size;
    nudges.push({
      key: 'assets',
      count: affected,
      text: `${affected} accepted ${plur(affected, 'speaker is', 'speakers are')} missing a bio or headshot (${missingBio.length} ${plur(missingBio.length, 'bio', 'bios')}, ${missingHeadshot.length} ${plur(missingHeadshot.length, 'headshot', 'headshots')}).`,
    });
  }
  const withOutstanding = speakers.filter((s) => s.outstanding > 0).length;
  if (withOutstanding > 0) {
    nudges.push({
      key: 'outstanding',
      count: withOutstanding,
      text: `${withOutstanding} ${plur(withOutstanding, 'speaker has', 'speakers have')} outstanding tasks.`,
    });
  }
  if (overdueRows.results.length > 0) {
    nudges.push({
      key: 'overdue',
      count: overdueRows.results.length,
      text: `${overdueRows.results.length} speaker ${plur(overdueRows.results.length, 'task is', 'tasks are')} overdue.`,
    });
  }
  if (conflictCounts.error > 0) {
    nudges.push({
      key: 'conflicts',
      count: conflictCounts.error,
      text: `${conflictCounts.error} scheduling ${plur(conflictCounts.error, 'conflict needs', 'conflicts need')} attention on the agenda.`,
    });
  }

  let cumulative = 0;
  const pacing = pacingRows.results.map((row) => {
    cumulative += row.n;
    return { day: row.day, count: row.n, cumulative };
  });

  return {
    now,
    event,
    kpis: {
      // Every submission in the event: the status tiles below (accepted,
      // pending, declined, drafts, withdrawn) are this number's breakdown
      // (docs/09 §1), so excluding drafts here made the two disagree.
      submissions: Object.values(status).reduce((a, b) => a + b, 0),
      accepted_speakers: speakers.length,
    },
    status_tiles: {
      accepted: n('accepted'),
      pending: n('pending') + staged,
      declined: n('declined'),
      drafts: n('draft'),
      withdrawn: n('withdrawn'),
    },
    nudges,
    forms: {
      forms: formRows.results,
      recent: recentRows.results,
      pacing,
    },
    participants: {
      by_role: roleRows.results,
      status_mix: kindStatusRows.results,
    },
    evaluations: {
      reviewers: reviewerRows.results,
      reviews: reviewStats?.reviews ?? 0,
      evaluated_submissions: reviewStats?.evaluated ?? 0,
      in_progress: reviewStats?.in_progress ?? 0,
      plans: planRows.results,
    },
    agenda: {
      scheduled: scheduled.length,
      unscheduled: unscheduledCount,
      per_day: [...perDay.entries()].sort().map(([day, count]) => ({ day, count })),
      per_room: [...perRoom.entries()].map(([room, count]) => ({ room, count })),
      conflicts: conflictCounts,
    },
    tracking: {
      accepted_speakers: speakers.length,
      outstanding_tasks: outstandingTotal,
      confirmation: {
        confirmed: speakers.filter((s) => s.confirmed === 1).length,
        awaiting: speakers.filter((s) => s.confirmed !== 1).length,
      },
      top_speakers: speakers
        .filter((s) => s.outstanding > 0)
        .slice(0, 8)
        .map((s) => ({ contact_id: s.contact_id, name: fullName(s.name, s.email), outstanding: s.outstanding, overdue: s.overdue })),
      overdue: overdueRows.results.map((row) => ({
        ...row,
        name: fullName(row.name, row.email),
        days_overdue: Math.max(1, Math.floor((Date.parse(now) - Date.parse(row.due_at)) / 86_400_000)),
      })),
      // Days-until-event ascending: the session's own slot when it has one,
      // the event start otherwise — the soonest exposure sorts first.
      approval_pending: approvalRows.results
        .map((row) => ({
          submission_id: row.submission_id,
          code: row.code,
          title: row.title,
          approval_note: row.approval_note,
          contact_id: row.contact_id,
          name: row.name ?? row.email ?? 'No submitter',
          days_until_event: Math.ceil(
            (Date.parse(row.starts_at ?? event.starts_at) - Date.parse(now)) / 86_400_000,
          ),
        }))
        .sort((a, b) => a.days_until_event - b.days_until_event),
      assets: missingAny.map((s) => ({
        contact_id: s.contact_id,
        name: fullName(s.name, s.email),
        missing_bio: s.missing_bio,
        missing_headshot: s.missing_headshot,
        missing_slides: s.missing_slides > 0 ? 1 : 0,
      })),
    },
    pipeline: {
      total: funnelRow?.received ?? 0,
      pending_review: n('pending'),
      by_form: formRows.results.map((f) => {
        const row = f as { internal_name: string; submission_count: number };
        return { name: row.internal_name, count: row.submission_count };
      }),
      by_track: trackRows.results.map((row) => ({ name: row.name, count: row.n })),
      funnel: funnelRow ?? { received: 0, reviewed: 0, decided: 0, accepted: 0, scheduled: 0 },
    },
  };
}

// GET /app/api/dashboard — the whole board. The ETag is the event revision
// (sweep item P2-16), computed *before* any query: an idle 15 s poll costs one
// KV read and zero D1 queries. A revision miss still tries the KV payload
// cache keyed on the same revision, so only a genuine change pays for the
// aggregate block (docs/09 §7).
dashboardRoutes.get('/', async (c) => {
  const eventId = c.get('session').eventId;
  const revision = await getEventRevision(c.env, eventId);
  const etag = `"r${revision}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);

  const cacheKey = `dash:${eventId}:${revision}`;
  const cached = await c.env.KV.get<Record<string, unknown>>(cacheKey, 'json').catch(() => null);
  // `now` is the only field that must not come out of a cache — everything
  // else is a snapshot of the revision this key names.
  if (cached) return c.json({ ...cached, now: new Date().toISOString() });

  const payload = await dashboardPayload(c);
  if (!payload) return c.json({ error: 'not_found' }, 404);
  await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: DASHBOARD_CACHE_TTL_SECONDS })
    .catch(() => {});
  return c.json(payload);
});

// POST /app/api/dashboard/remind { assignment_ids?: string[] } — queue task
// reminders for overdue assignments; empty/omitted ids means "remind all".
// The request no longer sends inline (a big event exceeded the request budget,
// sweep item P2-19): it snapshots a bulk_jobs row and the cron expander sends
// in chunks with `bulk:<jobId>:<contactId>` keys, which keeps the per-assignment
// idempotency guarantee (docs/09 §10 test 5). `sent`/`skipped` stay in the body
// as zeros for the pre-job clients; poll GET /app/api/bulk-jobs/:id for progress.
dashboardRoutes.post('/remind', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const now = new Date().toISOString();
  const body = (await c.req.json().catch(() => ({}))) as { assignment_ids?: unknown };
  const requested = Array.isArray(body.assignment_ids)
    ? body.assignment_ids.filter((v): v is string => typeof v === 'string')
    : null;

  const event = await db.prepare('SELECT id FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ id: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  const requestedSet = requested === null ? null : new Set(requested);
  const overdue = await db.prepare(
    `SELECT ta.id AS assignment_id
     FROM task_assignments ta
     JOIN tasks t ON t.id = ta.task_id
     WHERE t.event_id = ? AND ta.status != 'complete' AND t.due_at IS NOT NULL AND t.due_at < ?`,
  ).bind(session.eventId, now).all<{ assignment_id: string }>();
  const targets = overdue.results
    .map((row) => row.assignment_id)
    .filter((id) => requestedSet === null || requestedSet.has(id));

  const jobId = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
     VALUES (?, ?, 'remind-tasks', 'pending', ?, ?, 0, ?, ?, ?)`,
  )
    .bind(
      jobId,
      session.eventId,
      JSON.stringify({ assignment_ids: targets, requested_at: now }),
      targets.length,
      session.contactId,
      now,
      now,
    )
    .run();

  // Kick the expander now instead of leaving the job for the next cron tick:
  // the dashboard poll otherwise reads "0/N queued" for up to a minute
  // (CNT-08). One sweep call expands one chunk after the response; anything
  // beyond RECIPIENTS_PER_TICK still drains on cron, so the P2-19 request
  // budget concern is unchanged.
  try {
    c.executionCtx.waitUntil(sweepBulkJobs(c.env));
  } catch {
    await sweepBulkJobs(c.env); // environments without an execution context (tests)
  }

  return c.json({ ok: true, job_id: jobId, total: targets.length, sent: 0, skipped: 0 }, 202);
});
