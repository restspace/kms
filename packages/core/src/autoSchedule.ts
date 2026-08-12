// Auto-schedule assist (AIA-08). Given the sessions still in the tray, the
// sessions already on the board and the rooms, propose a slot for every tray
// session that does not create a *hard* conflict.
//
// The assistant never invents its own idea of "legal": feasibility is exactly
// "the shared conflict engine reports no error-severity conflict for this
// session in this slot" (agenda.ts), so a placement the assistant makes can
// never be one the board would paint red. Warnings are not refused — they are
// priced into the score, so a slightly awkward placement is preferred over
// leaving a session unplaced, but a comfortable one wins when both exist.
//
// Everything here is pure and deterministic: the same inputs (in any order)
// produce byte-identical placements, which is what makes the result safe to
// preview, undo, and test as a property.

import {
  buildConflictIndexes,
  computeConflictsForSession,
  SPEAKER_TRAVEL_GAP_MIN,
  type AgendaRoomInput,
  type AgendaSessionInput,
  type Timed,
} from './agenda';
import {
  AGENDA_DAY_END_MIN,
  AGENDA_DAY_START_MIN,
  AGENDA_SLOT_STEP_MIN,
  eventDays,
  formatMinutes,
  localToUtc,
  utcToLocal,
} from './agendaTime';

/** A tray session plus the `format` string its default duration comes from. */
export interface AutoScheduleSessionInput extends AgendaSessionInput {
  format: string | null;
}

export interface AutoSchedulePlacement {
  id: string;
  starts_at: string;
  ends_at: string;
  room_id: string;
}

export type AutoScheduleSkipReason = 'no_rooms' | 'no_days' | 'no_feasible_slot';

export interface AutoScheduleResult {
  placements: AutoSchedulePlacement[];
  skipped: Array<{ id: string; reason: AutoScheduleSkipReason }>;
}

/** Fallback block length when the format says nothing (docs/07 §3). */
const DEFAULT_DURATION_MIN = 30;

/**
 * How the assistant trades off the things a human scheduler trades off.
 * Exported so the tests can reason about *why* a slot won rather than
 * hard-coding the numbers a second time.
 */
export const AUTO_SCHEDULE_WEIGHTS = {
  /** A room that fits the expected audience, minus a nudge per empty seat. */
  capacityFit: 30,
  capacitySlackPerSeat: 0.05,
  /** Same track already in this room today — keeps a track in one place. */
  trackCluster: 25,
  /**
   * Warnings the conflict engine would raise, priced rather than refused.
   * Undersized rooms are handled here, not in `capacityFit`, so the penalty
   * is not counted twice.
   */
  warning: {
    ROOM_CAPACITY_EXCEEDED: -40,
    SPEAKER_TRAVEL_GAP: -30,
    TRACK_OVERLAP: -20,
    SPEAKER_LIKELY_DOUBLE_BOOKED: -60,
  } as Record<string, number>,
  /**
   * Per speaker who would end up with a back-to-back in the *same* room. The
   * engine's travel rule only fires across rooms (agenda.ts travelPair), so
   * without this the assistant happily stacks one speaker's whole day with no
   * breathing room at all.
   */
  backToBackSameRoom: -10,
  /** Tie-breaker with a direction: fill the event from the front. */
  earlierBiasPerMinute: -0.001,
};

interface Candidate {
  room: AgendaRoomInput;
  day: string;
  startMin: number;
  starts_at: string;
  ends_at: string;
  start: number;
  end: number;
}

/** Every (room, day, slot) the session could legally occupy, before conflicts. */
function candidatesFor(
  session: AutoScheduleSessionInput,
  durationMin: number,
  rooms: AgendaRoomInput[],
  days: string[],
  tz: string,
  dayStartMin: number,
  dayEndMin: number,
  stepMin: number,
): Candidate[] {
  // A room preset in the tray is an organiser instruction, not a hint.
  const usable = session.room_id ? rooms.filter((r) => r.id === session.room_id) : rooms;
  const out: Candidate[] = [];
  for (let roomIndex = 0; roomIndex < usable.length; roomIndex++) {
    const room = usable[roomIndex] as AgendaRoomInput;
    for (const day of days) {
      for (let t = dayStartMin; t + durationMin <= dayEndMin; t += stepMin) {
        const starts_at = localToUtc(day, t, tz);
        const ends_at = localToUtc(day, t + durationMin, tz);
        out.push({
          room,
          day,
          startMin: t,
          starts_at,
          ends_at,
          start: Date.parse(starts_at),
          end: Date.parse(ends_at),
        });
      }
    }
  }
  return out;
}

function tentativeOf(session: AutoScheduleSessionInput, c: Candidate): AgendaSessionInput {
  return { ...session, starts_at: c.starts_at, ends_at: c.ends_at, room_id: c.room.id };
}

/** Same track, same room, same local day — the clustering signal. */
function clusters(list: Timed[] | undefined, trackId: string, day: string, tz: string): boolean {
  if (!list) return false;
  for (const t of list) {
    if (t.session.track_id !== trackId) continue;
    if (t.session.starts_at && utcToLocal(t.session.starts_at, tz).day === day) return true;
  }
  return false;
}

/**
 * Speakers of `session` who would have another session in the *same* room
 * within the travel gap. Same-room adjacency is invisible to the engine (its
 * travel rule needs two different rooms), so it is counted here.
 */
function backToBackSpeakers(
  session: AutoScheduleSessionInput,
  c: Candidate,
  bySpeaker: Map<string, Timed[]>,
): number {
  const gapMs = SPEAKER_TRAVEL_GAP_MIN * 60_000;
  let n = 0;
  const seen = new Set<string>();
  for (const sp of session.speakers) {
    if (seen.has(sp.contact_id)) continue;
    seen.add(sp.contact_id);
    const list = bySpeaker.get(sp.contact_id);
    if (!list) continue;
    for (const t of list) {
      if (t.session.id === session.id || t.session.room_id !== c.room.id) continue;
      const gap = t.start >= c.end ? t.start - c.end : c.start - t.end;
      if (gap >= 0 && gap < gapMs) {
        n++;
        break;
      }
    }
  }
  return n;
}

export function autoSchedule(
  unscheduled: AutoScheduleSessionInput[],
  scheduled: AgendaSessionInput[],
  rooms: AgendaRoomInput[],
  eventWindow: { starts_at: string; ends_at: string },
  opts: { timezone: string; dayStartMin?: number; dayEndMin?: number; stepMin?: number },
): AutoScheduleResult {
  const tz = opts.timezone;
  const dayStartMin = opts.dayStartMin ?? AGENDA_DAY_START_MIN;
  const dayEndMin = opts.dayEndMin ?? AGENDA_DAY_END_MIN;
  const stepMin = opts.stepMin ?? AGENDA_SLOT_STEP_MIN;

  if (rooms.length === 0) {
    return { placements: [], skipped: unscheduled.map((s) => ({ id: s.id, reason: 'no_rooms' as const })) };
  }
  const days = eventDays(eventWindow.starts_at, eventWindow.ends_at, tz);
  if (days.length === 0) {
    return { placements: [], skipped: unscheduled.map((s) => ({ id: s.id, reason: 'no_days' as const })) };
  }

  const windowStart = Date.parse(eventWindow.starts_at);
  const durationOf = (s: AutoScheduleSessionInput) => formatMinutes(s.format) ?? DEFAULT_DURATION_MIN;
  const candidates = new Map<string, Candidate[]>();
  for (const s of unscheduled) {
    candidates.set(
      s.id,
      candidatesFor(s, durationOf(s), rooms, days, tz, dayStartMin, dayEndMin, stepMin),
    );
  }

  const feasible = (s: AutoScheduleSessionInput, c: Candidate, indexes: ReturnType<typeof buildConflictIndexes>) =>
    computeConflictsForSession(tentativeOf(s, c), indexes, rooms, eventWindow).every(
      (conflict) => conflict.severity !== 'error',
    );

  // Phase 1 — most constrained first. A session with a preset room and a
  // 90-minute block has far fewer legal slots than a floating 30-minute one;
  // placing the easy ones first is how a greedy scheduler paints itself into
  // a corner. Counts are measured against the *board as it stands*, which is
  // enough to order the work (re-counting after every placement would be
  // O(n²) probes for a tie-break that barely moves).
  const baseIndexes = buildConflictIndexes(scheduled);
  const order = unscheduled
    .map((s) => ({
      session: s,
      count: (candidates.get(s.id) as Candidate[]).filter((c) => feasible(s, c, baseIndexes)).length,
      duration: durationOf(s),
    }))
    .sort(
      (a, b) =>
        a.count - b.count || b.duration - a.duration || a.session.id.localeCompare(b.session.id),
    );

  // Phase 2 — place, one at a time, against everything placed so far.
  const placements: AutoSchedulePlacement[] = [];
  const skipped: Array<{ id: string; reason: AutoScheduleSkipReason }> = [];
  const placedSessions: AgendaSessionInput[] = [];

  for (const { session } of order) {
    const indexes = buildConflictIndexes([...scheduled, ...placedSessions]);
    let best: { c: Candidate; score: number } | null = null;

    for (const c of candidates.get(session.id) as Candidate[]) {
      const conflicts = computeConflictsForSession(tentativeOf(session, c), indexes, rooms, eventWindow);
      if (conflicts.some((conflict) => conflict.severity === 'error')) continue;

      let score = 0;
      if (c.room.capacity !== null && session.capacity !== null && c.room.capacity >= session.capacity) {
        score +=
          AUTO_SCHEDULE_WEIGHTS.capacityFit -
          AUTO_SCHEDULE_WEIGHTS.capacitySlackPerSeat * (c.room.capacity - session.capacity);
      }
      if (session.track_id && clusters(indexes.byRoom.get(c.room.id), session.track_id, c.day, tz)) {
        score += AUTO_SCHEDULE_WEIGHTS.trackCluster;
      }
      for (const conflict of conflicts) {
        score += AUTO_SCHEDULE_WEIGHTS.warning[conflict.code] ?? 0;
      }
      score += AUTO_SCHEDULE_WEIGHTS.backToBackSameRoom * backToBackSpeakers(session, c, indexes.bySpeaker);
      score += AUTO_SCHEDULE_WEIGHTS.earlierBiasPerMinute * ((c.start - windowStart) / 60_000);

      // Ties are broken by the earliest slot, then by the first room in
      // payload order (candidates are generated room-major, so "keep the
      // incumbent" is already "first room").
      if (
        best === null ||
        score > best.score + 1e-9 ||
        (score > best.score - 1e-9 && c.start < best.c.start)
      ) {
        best = { c, score };
      }
    }

    if (!best) {
      skipped.push({ id: session.id, reason: 'no_feasible_slot' });
      continue;
    }
    placements.push({
      id: session.id,
      starts_at: best.c.starts_at,
      ends_at: best.c.ends_at,
      room_id: best.c.room.id,
    });
    placedSessions.push(tentativeOf(session, best.c));
  }

  return { placements, skipped };
}
