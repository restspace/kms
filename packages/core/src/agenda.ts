// Agenda conflict engine (docs/07 §4). Pure functions shared by the Worker
// (authoritative, on every schedule write) and the admin SPA (live red-ghost
// feedback while dragging) — one implementation, no drift.
//
// Overlap is half-open: a.start < b.end && b.start < a.end. Sessions that
// merely touch do not conflict.

export type ConflictSeverity = 'error' | 'warning' | 'info';

export type ConflictCode =
  | 'ROOM_DOUBLE_BOOKED'
  | 'SPEAKER_DOUBLE_BOOKED'
  | 'OUTSIDE_EVENT_WINDOW'
  | 'ROOM_CAPACITY_EXCEEDED'
  | 'TRACK_OVERLAP'
  | 'SPEAKER_TRAVEL_GAP'
  | 'UNSCHEDULED_ACCEPTED'
  | 'MISSING_ROOM'
  | 'MISSING_TIME';

export interface AgendaSpeakerRef {
  contact_id: string;
  name: string;
}

export interface AgendaSessionInput {
  id: string;
  code: string;
  title: string;
  starts_at: string | null; // UTC ISO
  ends_at: string | null;
  room_id: string | null;
  track_id: string | null;
  capacity: number | null;
  speakers: AgendaSpeakerRef[];
}

export interface AgendaRoomInput {
  id: string;
  name: string;
  capacity: number | null;
}

export interface Conflict {
  code: ConflictCode;
  severity: ConflictSeverity;
  /** Plain-English description naming the records involved. */
  message: string;
  session_ids: string[];
  contact_id?: string;
  /** Stable identity for "ignore this conflict" (docs/07 §4). */
  signature: string;
}

/** Minimum comfortable gap between rooms for one speaker, in minutes. */
export const SPEAKER_TRAVEL_GAP_MIN = 10;

export const CONFLICT_SEVERITY: Record<ConflictCode, ConflictSeverity> = {
  ROOM_DOUBLE_BOOKED: 'error',
  SPEAKER_DOUBLE_BOOKED: 'error',
  OUTSIDE_EVENT_WINDOW: 'error',
  ROOM_CAPACITY_EXCEEDED: 'warning',
  TRACK_OVERLAP: 'warning',
  SPEAKER_TRAVEL_GAP: 'warning',
  UNSCHEDULED_ACCEPTED: 'info',
  MISSING_ROOM: 'info',
  MISSING_TIME: 'info',
};

export function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface Timed {
  session: AgendaSessionInput;
  start: number;
  end: number;
}

function signature(code: ConflictCode, sessionIds: string[], contactId?: string): string {
  const ids = [...sessionIds].sort().join('+');
  return contactId ? `${code}:${ids}:${contactId}` : `${code}:${ids}`;
}

function make(code: ConflictCode, message: string, sessionIds: string[], contactId?: string): Conflict {
  return {
    code,
    severity: CONFLICT_SEVERITY[code],
    message,
    session_ids: sessionIds,
    ...(contactId ? { contact_id: contactId } : {}),
    signature: signature(code, sessionIds, contactId),
  };
}

/**
 * Run all eight rules over the accepted sessions of one event.
 * Sorted-sweep over start times: each session is compared only against the
 * still-active set, so pair rules stay near-linear for realistic schedules.
 */
export function computeConflicts(
  sessions: AgendaSessionInput[],
  rooms: AgendaRoomInput[],
  eventWindow: { starts_at: string; ends_at: string },
): Conflict[] {
  const conflicts: Conflict[] = [];
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const windowStart = Date.parse(eventWindow.starts_at);
  const windowEnd = Date.parse(eventWindow.ends_at);

  const timed: Timed[] = [];
  for (const s of sessions) {
    const hasTime = s.starts_at !== null && s.ends_at !== null;
    if (!hasTime && !s.room_id) {
      conflicts.push(make('UNSCHEDULED_ACCEPTED', `“${s.title}” is accepted but has no time slot yet.`, [s.id]));
      continue;
    }
    if (!hasTime) {
      conflicts.push(make('MISSING_TIME', `“${s.title}” has a room but no time.`, [s.id]));
      continue;
    }
    if (!s.room_id) {
      conflicts.push(make('MISSING_ROOM', `“${s.title}” has a time but no room.`, [s.id]));
    }
    const start = Date.parse(s.starts_at as string);
    const end = Date.parse(s.ends_at as string);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;

    if (start < windowStart || end > windowEnd) {
      conflicts.push(make('OUTSIDE_EVENT_WINDOW', `“${s.title}” is scheduled outside the event dates.`, [s.id]));
    }
    const room = s.room_id ? roomById.get(s.room_id) : undefined;
    if (room && room.capacity !== null && s.capacity !== null && s.capacity > room.capacity) {
      conflicts.push(
        make(
          'ROOM_CAPACITY_EXCEEDED',
          `“${s.title}” expects ${s.capacity} attendees but ${room.name} holds ${room.capacity}.`,
          [s.id],
        ),
      );
    }
    timed.push({ session: s, start, end });
  }

  // Sweep in start order; prune the active set as sessions end.
  timed.sort((a, b) => a.start - b.start || a.session.id.localeCompare(b.session.id));
  const active: Timed[] = [];
  for (const cur of timed) {
    for (let i = active.length - 1; i >= 0; i--) {
      if ((active[i] as Timed).end <= cur.start) active.splice(i, 1);
    }
    for (const prev of active) {
      pairRules(prev, cur, roomById, conflicts);
    }
    active.push(cur);
  }

  // Travel gap needs *near* sessions, not overlapping ones: compare each
  // speaker's consecutive sessions after sorting per speaker.
  travelGapRule(timed, roomById, conflicts);

  return conflicts;
}

function pairRules(a: Timed, b: Timed, roomById: Map<string, AgendaRoomInput>, out: Conflict[]): void {
  if (!overlaps(a.start, a.end, b.start, b.end)) return;
  const sa = a.session;
  const sb = b.session;
  const pair = [sa.id, sb.id];
  if (sa.room_id && sa.room_id === sb.room_id) {
    const room = roomById.get(sa.room_id);
    out.push(
      make('ROOM_DOUBLE_BOOKED', `“${sa.title}” and “${sb.title}” overlap in ${room?.name ?? 'the same room'}.`, pair),
    );
  }
  const speakersB = new Map(sb.speakers.map((sp) => [sp.contact_id, sp]));
  for (const sp of sa.speakers) {
    if (speakersB.has(sp.contact_id)) {
      out.push(
        make(
          'SPEAKER_DOUBLE_BOOKED',
          `${sp.name} is on “${sa.title}” and “${sb.title}” at the same time.`,
          pair,
          sp.contact_id,
        ),
      );
    }
  }
  if (sa.track_id && sa.track_id === sb.track_id && sa.room_id !== sb.room_id) {
    out.push(
      make('TRACK_OVERLAP', `“${sa.title}” and “${sb.title}” are on the same track at the same time.`, pair),
    );
  }
}

function travelGapRule(timed: Timed[], roomById: Map<string, AgendaRoomInput>, out: Conflict[]): void {
  const bySpeaker = new Map<string, { name: string; items: Timed[] }>();
  for (const t of timed) {
    for (const sp of t.session.speakers) {
      const entry = bySpeaker.get(sp.contact_id) ?? { name: sp.name, items: [] };
      entry.items.push(t);
      bySpeaker.set(sp.contact_id, entry);
    }
  }
  const gapMs = SPEAKER_TRAVEL_GAP_MIN * 60_000;
  for (const [contactId, { name, items }] of bySpeaker) {
    items.sort((x, y) => x.start - y.start);
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1] as Timed;
      const next = items[i] as Timed;
      const gap = next.start - prev.end;
      const differentRooms =
        prev.session.room_id !== null && next.session.room_id !== null && prev.session.room_id !== next.session.room_id;
      // Overlapping pairs are already SPEAKER_DOUBLE_BOOKED errors.
      if (differentRooms && gap >= 0 && gap < gapMs) {
        const to = roomById.get(next.session.room_id as string);
        out.push(
          make(
            'SPEAKER_TRAVEL_GAP',
            `${name} has only ${Math.round(gap / 60_000)} min to reach ${to?.name ?? 'the next room'} after “${prev.session.title}”.`,
            [prev.session.id, next.session.id],
            contactId,
          ),
        );
      }
    }
  }
}
