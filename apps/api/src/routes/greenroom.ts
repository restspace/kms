// Green room / run-of-show (workplan 12, docs/15 §2 move 6). The day-of
// screen: who is on now/next in each room, has the speaker arrived, are their
// slides in, and how to reach them. Mounted inside /app/api — the shared
// guard already ran (admin only).
//
// One GET returns the WHOLE event's scheduled sessions, not a day window: the
// client derives "today" and now/next from the device clock, so the payload
// only changes when data changes and the revision ETag stays honest — time
// advancing never invalidates a 304. Writes return the whole refreshed
// payload (the agenda.ts convention) plus the new ETag, so the client swaps
// payload and etag atomically without an extra poll.

import { Hono } from 'hono';
import type { Context } from 'hono';
import { eventLocalDay } from '@kms/core';
import type { AccessEnv } from '../access';
import { sendTemplated } from '../mailer';
import { bumpEventRevision, getEventRevision } from '../revision';
import { speakerTracking, type SpeakerAggRow } from './dashboard';

type ApiEnv = AccessEnv;

/** Payload cache lifetime; the revision key makes staleness impossible, this
 * is only the backstop for a bump that never landed (KV write failure). */
const GREENROOM_CACHE_TTL_SECONDS = 600;

export const greenroomRoutes = new Hono<ApiEnv>();

interface EventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
}

interface GreenRoomSessionRow {
  id: string;
  code: string;
  title: string;
  format: string | null;
  track_name: string | null;
  room_id: string;
  starts_at: string;
  ends_at: string | null;
}

interface SessionSpeakerRow {
  submission_id: string;
  contact_id: string;
}

const fullName = (name: string | null, email: string): string => name || email;

async function greenroomPayload(c: Context<ApiEnv>) {
  const db = c.env.DB;
  const eventId = c.get('session').eventId;
  const now = new Date().toISOString();

  const [event, rooms, sessionRows, speakerRows, tracking] = await Promise.all([
    db
      .prepare('SELECT id, name, slug, timezone, starts_at, ends_at FROM events WHERE id = ?')
      .bind(eventId)
      .first<EventRow>(),
    db
      .prepare('SELECT id, name FROM rooms WHERE event_id = ? ORDER BY position')
      .bind(eventId)
      .all<{ id: string; name: string }>()
      .then((r) => r.results),
    // Only scheduled sessions — the green room is about the run of show, and
    // idx_submissions_schedule (event_id, room_id, starts_at) carries this.
    db
      .prepare(
        `SELECT s.id, s.code, s.title, s.format, t.name AS track_name,
                s.room_id, s.starts_at, s.ends_at
         FROM submissions s
         LEFT JOIN tracks t ON t.id = s.track_id
         WHERE s.event_id = ? AND s.status = 'accepted'
           AND s.starts_at IS NOT NULL AND s.room_id IS NOT NULL
         ORDER BY s.starts_at, s.code`,
      )
      .bind(eventId)
      .all<GreenRoomSessionRow>()
      .then((r) => r.results),
    db
      .prepare(
        `SELECT sp.submission_id, sp.contact_id
         FROM submission_participants sp
         JOIN submissions s ON s.id = sp.submission_id
         WHERE s.event_id = ? AND s.status = 'accepted'
           AND s.starts_at IS NOT NULL AND s.room_id IS NOT NULL
         ORDER BY sp.position`,
      )
      .bind(eventId)
      .all<SessionSpeakerRow>()
      .then((r) => r.results),
    speakerTracking(db, eventId, now),
  ]);
  if (!event) return null;

  const speakerIds = new Map<string, string[]>();
  for (const sp of speakerRows) {
    const list = speakerIds.get(sp.submission_id);
    if (list) list.push(sp.contact_id);
    else speakerIds.set(sp.submission_id, [sp.contact_id]);
  }

  // speakerTracking covers accepted speakers with an event_contacts row; a
  // participant missing from the roster still renders (readiness unknown,
  // check-in refused with "not on the event roster") rather than vanishing.
  const tracked = new Map<string, SpeakerAggRow>(tracking.map((row) => [row.contact_id, row]));
  const referenced = new Set(speakerRows.map((sp) => sp.contact_id));
  const untracked = [...referenced].filter((id) => !tracked.has(id));
  const fallback =
    untracked.length > 0
      ? await db
          .prepare(
            `SELECT c.id AS contact_id,
                    NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS name,
                    c.email, c.mobile_phone
             FROM contacts c WHERE c.id IN (${untracked.map(() => '?').join(', ')})`,
          )
          .bind(...untracked)
          .all<{ contact_id: string; name: string | null; email: string; mobile_phone: string | null }>()
          .then((r) => r.results)
      : [];

  const speakers: Record<
    string,
    {
      name: string;
      email: string;
      mobile_phone: string | null;
      arrived_at: string | null;
      on_roster: boolean;
      missing_bio: number;
      missing_headshot: number;
      missing_slides: number;
      outstanding: number;
    }
  > = {};
  for (const id of referenced) {
    const row = tracked.get(id);
    if (row) {
      speakers[id] = {
        name: fullName(row.name, row.email),
        email: row.email,
        mobile_phone: row.mobile_phone,
        arrived_at: row.arrived_at,
        on_roster: true,
        missing_bio: row.missing_bio,
        missing_headshot: row.missing_headshot,
        missing_slides: row.missing_slides > 0 ? 1 : 0,
        outstanding: row.outstanding,
      };
    }
  }
  for (const row of fallback) {
    speakers[row.contact_id] = {
      name: fullName(row.name, row.email),
      email: row.email,
      mobile_phone: row.mobile_phone,
      arrived_at: null,
      on_roster: false,
      missing_bio: 0,
      missing_headshot: 0,
      missing_slides: 0,
      outstanding: 0,
    };
  }

  return {
    now,
    event,
    rooms,
    sessions: sessionRows.map((s) => ({ ...s, speaker_ids: speakerIds.get(s.id) ?? [] })),
    speakers,
  };
}

const cacheKeyFor = (eventId: string, revision: string) => `greenroom:${eventId}:${revision}`;

// GET /app/api/greenroom — the whole run of show. Same revision-first caching
// as the dashboard (dashboard.ts): an idle poll costs one KV read and zero D1
// queries; a genuine change pays for the query block once per revision.
greenroomRoutes.get('/', async (c) => {
  const eventId = c.get('session').eventId;
  const revision = await getEventRevision(c.env, eventId);
  const etag = `"r${revision}"`;
  c.header('ETag', etag);
  c.header('Cache-Control', 'no-cache');
  if (c.req.header('if-none-match') === etag) return c.body(null, 304);

  const cacheKey = cacheKeyFor(eventId, revision);
  const cached = await c.env.KV.get<Record<string, unknown>>(cacheKey, 'json').catch(() => null);
  // `now` is the only field that must not come out of a cache — everything
  // else is a snapshot of the revision this key names.
  if (cached) return c.json({ ...cached, now: new Date().toISOString() });

  const payload = await greenroomPayload(c);
  if (!payload) return c.json({ error: 'not_found' }, 404);
  await c.env.KV.put(cacheKey, JSON.stringify(payload), { expirationTtl: GREENROOM_CACHE_TTL_SECONDS })
    .catch(() => {});
  return c.json(payload);
});

// POST /app/api/greenroom/checkin { contact_id, arrived } — mark a speaker
// arrived on-site (or undo it). The event_id predicate is the tenancy guard:
// zero changes means "not on this event's roster", surfaced as 404.
greenroomRoutes.post('/checkin', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as { contact_id?: unknown; arrived?: unknown };
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (contactId === '') return c.json({ error: 'contact_id_required' }, 400);
  const arrived = body.arrived !== false;

  const result = await db
    .prepare('UPDATE event_contacts SET arrived_at = ?, arrival_marked_by = ? WHERE event_id = ? AND contact_id = ?')
    .bind(
      arrived ? new Date().toISOString() : null,
      arrived ? session.contactId : null,
      session.eventId,
      contactId,
    )
    .run();
  if ((result.meta.changes ?? 0) === 0) return c.json({ error: 'not_found' }, 404);

  await bumpEventRevision(c.env, session.eventId);
  const revision = await getEventRevision(c.env, session.eventId);
  const payload = await greenroomPayload(c);
  if (!payload) return c.json({ error: 'not_found' }, 404);
  await c.env.KV.put(cacheKeyFor(session.eventId, revision), JSON.stringify(payload), {
    expirationTtl: GREENROOM_CACHE_TTL_SECONDS,
  }).catch(() => {});
  return c.json({ ok: true, etag: `"r${revision}"`, ...payload });
});

// POST /app/api/greenroom/nudge { contact_id } — one-tap reminder to a single
// speaker about their incomplete tasks. Inline send (one recipient — no bulk
// job), through the same task_reminder template and day-keyed idempotency as
// the dashboard's remind-all, so a green-room double-tap and a same-day
// dashboard sweep dedupe against each other in message_log.
greenroomRoutes.post('/nudge', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as { contact_id?: unknown };
  const contactId = typeof body.contact_id === 'string' ? body.contact_id : '';
  if (contactId === '') return c.json({ error: 'contact_id_required' }, 400);

  const event = await db
    .prepare('SELECT id, name, slug, timezone FROM events WHERE id = ?')
    .bind(session.eventId)
    .first<{ id: string; name: string; slug: string; timezone: string }>();
  if (!event) return c.json({ error: 'not_found' }, 404);

  // Roster guard first, so a foreign contact_id reads as absent rather than
  // leaking whether it has tasks anywhere.
  const contact = await db
    .prepare(
      `SELECT c.id, c.email, c.first_name FROM contacts c
       JOIN event_contacts ec ON ec.contact_id = c.id AND ec.event_id = ?
       WHERE c.id = ?`,
    )
    .bind(session.eventId, contactId)
    .first<{ id: string; email: string | null; first_name: string | null }>();
  if (!contact) return c.json({ error: 'not_found' }, 404);
  if (!contact.email || contact.email.trim() === '') return c.json({ error: 'no_email' }, 400);

  // Unlike the dashboard's remind-all this is not limited to overdue: the
  // green-room ask is "their slides aren't in", which is urgent on the day
  // regardless of due_at. file_upload assignments first, then earliest due.
  const { results: assignments } = await db
    .prepare(
      `SELECT ta.id AS assignment_id, t.title AS task_title, t.due_at, t.action_type
       FROM task_assignments ta
       JOIN tasks t ON t.id = ta.task_id
       WHERE t.event_id = ? AND ta.contact_id = ? AND ta.status != 'complete'
       ORDER BY (t.action_type != 'file_upload'), t.due_at IS NULL, t.due_at
       LIMIT 3`,
    )
    .bind(session.eventId, contactId)
    .all<{ assignment_id: string; task_title: string; due_at: string | null; action_type: string }>();
  if (assignments.length === 0) return c.json({ error: 'nothing_to_nudge' }, 400);

  const now = new Date().toISOString();
  // Event-local day, not UTC: a UTC day rolls over mid-afternoon for US
  // events and would hand a second tap a fresh idempotency key (bulkJobs.ts).
  const day = eventLocalDay(now, event.timezone);

  let sent = 0;
  let duplicates = 0;
  for (const assignment of assignments) {
    const outcome = await sendTemplated(c, {
      templateKey: 'task_reminder',
      eventId: session.eventId,
      contactId,
      toEmail: contact.email,
      entityId: assignment.assignment_id,
      version: `manual-${day}`,
      context: {
        event: { name: event.name },
        speaker: { first_name: contact.first_name ?? 'there' },
        task: {
          title: assignment.task_title,
          due_line: assignment.due_at && assignment.due_at < now ? ' — now overdue' : '',
          url: `${c.env.APP_URL}/portal/${event.slug}/tasks`,
        },
      },
    });
    if (outcome === 'template_disabled') return c.json({ error: 'template_disabled' }, 409);
    if (outcome === 'queued') sent += 1;
    if (outcome === 'duplicate') duplicates += 1;
  }
  // No revision bump: sending mail changes no green-room data.
  return c.json({ ok: true, sent, duplicates });
});
