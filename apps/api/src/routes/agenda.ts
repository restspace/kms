// Agenda & scheduling (docs/07, docs/12 M4). Mounted inside /app/api — the
// shared guard already ran (admin only; agenda is not on the reviewer surface).
//
// Only accepted submissions are schedulable (docs/06 §3). Conflicts are
// computed with the shared @kms/core engine on every read and mutation —
// authoritative here, mirrored client-side for drag feedback. Ignored-conflict
// signatures live in KV per event (docs/07 §4 "remembered per signature").

import { Hono } from 'hono';
import type { Context } from 'hono';
import { autoSchedule, computeConflicts } from '@kms/core';
import type { AgendaRoomInput, AgendaSessionInput, Conflict } from '@kms/core';
import type { Env } from '../env';
import { isWriter } from '../access';
import { stageAirtableDeletes } from '../airtableStage';
import { bumpEventRevision, entityRevisionInsert, watchedFieldsChanged } from '../revision';
import { loadAuthorName } from '../submissionComments';
import { sendScheduleEmails, type ScheduleMailKind } from '../scheduleMail';
import { nextSessionCodeSql } from '../sessionCode';
import type { SessionPayload } from '../session';

type ApiEnv = { Bindings: Env; Variables: { session: SessionPayload } };

export const agendaRoutes = new Hono<ApiEnv>();

const nowIso = () => new Date().toISOString();

interface EventRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  agenda_published: number;
}

interface SessionRow {
  id: string;
  code: string;
  title: string;
  description: string | null;
  format: string | null;
  level: string | null;
  capacity: number | null;
  track_id: string | null;
  room_id: string | null;
  starts_at: string | null;
  ends_at: string | null;
  /** Set while the auto-schedule assistant's placement is unconfirmed (AIA-08). */
  pencilled_at: string | null;
  updated_at: string;
  invited: number;
}

interface SpeakerRow {
  submission_id: string;
  contact_id: string;
  name: string | null;
  email: string;
}

export interface AgendaSession extends SessionRow {
  /** email feeds the conflict engine's duplicate-record fallback (admin-only payload). */
  speakers: Array<{ contact_id: string; name: string; email: string }>;
}

const SESSION_SELECT = `
  SELECT s.id, s.code, s.title, s.description, s.format, s.level, s.capacity,
         s.track_id, s.room_id, s.starts_at, s.ends_at, s.pencilled_at, s.updated_at,
         EXISTS (SELECT 1 FROM calendar_invites ci
                 WHERE ci.session_id = s.id AND ci.method = 'REQUEST') AS invited
  FROM submissions s
  WHERE s.event_id = ? AND s.status = 'accepted'`;

export async function loadSessions(db: D1Database, eventId: string): Promise<AgendaSession[]> {
  const [{ results: rows }, { results: speakers }] = await Promise.all([
    db.prepare(`${SESSION_SELECT} ORDER BY s.starts_at IS NULL, s.starts_at, s.code`).bind(eventId).all<SessionRow>(),
    db
      .prepare(
        `SELECT sp.submission_id, c.id AS contact_id, c.email,
                TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) AS name
         FROM submission_participants sp
         JOIN contacts c ON c.id = sp.contact_id
         JOIN submissions s ON s.id = sp.submission_id
         WHERE s.event_id = ? AND s.status = 'accepted'
         ORDER BY sp.position`,
      )
      .bind(eventId)
      .all<SpeakerRow>(),
  ]);
  const byId = new Map<string, AgendaSession>(rows.map((r) => [r.id, { ...r, speakers: [] }]));
  for (const sp of speakers) {
    byId.get(sp.submission_id)?.speakers.push({ contact_id: sp.contact_id, name: sp.name || sp.email, email: sp.email });
  }
  return [...byId.values()];
}

const ignoredKey = (eventId: string) => `agenda:ignored:${eventId}`;

export async function loadIgnored(kv: KVNamespace, eventId: string): Promise<string[]> {
  const raw = await kv.get(ignoredKey(eventId));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function toEngineInput(sessions: AgendaSession[]): AgendaSessionInput[] {
  return sessions.map((s) => ({
    id: s.id,
    code: s.code,
    title: s.title,
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    room_id: s.room_id,
    track_id: s.track_id,
    capacity: s.capacity,
    speakers: s.speakers,
  }));
}

/** Everything the agenda screen needs, conflicts pre-flagged (docs/07 §7). */
async function agendaPayload(c: Context<ApiEnv>) {
  const session = c.get('session');
  const db = c.env.DB;
  const [event, rooms, tracks, sessions, ignored] = await Promise.all([
    db
      .prepare('SELECT id, name, slug, timezone, starts_at, ends_at, location, agenda_published FROM events WHERE id = ?')
      .bind(session.eventId)
      .first<EventRow>(),
    db
      .prepare('SELECT id, name, capacity, position FROM rooms WHERE event_id = ? ORDER BY position')
      .bind(session.eventId)
      .all<AgendaRoomInput & { position: number }>()
      .then((r) => r.results),
    db
      .prepare('SELECT id, name, color, position FROM tracks WHERE event_id = ? ORDER BY position')
      .bind(session.eventId)
      .all<{ id: string; name: string; color: string | null; position: number }>()
      .then((r) => r.results),
    loadSessions(db, session.eventId),
    loadIgnored(c.env.KV, session.eventId),
  ]);
  if (!event) return null;
  const ignoredSet = new Set(ignored);
  const conflicts: Array<Conflict & { ignored: boolean }> = computeConflicts(toEngineInput(sessions), rooms, {
    starts_at: event.starts_at,
    ends_at: event.ends_at,
  }).map((conflict) => ({ ...conflict, ignored: ignoredSet.has(conflict.signature) }));
  return { event, rooms, tracks, sessions, conflicts };
}

// GET /app/api/agenda — the whole board in one payload.
agendaRoutes.get('/', async (c) => {
  const payload = await agendaPayload(c);
  if (!payload) return c.json({ error: 'not_found' }, 404);
  return c.json(payload);
});

const NOTIFY_KINDS = new Set<ScheduleMailKind>(['confirmed', 'changed', 'cancelled']);

/** Optional non-negative integer seat count; `undefined` = not supplied/invalid. */
function parseCapacity(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

function parseInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

// PUT /agenda/sessions/:id/schedule — the drop/resize/Move-dialog write.
// Body: { starts_at, ends_at, room_id, capacity?, notify?, notify_ack? } — an
// all-null time unschedules. Moving a session that has a live REQUEST calendar
// invite requires notify or notify_ack (409 invite_notify_required otherwise).
// A conflicting drop is permitted but flagged (docs/07 §3); the fresh conflict
// set rides back on the response so blocks render already marked.
agendaRoutes.put('/sessions/:id/schedule', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  const current = await db
    .prepare("SELECT id, status, starts_at, ends_at, room_id FROM submissions WHERE id = ? AND event_id = ?")
    .bind(id, session.eventId)
    .first<{ id: string; status: string; starts_at: string | null; ends_at: string | null; room_id: string | null }>();
  if (!current) return c.json({ error: 'not_found' }, 404);
  if (current.status !== 'accepted') return c.json({ error: 'not_accepted' }, 400);

  const startsAt = parseInstant(body.starts_at);
  const endsAt = parseInstant(body.ends_at);
  if (startsAt === undefined || endsAt === undefined) return c.json({ error: 'invalid_time' }, 400);
  if ((startsAt === null) !== (endsAt === null)) return c.json({ error: 'invalid_time' }, 400);
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return c.json({ error: 'invalid_time' }, 400);
  }

  let roomId: string | null = null;
  if (typeof body.room_id === 'string' && body.room_id !== '') {
    const room = await db
      .prepare('SELECT id FROM rooms WHERE id = ? AND event_id = ?')
      .bind(body.room_id, session.eventId)
      .first();
    if (!room) return c.json({ error: 'invalid_room' }, 400);
    roomId = body.room_id;
  }

  const notify = typeof body.notify === 'string' && NOTIFY_KINDS.has(body.notify as ScheduleMailKind)
    ? (body.notify as ScheduleMailKind)
    : null;

  // FR-COMM-6 / docs/07 §6: an invited session never changes silently.
  //
  // The admin SPA prompts before it sends, but that prompt keys off the
  // `invited` flag in a payload that can be stale — most sharply right after a
  // bulk send, which now only *enqueues* a job (P2-19) and answers with a
  // payload where every session still reads invited=0 while the cron expander
  // writes the calendar_invites rows minutes later. A client working from that
  // payload would move an invited session without asking anyone. The guarantee
  // therefore lives here, where the invite rows are authoritative: a real
  // schedule change to a session with a live REQUEST invite is refused unless
  // the caller decided about the email — either a `notify` kind, or
  // `notify_ack: true` meaning "the operator was asked and declined the mail".
  // A no-op write (same slot, same room) is not a change and needs neither.
  const sameInstant = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
  const scheduleChanges =
    !sameInstant(startsAt, current.starts_at) ||
    !sameInstant(endsAt, current.ends_at) ||
    roomId !== current.room_id;
  if (scheduleChanges && notify === null && body.notify_ack !== true) {
    const liveInvite = await db
      .prepare("SELECT 1 FROM calendar_invites WHERE session_id = ? AND method = 'REQUEST' LIMIT 1")
      .bind(id)
      .first();
    if (liveInvite) return c.json({ error: 'invite_notify_required', invited: 1 }, 409);
  }

  // CANCEL needs the still-current times for the ICS, so it goes out before
  // the row is cleared (docs/08: METHOD:CANCEL carries the original slot).
  let notified = 0;
  if (notify === 'cancelled') notified = await sendScheduleEmails(c, id, 'cancelled');

  // `capacity` is optional here (the Move dialog can set it inline); absent
  // means "leave as is", explicit null clears it.
  const capacity = parseCapacity(body.capacity);
  if (capacity === undefined && 'capacity' in body) return c.json({ error: 'invalid_capacity' }, 400);

  // `pencilled_at = NULL`: a manual schedule write *is* the confirmation
  // (AIA-08) — an organiser who drags or Moves an auto-placed session has
  // reviewed that slot, so the provisional flag drops and the session becomes
  // publishable like any hand-placed one.
  await db
    .prepare(
      `UPDATE submissions SET starts_at = ?1, ends_at = ?2, room_id = ?3, pencilled_at = NULL,
         capacity = CASE WHEN ?5 = 1 THEN ?6 ELSE capacity END, updated_at = ?4
       WHERE id = ?7`,
    )
    .bind(startsAt, endsAt, roomId, nowIso(), capacity === undefined ? 0 : 1, capacity ?? null, id)
    .run();
  await bumpEventRevision(c.env, session.eventId);

  if (notify === 'confirmed' || notify === 'changed') notified = await sendScheduleEmails(c, id, notify);

  const payload = await agendaPayload(c);
  return c.json({ ok: true, notified, ...payload });
});

// POST /agenda/sessions — "+ Add Session" (docs/07 §5): stored as a manual,
// already-accepted submission so there is one pipeline. Room, track and times
// are validated against *this* event before anything is written.
agendaRoutes.post('/sessions', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return c.json({ error: 'title_required' }, 400);

  const startsAt = parseInstant(body.starts_at) ?? null;
  const endsAt = parseInstant(body.ends_at) ?? null;
  if ((startsAt === null) !== (endsAt === null)) return c.json({ error: 'invalid_time' }, 400);
  if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
    return c.json({ error: 'invalid_time' }, 400);
  }

  const roomId = typeof body.room_id === 'string' && body.room_id !== '' ? body.room_id : null;
  const trackId = typeof body.track_id === 'string' && body.track_id !== '' ? body.track_id : null;
  const format = typeof body.format === 'string' && body.format !== '' ? body.format : null;
  const capacity = parseCapacity(body.capacity);
  if (capacity === undefined && 'capacity' in body) return c.json({ error: 'invalid_capacity' }, 400);

  // Tenant isolation: a foreign room/track id must never be linked in.
  if (roomId) {
    const room = await db
      .prepare('SELECT id FROM rooms WHERE id = ? AND event_id = ?')
      .bind(roomId, session.eventId)
      .first();
    if (!room) return c.json({ error: 'invalid_room' }, 400);
  }
  if (trackId) {
    const track = await db
      .prepare('SELECT id FROM tracks WHERE id = ? AND event_id = ?')
      .bind(trackId, session.eventId)
      .first();
    if (!track) return c.json({ error: 'invalid_track' }, 400);
  }

  // Same in-statement allocator the CFP pipeline uses, so manual and submitted
  // sessions share one SESS-n sequence with no read-then-write race.
  const id = crypto.randomUUID();
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO submissions (id, event_id, code, kind, title, description, status, track_id, format,
                                capacity, room_id, starts_at, ends_at, source, created_at, updated_at)
       SELECT ?1, ?2, ${nextSessionCodeSql('?2')}, 'session', ?3, ?4, 'accepted', ?5, ?6,
              ?7, ?8, ?9, ?10, 'manual', ?11, ?11`,
    )
    .bind(
      id,
      session.eventId,
      title,
      typeof body.description === 'string' ? body.description : null,
      trackId,
      format,
      capacity ?? null,
      roomId,
      startsAt,
      endsAt,
      ts,
    )
    .run();
  await bumpEventRevision(c.env, session.eventId);

  const payload = await agendaPayload(c);
  return c.json({ ok: true, id, ...payload }, 201);
});

// POST /agenda/send-confirmations — bulk invite for every scheduled session
// that has no live invite yet (docs/07 §6). Sending is a *job* (sweep item
// P2-19): the request snapshots the target sessions and returns 202; the cron
// expander does the delivery, so a large agenda cannot time out the request.
agendaRoutes.post('/send-confirmations', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.id FROM submissions s
       WHERE s.event_id = ? AND s.status = 'accepted'
         AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
         AND s.pencilled_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM calendar_invites ci
                         WHERE ci.session_id = s.id AND ci.method = 'REQUEST')`,
    )
    .bind(session.eventId)
    .all<{ id: string }>();

  const jobId = crypto.randomUUID();
  const ts = nowIso();
  await c.env.DB
    .prepare(
      `INSERT INTO bulk_jobs (id, event_id, kind, status, params_json, total, enqueued, created_by, created_at, updated_at)
       VALUES (?, ?, 'send-confirmations', 'pending', ?, ?, 0, ?, ?, ?)`,
    )
    .bind(
      jobId,
      session.eventId,
      JSON.stringify({ session_ids: results.map((r) => r.id) }),
      results.length,
      session.contactId,
      ts,
      ts,
    )
    .run();
  await bumpEventRevision(c.env, session.eventId);

  // Response keys the admin client already reads are kept; the counters are
  // now "how much the job will do", not "how much was sent inline".
  const payload = await agendaPayload(c);
  return c.json({ ok: true, job_id: jobId, sent_sessions: results.length, queued: 0, ...payload }, 202);
});

// ---------------------------------------------------------------------------
// Auto-schedule assist (AIA-08). Three routes: propose-and-write, confirm,
// and the batch write the client's Undo uses to put everything back.
//
// An auto-placement is *pencilled*: the row carries `pencilled_at`, which
// keeps it out of every public feed, out of the speaker portal and out of the
// bulk invite send until an organiser says yes. Reviewing is therefore free —
// nothing has been promised to anyone.
// ---------------------------------------------------------------------------

/** The event + rooms + sessions the assistant reasons over (agendaPayload's own queries). */
async function loadBoard(c: Context<ApiEnv>) {
  const eventId = c.get('session').eventId;
  const db = c.env.DB;
  const [event, rooms, sessions] = await Promise.all([
    db
      .prepare('SELECT id, name, slug, timezone, starts_at, ends_at, location, agenda_published FROM events WHERE id = ?')
      .bind(eventId)
      .first<EventRow>(),
    db
      .prepare('SELECT id, name, capacity, position FROM rooms WHERE event_id = ? ORDER BY position')
      .bind(eventId)
      .all<AgendaRoomInput & { position: number }>()
      .then((r) => r.results),
    loadSessions(db, eventId),
  ]);
  return { event, rooms, sessions };
}

// POST /agenda/auto-schedule — place every tray session, pencilled.
//
// FR-COMM-6 note: the write only ever touches rows with `starts_at IS NULL`,
// and send-confirmations only invites sessions that *have* a time, so a row
// this route can move can never hold a live REQUEST invite. Bypassing the
// notify guard here is therefore safe rather than an omission.
agendaRoutes.post('/auto-schedule', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const { event, rooms, sessions } = await loadBoard(c);
  if (!event) return c.json({ error: 'not_found' }, 404);

  const formatById = new Map(sessions.map((s) => [s.id, s.format]));
  const engine = toEngineInput(sessions);
  const unscheduled = engine
    .filter((s) => s.starts_at === null)
    .map((s) => ({ ...s, format: formatById.get(s.id) ?? null }));
  const scheduled = engine.filter((s) => s.starts_at !== null);

  if (unscheduled.length === 0) {
    // Nothing to do — no write, no revision bump, so a stray click cannot
    // invalidate every cached public page.
    return c.json({ ok: true, placed: 0, placements: [], skipped: [], ...(await agendaPayload(c)) });
  }

  const result = autoSchedule(
    unscheduled,
    scheduled,
    rooms,
    { starts_at: event.starts_at, ends_at: event.ends_at },
    { timezone: event.timezone },
  );

  let placed = 0;
  if (result.placements.length > 0) {
    const ts = nowIso();
    // `starts_at IS NULL` in the WHERE clause: if an organiser dragged one of
    // these sessions onto the board while the assistant was thinking, their
    // hand-placed slot wins and this row is simply skipped.
    const stmt = db.prepare(
      `UPDATE submissions SET starts_at = ?1, ends_at = ?2, room_id = ?3, pencilled_at = ?4, updated_at = ?5
       WHERE id = ?6 AND event_id = ?7 AND status = 'accepted' AND starts_at IS NULL`,
    );
    const written = await db.batch(
      result.placements.map((p) =>
        stmt.bind(p.starts_at, p.ends_at, p.room_id, ts, ts, p.id, session.eventId),
      ),
    );
    placed = written.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
    await bumpEventRevision(c.env, session.eventId);
  }

  return c.json({
    ok: true,
    placed,
    placements: result.placements,
    skipped: result.skipped,
    ...(await agendaPayload(c)),
  });
});

// POST /agenda/confirm-placements — "yes, all of that" in one click.
agendaRoutes.post('/confirm-placements', async (c) => {
  const session = c.get('session');
  const result = await c.env.DB
    .prepare(
      `UPDATE submissions SET pencilled_at = NULL, updated_at = ?
       WHERE event_id = ? AND pencilled_at IS NOT NULL AND status = 'accepted'`,
    )
    .bind(nowIso(), session.eventId)
    .run();
  const confirmed = result.meta.changes ?? 0;
  if (confirmed > 0) await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, confirmed, ...(await agendaPayload(c)) });
});

// POST /agenda/schedule-batch — many schedule writes as one call. Undo of an
// auto-place is a batch revert (put ~40 sessions back in the tray), which as
// 40 PUTs would be 40 payload round-trips and 40 revision bumps.
//
// Validation mirrors the single PUT item by item, and the FR-COMM-6 invite
// guard is *stricter* here: there is no notify/ack path, so a batch touching
// any invited session is refused whole rather than partly applied.
const SCHEDULE_BATCH_MAX = 200;

agendaRoutes.post('/schedule-batch', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : null;
  if (!items) return c.json({ error: 'invalid_items' }, 400);
  if (items.length > SCHEDULE_BATCH_MAX) return c.json({ error: 'too_many_items' }, 400);
  if (items.length === 0) return c.json({ ok: true, updated: 0, ...(await agendaPayload(c)) });

  const parsed: Array<{ id: string; starts_at: string | null; ends_at: string | null; room_id: string | null }> = [];
  for (const item of items) {
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) return c.json({ error: 'invalid_items' }, 400);
    const startsAt = parseInstant(item.starts_at ?? null);
    const endsAt = parseInstant(item.ends_at ?? null);
    if (startsAt === undefined || endsAt === undefined) return c.json({ error: 'invalid_time' }, 400);
    if ((startsAt === null) !== (endsAt === null)) return c.json({ error: 'invalid_time' }, 400);
    if (startsAt !== null && endsAt !== null && Date.parse(endsAt) <= Date.parse(startsAt)) {
      return c.json({ error: 'invalid_time' }, 400);
    }
    const roomId = typeof item.room_id === 'string' && item.room_id !== '' ? item.room_id : null;
    parsed.push({ id, starts_at: startsAt, ends_at: endsAt, room_id: roomId });
  }

  // Tenant isolation, once for the whole batch rather than per item.
  const roomIds = [...new Set(parsed.map((p) => p.room_id).filter((r): r is string => r !== null))];
  if (roomIds.length > 0) {
    const { results: rooms } = await db
      .prepare(`SELECT id FROM rooms WHERE event_id = ? AND id IN (${roomIds.map(() => '?').join(',')})`)
      .bind(session.eventId, ...roomIds)
      .all<{ id: string }>();
    if (rooms.length !== roomIds.length) return c.json({ error: 'invalid_room' }, 400);
  }

  const ids = [...new Set(parsed.map((p) => p.id))];
  const { results: known } = await db
    .prepare(
      `SELECT id FROM submissions
       WHERE event_id = ? AND status = 'accepted' AND id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(session.eventId, ...ids)
    .all<{ id: string }>();
  if (known.length !== ids.length) return c.json({ error: 'not_found' }, 404);

  const { results: invited } = await db
    .prepare(
      `SELECT DISTINCT session_id FROM calendar_invites
       WHERE method = 'REQUEST' AND session_id IN (${ids.map(() => '?').join(',')})`,
    )
    .bind(...ids)
    .all<{ session_id: string }>();
  if (invited.length > 0) {
    return c.json({ error: 'invite_notify_required', ids: invited.map((r) => r.session_id) }, 409);
  }

  const ts = nowIso();
  const stmt = db.prepare(
    `UPDATE submissions SET starts_at = ?1, ends_at = ?2, room_id = ?3, pencilled_at = NULL, updated_at = ?4
     WHERE id = ?5 AND event_id = ?6 AND status = 'accepted'`,
  );
  const written = await db.batch(
    parsed.map((p) => stmt.bind(p.starts_at, p.ends_at, p.room_id, ts, p.id, session.eventId)),
  );
  const updated = written.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  await bumpEventRevision(c.env, session.eventId);

  return c.json({ ok: true, updated, ...(await agendaPayload(c)) });
});

// POST /agenda/conflicts/ignore — toggle a signature (docs/07 §4).
agendaRoutes.post('/conflicts/ignore', async (c) => {
  const session = c.get('session');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const signatureValue = typeof body.signature === 'string' ? body.signature : '';
  if (!signatureValue) return c.json({ error: 'signature_required' }, 400);
  const ignore = body.ignored !== false;
  const list = await loadIgnored(c.env.KV, session.eventId);
  const next = ignore
    ? [...new Set([...list, signatureValue])]
    : list.filter((s) => s !== signatureValue);
  await c.env.KV.put(ignoredKey(session.eventId), JSON.stringify(next));
  const payload = await agendaPayload(c);
  return c.json({ ok: true, ...payload });
});

// ---------------------------------------------------------------------------
// Rooms & tracks — the Settings card's mutation surface, with settings history.
//
// Eval defect: adding/renaming/deleting a room or track never reached the
// "Settings history" panel, which kept claiming "the event settings are as
// first configured". History entries are content_revisions rows with
// entity_type 'settings' + entity_id = the event (Wave E, workplan 14 D8),
// which is exactly what GET /app/api/events/:id/revisions lists — so recording
// a room/track change is one entityRevisionInsert batched with the mutation,
// same discipline as the events PATCH. The snapshot is the PRE-edit rooms and
// tracks lists as readable lines; there is no PATCH surface that could write a
// room list back, so these rows are informational (the history panel offers
// Restore only on rows that carry restorable event fields).
//
// The routes live here rather than next to the original rooms/tracks CRUD in
// adminApi.ts so the history hook ships with the agenda/settings surface; the
// admin SPA's Settings card now calls these. The legacy /app/api/rooms and
// /app/api/tracks mutations remain for external callers and record the same
// settings-history rows via their own mirror in adminApi.ts.
// ---------------------------------------------------------------------------

const ROOM_TRACK_NAME_MAX_CHARS = 200;

interface NamedFields {
  values: Record<string, string | number | null>;
  error?: string;
}

/** Mirrors adminApi.ts pickRoomFields — name required on create only. */
function pickRoomFields(raw: unknown, { requireName }: { requireName: boolean }): NamedFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): NamedFields => ({ values: {}, error });

  if (requireName || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('name_required');
    values.name = name.slice(0, ROOM_TRACK_NAME_MAX_CHARS);
  }
  if ('capacity' in body) {
    const capacity = parseCapacity(body.capacity);
    if (capacity === undefined) return fail('invalid_capacity');
    values.capacity = capacity;
  }
  if ('notes' in body) {
    const v = body.notes;
    if (v === null || v === '') values.notes = null;
    else if (typeof v === 'string') values.notes = v.trim().slice(0, 2000);
    else return fail('invalid_notes');
  }
  return { values };
}

/** Mirrors adminApi.ts pickTrackFields. */
function pickTrackFields(raw: unknown, { requireName }: { requireName: boolean }): NamedFields {
  const body = (raw ?? {}) as Record<string, unknown>;
  const values: Record<string, string | number | null> = {};
  const fail = (error: string): NamedFields => ({ values: {}, error });

  if (requireName || 'name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return fail('name_required');
    values.name = name.slice(0, ROOM_TRACK_NAME_MAX_CHARS);
  }
  if ('color' in body) {
    const v = body.color;
    if (v === null || v === '') values.color = null;
    else if (typeof v === 'string') values.color = v.trim().slice(0, 20);
    else return fail('invalid_color');
  }
  return { values };
}

const roomRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare('SELECT id, event_id, name, capacity, position, notes FROM rooms WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first<{ id: string; event_id: string; name: string; capacity: number | null; position: number; notes: string | null }>();

const trackRow = (db: D1Database, id: string, eventId: string) =>
  db.prepare('SELECT id, event_id, name, color, position FROM tracks WHERE id = ? AND event_id = ?')
    .bind(id, eventId)
    .first<{ id: string; event_id: string; name: string; color: string | null; position: number }>();

/**
 * The PRE-edit rooms/tracks snapshot as one settings-history INSERT, ready to
 * batch with the mutation it precedes. Lists render one item per line —
 * "Main Hall (capacity 120)" / "AI (green)" — because the history panel shows
 * snapshots as text, not structured rows; an empty list snapshots as null so
 * it displays "(empty)" like any cleared field.
 */
async function roomsTracksRevision(c: Context<ApiEnv>, editedAt: string): Promise<D1PreparedStatement> {
  const session = c.get('session');
  const db = c.env.DB;
  const [rooms, tracks, editedByName] = await Promise.all([
    db.prepare('SELECT name, capacity FROM rooms WHERE event_id = ? ORDER BY position')
      .bind(session.eventId)
      .all<{ name: string; capacity: number | null }>()
      .then((r) => r.results),
    db.prepare('SELECT name, color FROM tracks WHERE event_id = ? ORDER BY position')
      .bind(session.eventId)
      .all<{ name: string; color: string | null }>()
      .then((r) => r.results),
    loadAuthorName(db, session.contactId),
  ]);
  const roomLines = rooms
    .map((r) => (r.capacity !== null ? `${r.name} (capacity ${r.capacity})` : r.name))
    .join('\n');
  const trackLines = tracks.map((t) => (t.color ? `${t.name} (${t.color})` : t.name)).join('\n');
  return entityRevisionInsert(db, {
    eventId: session.eventId,
    entityType: 'settings',
    entityId: session.eventId,
    payload: { rooms: roomLines || null, tracks: trackLines || null },
    editedBy: session.contactId,
    editedByName,
    source: 'admin',
    editedAt,
  });
}

// POST /agenda/rooms — create, with the pre-add list snapshotted.
agendaRoutes.post('/rooms', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickRoomFields(await c.req.json().catch(() => ({})), { requireName: true });
  if (error) return c.json({ error }, 400);

  const db = c.env.DB;
  const id = crypto.randomUUID();
  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare(
      `INSERT INTO rooms (id, event_id, name, capacity, notes, position, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, COALESCE((SELECT MAX(position) + 1 FROM rooms WHERE event_id = ?2), 0), ?6`,
    ).bind(id, session.eventId, values.name, values.capacity ?? null, values.notes ?? null, ts),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await roomRow(db, id, session.eventId), 201);
});

// PUT /agenda/rooms/:id — rename / capacity / notes. The Settings card writes
// on blur, so an unchanged write is a no-op: no UPDATE, no history row.
agendaRoutes.put('/rooms/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickRoomFields(await c.req.json().catch(() => ({})), { requireName: false });
  if (error) return c.json({ error }, 400);

  const db = c.env.DB;
  const before = await roomRow(db, id, session.eventId);
  if (!before) return c.json({ error: 'not_found' }, 404);

  const cols = Object.keys(values);
  if (cols.length === 0 || !watchedFieldsChanged(before, values, cols)) return c.json(before);

  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare(
      `UPDATE rooms SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    ).bind(...cols.map((k) => values[k]), ts, id, session.eventId),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await roomRow(db, id, session.eventId));
});

// GET /agenda/rooms/:id/usage — what a delete would touch, for the confirm
// dialog: how many accepted sessions are scheduled in this room right now.
agendaRoutes.get('/rooms/:id/usage', async (c) => {
  const session = c.get('session');
  const id = c.req.param('id');
  const room = await roomRow(c.env.DB, id, session.eventId);
  if (!room) return c.json({ error: 'not_found' }, 404);
  const counts = await c.env.DB
    .prepare(
      `SELECT COUNT(*) AS session_count,
              SUM(CASE WHEN starts_at IS NOT NULL AND status = 'accepted' THEN 1 ELSE 0 END) AS scheduled_count
       FROM submissions WHERE room_id = ? AND event_id = ?`,
    )
    .bind(id, session.eventId)
    .first<{ session_count: number; scheduled_count: number | null }>();
  return c.json({
    session_count: counts?.session_count ?? 0,
    scheduled_count: counts?.scheduled_count ?? 0,
  });
});

// DELETE /agenda/rooms/:id — same null-the-reference semantics as the legacy
// route, plus history and an undo payload: the deleted row and every session
// id that lost its room ride back so the client's Undo toast can restore both.
agendaRoutes.delete('/rooms/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const db = c.env.DB;
  const room = await roomRow(db, id, session.eventId);
  if (!room) return c.json({ error: 'not_found' }, 404);
  const { results: detached } = await db
    .prepare('SELECT id FROM submissions WHERE room_id = ? AND event_id = ?')
    .bind(id, session.eventId)
    .all<{ id: string }>();

  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare('UPDATE submissions SET room_id = NULL, updated_at = ? WHERE room_id = ? AND event_id = ?')
      .bind(ts, id, session.eventId),
    stageAirtableDeletes(db, 'rooms', 'id = ? AND event_id = ?', id, session.eventId),
    db.prepare('DELETE FROM rooms WHERE id = ? AND event_id = ?').bind(id, session.eventId),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, room, detached_session_ids: detached.map((r) => r.id) });
});

// POST /agenda/rooms/:id/restore — the Undo half of the delete above: put the
// room back under its original id and re-point the sessions that lost it.
// `room_id IS NULL` in the session UPDATE keeps a session an operator already
// re-homed during the undo window where they put it.
agendaRoutes.post('/rooms/:id/restore', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { values, error } = pickRoomFields(body, { requireName: true });
  if (error) return c.json({ error }, 400);
  const position = Number.isInteger(body.position) && (body.position as number) >= 0 ? (body.position as number) : 0;
  const sessionIds = Array.isArray(body.session_ids)
    ? (body.session_ids as unknown[]).filter((v): v is string => typeof v === 'string').slice(0, 500)
    : [];

  const db = c.env.DB;
  const ts = nowIso();
  // INSERT OR IGNORE + read-back: a double-fired undo finds the room already
  // restored; an id colliding with another event's room never re-points a
  // session (the read-back is event-scoped and 409s instead).
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare(
      'INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, notes, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(id, session.eventId, values.name, values.capacity ?? null, values.notes ?? null, position, ts),
  ]);
  const room = await roomRow(db, id, session.eventId);
  if (!room) return c.json({ error: 'conflict' }, 409);
  let restoredSessions = 0;
  if (sessionIds.length > 0) {
    const result = await db
      .prepare(
        `UPDATE submissions SET room_id = ?, updated_at = ?
         WHERE id IN (${sessionIds.map(() => '?').join(',')}) AND event_id = ? AND room_id IS NULL`,
      )
      .bind(id, ts, ...sessionIds, session.eventId)
      .run();
    restoredSessions = result.meta.changes ?? 0;
  }
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true, room, restored_sessions: restoredSessions });
});

// POST /agenda/tracks — create, with history.
agendaRoutes.post('/tracks', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const { values, error } = pickTrackFields(await c.req.json().catch(() => ({})), { requireName: true });
  if (error) return c.json({ error }, 400);

  const db = c.env.DB;
  const id = crypto.randomUUID();
  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare(
      `INSERT INTO tracks (id, event_id, name, color, position, updated_at)
       SELECT ?1, ?2, ?3, ?4, COALESCE((SELECT MAX(position) + 1 FROM tracks WHERE event_id = ?2), 0), ?5`,
    ).bind(id, session.eventId, values.name, values.color ?? null, ts),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await trackRow(db, id, session.eventId), 201);
});

// PUT /agenda/tracks/:id — rename / recolor, no-op writes skipped like rooms.
agendaRoutes.put('/tracks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const { values, error } = pickTrackFields(await c.req.json().catch(() => ({})), { requireName: false });
  if (error) return c.json({ error }, 400);

  const db = c.env.DB;
  const before = await trackRow(db, id, session.eventId);
  if (!before) return c.json({ error: 'not_found' }, 404);

  const cols = Object.keys(values);
  if (cols.length === 0 || !watchedFieldsChanged(before, values, cols)) return c.json(before);

  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare(
      `UPDATE tracks SET ${cols.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND event_id = ?`,
    ).bind(...cols.map((k) => values[k]), ts, id, session.eventId),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json(await trackRow(db, id, session.eventId));
});

// DELETE /agenda/tracks/:id — legacy semantics (null the reference, clean the
// submission_tracks junction) plus the history row.
agendaRoutes.delete('/tracks/:id', async (c) => {
  const session = c.get('session');
  if (!isWriter(session.role)) return c.json({ error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const db = c.env.DB;
  const track = await trackRow(db, id, session.eventId);
  if (!track) return c.json({ error: 'not_found' }, 404);

  const ts = nowIso();
  await db.batch([
    await roomsTracksRevision(c, ts),
    db.prepare('UPDATE submissions SET track_id = NULL, updated_at = ? WHERE track_id = ? AND event_id = ?')
      .bind(ts, id, session.eventId),
    db.prepare(
      `DELETE FROM submission_tracks WHERE track_id = ?
       AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
    ).bind(id, session.eventId),
    stageAirtableDeletes(db, 'tracks', 'id = ? AND event_id = ?', id, session.eventId),
    db.prepare('DELETE FROM tracks WHERE id = ? AND event_id = ?').bind(id, session.eventId),
  ]);
  await bumpEventRevision(c.env, session.eventId);
  return c.json({ ok: true });
});

// DELETE /agenda/sessions/:id/speakers/:contactId — the "Remove speaker"
// resolve action on speaker conflicts.
agendaRoutes.delete('/sessions/:id/speakers/:contactId', async (c) => {
  const session = c.get('session');
  const result = await c.env.DB
    .prepare(
      `DELETE FROM submission_participants
       WHERE submission_id = ? AND contact_id = ?
         AND submission_id IN (SELECT id FROM submissions WHERE event_id = ?)`,
    )
    .bind(c.req.param('id'), c.req.param('contactId'), session.eventId)
    .run();
  if (result.meta.changes === 0) return c.json({ error: 'not_found' }, 404);
  await bumpEventRevision(c.env, session.eventId);
  const payload = await agendaPayload(c);
  return c.json({ ok: true, ...payload });
});
