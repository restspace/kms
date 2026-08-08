// Agenda & scheduling (docs/07, docs/12 M4). Mounted inside /app/api — the
// shared guard already ran (admin only; agenda is not on the reviewer surface).
//
// Only accepted submissions are schedulable (docs/06 §3). Conflicts are
// computed with the shared @kms/core engine on every read and mutation —
// authoritative here, mirrored client-side for drag feedback. Ignored-conflict
// signatures live in KV per event (docs/07 §4 "remembered per signature").

import { Hono } from 'hono';
import type { Context } from 'hono';
import { computeConflicts } from '@kms/core';
import type { AgendaRoomInput, AgendaSessionInput, Conflict } from '@kms/core';
import type { Env } from '../env';
import { sendScheduleEmails, type ScheduleMailKind } from '../scheduleMail';
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
  speakers: Array<{ contact_id: string; name: string }>;
}

const SESSION_SELECT = `
  SELECT s.id, s.code, s.title, s.description, s.format, s.level, s.capacity,
         s.track_id, s.room_id, s.starts_at, s.ends_at, s.updated_at,
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
    byId.get(sp.submission_id)?.speakers.push({ contact_id: sp.contact_id, name: sp.name || sp.email });
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

function parseInstant(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

// PUT /agenda/sessions/:id/schedule — the drop/resize/Move-dialog write.
// Body: { starts_at, ends_at, room_id, notify? } — all-null time unschedules.
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

  // CANCEL needs the still-current times for the ICS, so it goes out before
  // the row is cleared (docs/08: METHOD:CANCEL carries the original slot).
  let notified = 0;
  if (notify === 'cancelled') notified = await sendScheduleEmails(c, id, 'cancelled');

  await db
    .prepare('UPDATE submissions SET starts_at = ?, ends_at = ?, room_id = ?, updated_at = ? WHERE id = ?')
    .bind(startsAt, endsAt, roomId, nowIso(), id)
    .run();

  if (notify === 'confirmed' || notify === 'changed') notified = await sendScheduleEmails(c, id, notify);

  const payload = await agendaPayload(c);
  return c.json({ ok: true, notified, ...payload });
});

// POST /agenda/sessions — "+ Add Session" (docs/07 §5): stored as a manual,
// already-accepted submission so there is one pipeline.
agendaRoutes.post('/sessions', async (c) => {
  const session = c.get('session');
  const db = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) return c.json({ error: 'title_required' }, 400);

  const startsAt = parseInstant(body.starts_at) ?? null;
  const endsAt = parseInstant(body.ends_at) ?? null;
  if ((startsAt === null) !== (endsAt === null)) return c.json({ error: 'invalid_time' }, 400);
  const roomId = typeof body.room_id === 'string' && body.room_id !== '' ? body.room_id : null;
  const trackId = typeof body.track_id === 'string' && body.track_id !== '' ? body.track_id : null;
  const format = typeof body.format === 'string' && body.format !== '' ? body.format : null;

  // Next SESS-n from the highest existing numeric suffix.
  const { results: codes } = await db
    .prepare("SELECT code FROM submissions WHERE event_id = ?")
    .bind(session.eventId)
    .all<{ code: string }>();
  let max = 0;
  for (const { code } of codes) {
    const n = Number(/^SESS-(\d+)$/.exec(code)?.[1] ?? 0);
    if (n > max) max = n;
  }

  const id = crypto.randomUUID();
  const ts = nowIso();
  await db
    .prepare(
      `INSERT INTO submissions (id, event_id, code, kind, title, description, status, track_id, format,
                                room_id, starts_at, ends_at, source, created_at, updated_at)
       VALUES (?, ?, ?, 'session', ?, ?, 'accepted', ?, ?, ?, ?, ?, 'manual', ?, ?)`,
    )
    .bind(
      id,
      session.eventId,
      `SESS-${max + 1}`,
      title,
      typeof body.description === 'string' ? body.description : null,
      trackId,
      format,
      roomId,
      startsAt,
      endsAt,
      ts,
      ts,
    )
    .run();

  const payload = await agendaPayload(c);
  return c.json({ ok: true, id, ...payload }, 201);
});

// POST /agenda/send-confirmations — bulk invite for every scheduled session
// that has no live invite yet (docs/07 §6).
agendaRoutes.post('/send-confirmations', async (c) => {
  const session = c.get('session');
  const { results } = await c.env.DB
    .prepare(
      `SELECT s.id FROM submissions s
       WHERE s.event_id = ? AND s.status = 'accepted'
         AND s.starts_at IS NOT NULL AND s.ends_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM calendar_invites ci
                         WHERE ci.session_id = s.id AND ci.method = 'REQUEST')`,
    )
    .bind(session.eventId)
    .all<{ id: string }>();
  let queued = 0;
  for (const { id } of results) {
    queued += await sendScheduleEmails(c, id, 'confirmed');
  }
  const payload = await agendaPayload(c);
  return c.json({ ok: true, sent_sessions: results.length, queued, ...payload });
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
  const payload = await agendaPayload(c);
  return c.json({ ok: true, ...payload });
});
