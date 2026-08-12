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

// docs/13 W5 / D8: pencilled sessions (time XOR room) never block a save —
// they are excluded from room-overlap conflicts (there is no room to double
// book) but still included in speaker double-booking, which is the whole
// point of surfacing the conflict instead of refusing the write.
describe('pencilled sessions and conflicts (docs/13 W5, D8)', () => {
  const speaker = { contact_id: 'sp-1', name: 'Speaker One' };
  const placed: AgendaSessionInput = {
    id: 'placed', code: 'SESS-1', title: 'Placed talk', starts_at: '2026-10-01T09:00:00.000Z',
    ends_at: '2026-10-01T10:00:00.000Z', room_id: 'room-a', track_id: null, capacity: null, speakers: [speaker],
  };

  it('a time-set/no-room session sharing a speaker with an overlapping placed session still raises SPEAKER_DOUBLE_BOOKED', () => {
    const pencilled: AgendaSessionInput = {
      ...placed, id: 'pencilled', code: 'SESS-2', title: 'Pencilled talk', room_id: null,
    };
    const hits = computeConflicts([placed, pencilled], ROOMS, EVENT);
    expect(hits.map((c) => c.code)).toContain('SPEAKER_DOUBLE_BOOKED');
    const speakerHit = hits.find((c) => c.code === 'SPEAKER_DOUBLE_BOOKED');
    expect(speakerHit?.session_ids.sort()).toEqual(['pencilled', 'placed']);
    expect(hits.map((c) => c.code)).not.toContain('ROOM_DOUBLE_BOOKED');
  });

  it('a time-set/no-room session never raises ROOM_DOUBLE_BOOKED even against another roomless overlap', () => {
    const a: AgendaSessionInput = { ...placed, id: 'a', room_id: null, speakers: [] };
    const b: AgendaSessionInput = { ...placed, id: 'b', room_id: null, speakers: [] };
    const hits = computeConflicts([a, b], ROOMS, EVENT);
    expect(hits.map((c) => c.code)).not.toContain('ROOM_DOUBLE_BOOKED');
  });
});

// Duplicate speaker records (eval defect: two contact rows both named
// "Priya Raman" produced "0 conflicts" for a same-slot double booking).
// Identity fallbacks: same email across records is still an error; same
// normalized name alone is a warning-level SPEAKER_LIKELY_DOUBLE_BOOKED.
describe('speaker double-booking across duplicate speaker records', () => {
  const base: Omit<AgendaSessionInput, 'id' | 'code' | 'title' | 'speakers' | 'room_id'> = {
    starts_at: '2026-10-01T10:00:00.000Z',
    ends_at: '2026-10-01T10:30:00.000Z',
    track_id: null,
    capacity: null,
  };
  const session = (
    id: string,
    room: string,
    speakers: AgendaSessionInput['speakers'],
  ): AgendaSessionInput => ({ ...base, id, code: id.toUpperCase(), title: `Talk ${id}`, room_id: room, speakers });

  it('still flags an exact contact-id match as an error', () => {
    const hits = computeConflicts(
      [
        session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman' }]),
        session('b', 'room-b', [{ contact_id: 'c1', name: 'Priya Raman' }]),
      ],
      ROOMS,
      EVENT,
    );
    const hit = hits.find((c) => c.code === 'SPEAKER_DOUBLE_BOOKED');
    expect(hit?.severity).toBe('error');
    expect(hit?.contact_id).toBe('c1');
  });

  it('flags two records sharing an email as SPEAKER_DOUBLE_BOOKED (error)', () => {
    const hits = computeConflicts(
      [
        session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman', email: 'Priya@Example.com ' }]),
        session('b', 'room-b', [{ contact_id: 'c2', name: 'P. Raman', email: 'priya@example.com' }]),
      ],
      ROOMS,
      EVENT,
    );
    const hit = hits.find((c) => c.code === 'SPEAKER_DOUBLE_BOOKED');
    expect(hit?.severity).toBe('error');
    expect(hit?.contact_id).toBe('c1~c2');
    expect(hit?.session_ids.slice().sort()).toEqual(['a', 'b']);
  });

  it('flags two records sharing only a normalized name as a warning', () => {
    const hits = computeConflicts(
      [
        session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman' }]),
        session('b', 'room-b', [{ contact_id: 'c2', name: '  priya   RAMAN ' }]),
      ],
      ROOMS,
      EVENT,
    );
    const hit = hits.find((c) => c.code === 'SPEAKER_LIKELY_DOUBLE_BOOKED');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('warning');
    expect(hit?.contact_id).toBe('c1~c2');
  });

  it('does not fire the name fallback for non-overlapping sessions or genuinely different names', () => {
    const later = {
      starts_at: '2026-10-01T11:00:00.000Z',
      ends_at: '2026-10-01T11:30:00.000Z',
    };
    const noOverlap = computeConflicts(
      [
        session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman' }]),
        { ...session('b', 'room-b', [{ contact_id: 'c2', name: 'Priya Raman' }]), ...later },
      ],
      ROOMS,
      EVENT,
    );
    expect(noOverlap.map((c) => c.code)).not.toContain('SPEAKER_LIKELY_DOUBLE_BOOKED');

    const differentPeople = computeConflicts(
      [
        session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman' }]),
        session('b', 'room-b', [{ contact_id: 'c2', name: 'Priya Sharma' }]),
      ],
      ROOMS,
      EVENT,
    );
    expect(differentPeople.map((c) => c.code)).not.toContain('SPEAKER_LIKELY_DOUBLE_BOOKED');
    expect(differentPeople.map((c) => c.code)).not.toContain('SPEAKER_DOUBLE_BOOKED');
  });

  it('emits one conflict per duplicate pair, not one per matching direction', () => {
    const hits = computeConflicts(
      [
        session('a', 'room-a', [
          { contact_id: 'c1', name: 'Priya Raman' },
          { contact_id: 'c3', name: 'Priya Raman' },
        ]),
        session('b', 'room-b', [{ contact_id: 'c2', name: 'Priya Raman' }]),
      ],
      ROOMS,
      EVENT,
    );
    const likely = hits.filter((c) => c.code === 'SPEAKER_LIKELY_DOUBLE_BOOKED');
    // c1 matches c2 (first name hit); c3 also matches c2 — distinct pairs.
    expect(likely.length).toBe(2);
    expect(new Set(likely.map((c) => c.contact_id)).size).toBe(2);
  });

  it('the incremental engine agrees with the full sweep on duplicate-record matches', () => {
    const a = session('a', 'room-a', [{ contact_id: 'c1', name: 'Priya Raman', email: 'priya@example.com' }]);
    const b = session('b', 'room-b', [{ contact_id: 'c2', name: 'Priya Raman', email: 'PRIYA@example.com' }]);
    const full = normalise(computeConflicts([a, b], ROOMS, EVENT).filter((c) => c.session_ids.includes('b')));
    const incr = normalise(computeConflictsForSession(b, buildConflictIndexes([a]), ROOMS, EVENT));
    expect(incr).toEqual(full);
    expect(incr.length).toBeGreaterThan(0);
  });
});
