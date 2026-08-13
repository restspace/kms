// Auto-schedule assist (AIA-08). The assistant writes to the real schedule,
// so the tests that matter are the ones a scheduler would demand before
// letting it near their board: it never proposes a hard conflict, it proposes
// the *same* thing twice, and it stays inside the event window and the
// schedulable day. The preference tests below pin the judgement calls.

import { describe, expect, it } from 'vitest';
import { computeConflicts, type AgendaRoomInput, type AgendaSessionInput } from './agenda';
import { utcToLocal } from './agendaTime';
import { autoSchedule, type AutoScheduleSessionInput } from './autoSchedule';

const WINDOW = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-14T23:59:59.999Z' };
const UTC = { timezone: 'UTC' } as const;

const mk = (id: string, over: Partial<AutoScheduleSessionInput> = {}): AutoScheduleSessionInput => ({
  id,
  code: id.toUpperCase(),
  title: `Session ${id}`,
  starts_at: null,
  ends_at: null,
  room_id: null,
  track_id: null,
  capacity: null,
  speakers: [],
  format: null,
  ...over,
});

const room = (id: string, capacity: number | null = null): AgendaRoomInput => ({ id, name: id, capacity });

const speaker = (id: string) => ({ contact_id: id, name: `Speaker ${id}`, email: `${id}@example.com` });

/** The placed sessions, as the conflict engine would see them on the board. */
function boardAfter(
  unscheduled: AutoScheduleSessionInput[],
  result: ReturnType<typeof autoSchedule>,
  scheduled: AgendaSessionInput[],
): AgendaSessionInput[] {
  const byId = new Map(unscheduled.map((s) => [s.id, s]));
  const placed = result.placements.map((p) => ({
    ...(byId.get(p.id) as AgendaSessionInput),
    starts_at: p.starts_at,
    ends_at: p.ends_at,
    room_id: p.room_id,
  }));
  return [...scheduled, ...placed];
}

const durationOf = (p: { starts_at: string; ends_at: string }) =>
  (Date.parse(p.ends_at) - Date.parse(p.starts_at)) / 60_000;

/** Deterministic PRNG — a "random" schedule that is the same one every run. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('autoSchedule — never proposes a hard conflict', () => {
  it('places a tray of overlapping-speaker sessions with zero error conflicts', () => {
    const rooms = [room('r1', 200), room('r2', 120), room('r3', 60)];
    const unscheduled = [
      mk('s1', { format: 'workshop', speakers: [speaker('c1')], capacity: 100 }),
      mk('s2', { format: 'keynote', speakers: [speaker('c1'), speaker('c2')], capacity: 150 }),
      mk('s3', { format: 'Lightning Talk (10 min)', speakers: [speaker('c2')] }),
      mk('s4', { speakers: [speaker('c3')], track_id: 't1' }),
      mk('s5', { format: 'panel', speakers: [speaker('c1'), speaker('c3')], track_id: 't1' }),
    ];
    const result = autoSchedule(unscheduled, [], rooms, WINDOW, UTC);

    expect(result.placements).toHaveLength(5);
    const conflicts = computeConflicts(boardAfter(unscheduled, result, []), rooms, WINDOW);
    expect(conflicts.filter((c) => c.severity === 'error')).toEqual([]);
  });

  it('respects sessions already on the board (seeded random schedule)', () => {
    const rand = mulberry32(20260812);
    const rooms = [room('r1', 100), room('r2', 100), room('r3', 100)];

    // Pre-existing schedule: one non-overlapping block per room per day.
    const scheduled: AgendaSessionInput[] = [];
    for (const day of ['2027-05-12', '2027-05-13', '2027-05-14']) {
      for (const [i, r] of rooms.entries()) {
        const hour = 9 + i;
        scheduled.push({
          ...mk(`fixed-${day}-${r.id}`, { speakers: [speaker(`c${Math.floor(rand() * 4)}`)] }),
          starts_at: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
          ends_at: `${day}T${String(hour).padStart(2, '0')}:45:00.000Z`,
          room_id: r.id,
        });
      }
    }

    const formats = ['workshop', 'keynote', 'panel', 'Lightning Talk (10 min)', null];
    const unscheduled = Array.from({ length: 14 }, (_, i) =>
      mk(`t${i}`, {
        format: formats[Math.floor(rand() * formats.length)] as string | null,
        speakers: rand() > 0.3 ? [speaker(`c${Math.floor(rand() * 4)}`)] : [],
        ...(rand() > 0.6 ? { track_id: `tr${Math.floor(rand() * 2)}` } : {}),
        ...(rand() > 0.7 ? { capacity: 80 } : {}),
      }),
    );

    const result = autoSchedule(unscheduled, scheduled, rooms, WINDOW, UTC);
    expect(result.skipped).toEqual([]);
    const conflicts = computeConflicts(boardAfter(unscheduled, result, scheduled), rooms, WINDOW);
    expect(conflicts.filter((c) => c.severity === 'error')).toEqual([]);
  });
});

describe('autoSchedule — determinism', () => {
  const rooms = [room('r1', 100), room('r2', 60)];
  const sessions = [
    mk('a', { format: 'workshop', speakers: [speaker('c1')] }),
    mk('b', { format: 'keynote', speakers: [speaker('c1')], capacity: 80 }),
    mk('c', { track_id: 't1' }),
    mk('d', { track_id: 't1', format: 'panel' }),
  ];

  it('produces identical placements for the same input twice', () => {
    expect(autoSchedule(sessions, [], rooms, WINDOW, UTC)).toEqual(
      autoSchedule(sessions, [], rooms, WINDOW, UTC),
    );
  });

  it('is order-independent: shuffling the tray changes nothing', () => {
    const shuffled = [sessions[2], sessions[0], sessions[3], sessions[1]] as AutoScheduleSessionInput[];
    expect(autoSchedule(shuffled, [], rooms, WINDOW, UTC)).toEqual(
      autoSchedule(sessions, [], rooms, WINDOW, UTC),
    );
  });
});

describe('autoSchedule — bounds', () => {
  it('stays inside the event window and the 06:00–20:00 local day, across a DST change', () => {
    // US DST ends 2026-11-01: the event spans Oct 31 (PDT, UTC-7) through
    // Nov 2 (PST, UTC-8), so a naive fixed-offset conversion would drift an
    // hour and start placing blocks at 05:00 local on the far side.
    const tz = 'America/Los_Angeles';
    const window = { starts_at: '2026-10-31T07:00:00.000Z', ends_at: '2026-11-03T07:59:59.999Z' };
    const rooms = [room('r1', 100), room('r2', 100)];
    const unscheduled = Array.from({ length: 12 }, (_, i) =>
      mk(`s${i}`, { format: i % 3 === 0 ? 'workshop' : null, speakers: [speaker(`c${i % 3}`)] }),
    );

    const result = autoSchedule(unscheduled, [], rooms, window, { timezone: tz });
    expect(result.placements).toHaveLength(12);

    const days = new Set<string>();
    for (const p of result.placements) {
      expect(Date.parse(p.starts_at)).toBeGreaterThanOrEqual(Date.parse(window.starts_at));
      expect(Date.parse(p.ends_at)).toBeLessThanOrEqual(Date.parse(window.ends_at));
      const start = utcToLocal(p.starts_at, tz);
      const end = utcToLocal(p.ends_at, tz);
      expect(start.minutes).toBeGreaterThanOrEqual(6 * 60);
      expect(end.minutes).toBeLessThanOrEqual(20 * 60);
      expect(end.day).toBe(start.day); // no block spills into the next local day
      days.add(start.day);
    }
    for (const day of days) expect(['2026-10-31', '2026-11-01', '2026-11-02']).toContain(day);
  });
});

describe('autoSchedule — preferences', () => {
  it('places the most constrained session first: a room-preset session wins the contested slot', () => {
    // One day, one hour of schedulable time, two rooms: exactly two slots.
    // "b-fixed" can only ever use r1, so taking r1 for the free session
    // (which sorts first by id) would strand it.
    const rooms = [room('r1'), room('r2')];
    const window = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' };
    const day = { dayStartMin: 9 * 60, dayEndMin: 10 * 60, stepMin: 60 };
    const unscheduled = [
      mk('a-free', { format: '60 min' }),
      mk('b-fixed', { format: '60 min', room_id: 'r1' }),
    ];

    const result = autoSchedule(unscheduled, [], rooms, window, { timezone: 'UTC', ...day });
    expect(result.skipped).toEqual([]);
    expect(new Map(result.placements.map((p) => [p.id, p.room_id]))).toEqual(
      new Map([
        ['b-fixed', 'r1'],
        ['a-free', 'r2'],
      ]),
    );
  });

  it('prefers the smallest room that still fits, but will use an undersized one when forced', () => {
    const rooms = [room('huge', 500), room('fits', 120), room('tiny', 50)];
    const result = autoSchedule([mk('s1', { capacity: 100 })], [], rooms, WINDOW, UTC);
    expect(result.placements[0]?.room_id).toBe('fits');

    const forced = autoSchedule([mk('s1', { capacity: 100 })], [], [room('tiny', 50)], WINDOW, UTC);
    expect(forced.placements[0]?.room_id).toBe('tiny');
    expect(forced.skipped).toEqual([]);
  });

  it('clusters a track into the room that already runs it that day', () => {
    const rooms = [room('r1'), room('r2')];
    const scheduled: AgendaSessionInput[] = [
      {
        ...mk('existing', { track_id: 'design' }),
        starts_at: '2027-05-12T09:00:00.000Z',
        ends_at: '2027-05-12T10:00:00.000Z',
        room_id: 'r2',
      },
    ];
    const result = autoSchedule([mk('s1', { track_id: 'design' })], scheduled, rooms, WINDOW, UTC);
    // r1 is the first room and would win any tie; the clustering bonus moves it.
    expect(result.placements[0]?.room_id).toBe('r2');
    expect(utcToLocal(result.placements[0]?.starts_at as string, 'UTC').day).toBe('2027-05-12');
  });

  it('avoids a cross-room dash for one speaker when an alternative exists — but still places when none does', () => {
    const rooms = [room('r1'), room('r2')];
    const scheduled: AgendaSessionInput[] = [
      {
        ...mk('existing', { speakers: [speaker('c1')] }),
        starts_at: '2027-05-12T09:00:00.000Z',
        ends_at: '2027-05-12T10:00:00.000Z',
        room_id: 'r1',
      },
    ];
    const roomy = autoSchedule([mk('s1', { speakers: [speaker('c1')] })], scheduled, rooms, WINDOW, UTC);
    const placement = roomy.placements[0];
    expect(placement).toBeDefined();
    const gapMin =
      (Date.parse(placement?.starts_at as string) - Date.parse('2027-05-12T10:00:00.000Z')) / 60_000;
    expect(gapMin >= 10 || gapMin < 0).toBe(true); // never a 0–9 minute sprint

    // Squeeze the day down to the single slot right after the fixed session in
    // the *other* room: the warning is now the price of scheduling at all.
    const tight = autoSchedule(
      [mk('s1', { speakers: [speaker('c1')], format: '30 min' })],
      scheduled,
      [room('r2')],
      { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' },
      { timezone: 'UTC', dayStartMin: 10 * 60, dayEndMin: 10 * 60 + 30, stepMin: 30 },
    );
    expect(tight.placements).toEqual([
      {
        id: 's1',
        starts_at: '2027-05-12T10:00:00.000Z',
        ends_at: '2027-05-12T10:30:00.000Z',
        room_id: 'r2',
      },
    ]);
  });
});

describe('autoSchedule — realistic-day preference (eval #20)', () => {
  it('places a lone lightning talk in the 09:00–18:00 window, not at the raw 06:00 axis start', () => {
    const rooms = [room('r1')];
    const window = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' };
    const result = autoSchedule(
      [mk('lightning', { format: 'Lightning Talk (10 min)' })],
      [],
      rooms,
      window,
      UTC,
    );
    expect(result.skipped).toEqual([]);
    const placement = result.placements[0];
    expect(placement).toBeDefined();
    const local = utcToLocal(placement?.starts_at as string, 'UTC');
    expect(local.minutes).toBeGreaterThanOrEqual(9 * 60);
    expect(local.minutes).toBeLessThan(18 * 60);
  });

  it('widens the realistic window to include an early already-scheduled session, rather than shrinking to it', () => {
    const rooms = [room('r1'), room('r2')];
    const window = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' };
    const scheduled: AgendaSessionInput[] = [
      {
        ...mk('early-bird'),
        starts_at: '2027-05-12T07:00:00.000Z',
        ends_at: '2027-05-12T07:30:00.000Z',
        room_id: 'r1',
      },
    ];
    // A free-floating session should still land inside the widened window
    // (07:00–18:00), not get squeezed into exactly 07:00–07:30.
    const result = autoSchedule([mk('s1', { format: '60 min' })], scheduled, rooms, window, UTC);
    expect(result.skipped).toEqual([]);
    const local = utcToLocal(result.placements[0]?.starts_at as string, 'UTC');
    expect(local.minutes).toBeGreaterThanOrEqual(7 * 60);
    expect(local.minutes).toBeLessThan(18 * 60);
  });

  it('still places outside the window when the realistic day is packed solid, rather than skipping', () => {
    const rooms = [room('r1')];
    const window = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' };
    // Fill the whole 09:00–18:00 window with one back-to-back block so the
    // only remaining candidate for a second session is outside it.
    const scheduled: AgendaSessionInput[] = [
      {
        ...mk('filler'),
        starts_at: '2027-05-12T09:00:00.000Z',
        ends_at: '2027-05-12T18:00:00.000Z',
        room_id: 'r1',
      },
    ];
    const result = autoSchedule(
      [mk('overflow', { format: '30 min' })],
      scheduled,
      rooms,
      window,
      { timezone: 'UTC', dayStartMin: 6 * 60, dayEndMin: 20 * 60, stepMin: 15 },
    );
    expect(result.skipped).toEqual([]);
    expect(result.placements).toHaveLength(1);
  });
});

describe('autoSchedule — skipped reasons', () => {
  it('reports no_rooms when the event has no rooms at all', () => {
    const result = autoSchedule([mk('s1'), mk('s2')], [], [], WINDOW, UTC);
    expect(result.placements).toEqual([]);
    expect(result.skipped).toEqual([
      { id: 's1', reason: 'no_rooms' },
      { id: 's2', reason: 'no_rooms' },
    ]);
  });

  it('reports no_feasible_slot for the session that does not fit', () => {
    const window = { starts_at: '2027-05-12T00:00:00.000Z', ends_at: '2027-05-12T23:59:59.999Z' };
    const result = autoSchedule(
      [mk('a', { format: '60 min' }), mk('b', { format: '60 min' })],
      [],
      [room('r1')],
      window,
      { timezone: 'UTC', dayStartMin: 9 * 60, dayEndMin: 10 * 60, stepMin: 60 },
    );
    expect(result.placements).toHaveLength(1);
    expect(result.skipped).toEqual([{ id: 'b', reason: 'no_feasible_slot' }]);
  });
});

describe('autoSchedule — block length follows the format', () => {
  it('reads "(10 min)", known format names and the 30-minute fallback', () => {
    const rooms = [room('r1'), room('r2'), room('r3')];
    const unscheduled = [
      mk('lightning', { format: 'Lightning Talk (10 min)' }),
      mk('workshop', { format: 'workshop' }),
      mk('plain', { format: null }),
    ];
    const result = autoSchedule(unscheduled, [], rooms, WINDOW, UTC);
    const byId = new Map(result.placements.map((p) => [p.id, durationOf(p)]));
    expect(byId.get('lightning')).toBe(10);
    expect(byId.get('workshop')).toBe(90);
    expect(byId.get('plain')).toBe(30);
  });
});
