// Parity harness for the incremental conflict engine (sweep item P2-17).
//
// The admin agenda recomputes drop previews on every animation frame while a
// session is dragged, so it uses `computeConflictsForSession` instead of the
// full sweep. Ignored conflicts are remembered by `signature`, so the two
// engines must agree *exactly* — not just on "is there a conflict".
//
// Strategy: generate randomised schedules with a seeded PRNG (reproducible
// failures), mutate one session the way a drag/resize/unschedule would, then
// assert that the incremental result equals the subset of the full result
// that involves the mutated session — code, severity, message, id order,
// contact and signature.

import { describe, expect, it } from 'vitest';
import {
  buildConflictIndexes,
  computeConflicts,
  computeConflictsForSession,
  type AgendaRoomInput,
  type AgendaSessionInput,
  type Conflict,
} from './agenda';

/** mulberry32 — small, fast, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EVENT = { starts_at: '2026-10-01T08:00:00.000Z', ends_at: '2026-10-02T20:00:00.000Z' };
const DAY0 = Date.parse(EVENT.starts_at);

const ROOMS: AgendaRoomInput[] = [
  { id: 'room-a', name: 'Hall A', capacity: 100 },
  { id: 'room-b', name: 'Hall B', capacity: 40 },
  { id: 'room-c', name: 'Hall C', capacity: null },
];
const TRACKS = ['trk-1', 'trk-2', null];
const CONTACTS = ['c1', 'c2', 'c3', 'c4'];

const pick = <T,>(rnd: () => number, list: T[]): T => list[Math.floor(rnd() * list.length)] as T;

/** Slot on a 15-minute lattice, sometimes deliberately outside the window. */
function slot(rnd: () => number): { starts_at: string | null; ends_at: string | null } {
  if (rnd() < 0.15) return { starts_at: null, ends_at: null };
  const offsetMin = Math.floor(rnd() * 200) * 15 - 60; // −60 min reaches outside the window
  const durationMin = (1 + Math.floor(rnd() * 8)) * 15;
  const start = DAY0 + offsetMin * 60_000;
  return {
    starts_at: new Date(start).toISOString(),
    ends_at: new Date(start + durationMin * 60_000).toISOString(),
  };
}

function makeSession(rnd: () => number, i: number): AgendaSessionInput {
  const times = slot(rnd);
  const speakers = CONTACTS.filter(() => rnd() < 0.4).map((contact_id) => ({
    contact_id,
    // Names vary per session on purpose: the travel-gap rule labels the
    // speaker from the *first* session in their timeline, and the incremental
    // engine has to reproduce that choice.
    name: `${contact_id.toUpperCase()} (${i})`,
  }));
  return {
    id: `s${String(i).padStart(2, '0')}`,
    code: `SESS-${i}`,
    title: `Session ${i}`,
    ...times,
    room_id: rnd() < 0.2 ? null : (pick(rnd, ROOMS) as AgendaRoomInput).id,
    track_id: pick(rnd, TRACKS),
    capacity: rnd() < 0.5 ? null : Math.floor(rnd() * 150),
    speakers,
  };
}

/** Total order over conflicts so two sets can be compared literally. */
const key = (c: Conflict) =>
  JSON.stringify([c.signature, c.code, c.severity, c.message, c.session_ids, c.contact_id ?? null]);
const normalise = (list: Conflict[]) => list.map(key).sort();

describe('computeConflictsForSession parity with computeConflicts', () => {
  it('matches the full engine on 200 randomised single-session mutations', () => {
    const failures: string[] = [];
    for (let iteration = 0; iteration < 200; iteration++) {
      const rnd = prng(1_000 + iteration);
      const count = 3 + Math.floor(rnd() * 12);
      const sessions = Array.from({ length: count }, (_, i) => makeSession(rnd, i));

      // Mutate exactly one session the way a drop / resize / unschedule does.
      const target = pick(rnd, sessions);
      const roll = rnd();
      const mutated: AgendaSessionInput =
        roll < 0.15
          ? { ...target, starts_at: null, ends_at: null, room_id: null } // unschedule
          : roll < 0.3
            ? { ...target, room_id: null } // dropped with no room
            : { ...target, ...slot(rnd), room_id: rnd() < 0.15 ? null : (pick(rnd, ROOMS) as AgendaRoomInput).id };

      const others = sessions.filter((s) => s.id !== target.id);
      const next = [...others, mutated];

      const expected = normalise(
        computeConflicts(next, ROOMS, EVENT).filter((c) => c.session_ids.includes(mutated.id)),
      );
      const actual = normalise(computeConflictsForSession(mutated, buildConflictIndexes(others), ROOMS, EVENT));

      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        failures.push(`iteration ${iteration} (${mutated.id})\n  full: ${expected.join('\n        ')}\n  incr: ${actual.join('\n        ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('reports the same conflicts when the changed session is left untouched', () => {
    const rnd = prng(42);
    const sessions = Array.from({ length: 10 }, (_, i) => makeSession(rnd, i));
    for (const s of sessions) {
      const others = sessions.filter((o) => o.id !== s.id);
      expect(normalise(computeConflictsForSession(s, buildConflictIndexes(others), ROOMS, EVENT))).toEqual(
        normalise(computeConflicts(sessions, ROOMS, EVENT).filter((c) => c.session_ids.includes(s.id))),
      );
    }
  });

  it('flags a straightforward room double-booking with the ignore-list signature', () => {
    const base: AgendaSessionInput = {
      id: 'a', code: 'SESS-1', title: 'A', starts_at: '2026-10-01T09:00:00.000Z',
      ends_at: '2026-10-01T10:00:00.000Z', room_id: 'room-a', track_id: null, capacity: null, speakers: [],
    };
    const other: AgendaSessionInput = { ...base, id: 'b', code: 'SESS-2', title: 'B' };
    const hits = computeConflictsForSession(base, buildConflictIndexes([other]), ROOMS, EVENT);
    expect(hits.map((c) => c.code)).toEqual(['ROOM_DOUBLE_BOOKED']);
    expect(hits[0]?.signature).toBe('ROOM_DOUBLE_BOOKED:a+b');
  });
});
