// Event-timezone time math for the agenda (docs/07 §2: all calendar views
// render in the event timezone). The DB stores UTC instants; the grid thinks
// in (local day, minutes-since-midnight) pairs.
//
// This lived in apps/admin/src/agenda/timeUtils.ts until AIA-08 needed the
// same wall-clock math inside the Worker (the auto-schedule assistant places
// sessions at local 06:00–20:00, so it must convert both ways). Moved here
// verbatim; timeUtils.ts re-exports it so no admin call site changed.
// `Intl` is available in workerd — time.ts already relies on it.

export interface LocalTime {
  day: string; // YYYY-MM-DD in the event timezone
  minutes: number; // minutes since local midnight
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/**
 * A bare "YYYY-MM-DD" (no time component). `new Date(bareDate)` parses it as
 * UTC midnight, and shifting *that* into a timezone west of UTC lands one
 * calendar day early (docs/07: a May 12–14 event rendering as May 11–13) —
 * exactly the eval-reported day-list-off-by-one. A date-only value has no
 * instant to convert in the first place, so it is read as that literal
 * calendar day rather than run through `new Date()` at all.
 */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function utcToLocal(iso: string, tz: string): LocalTime {
  if (BARE_DATE_RE.test(iso)) return { day: iso, minutes: 0 };
  const parts = dtf(tz).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = Number(get('hour')) % 24; // en-CA can emit "24" at midnight
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  };
}

/** Wall clock (day, minutes) in `tz` → UTC ISO. Two-pass offset refinement. */
export function localToUtc(day: string, minutes: number, tz: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = Date.UTC(y as number, (m as number) - 1, d as number, 0, minutes);
  let ts = target;
  for (let i = 0; i < 2; i++) {
    const local = utcToLocal(new Date(ts).toISOString(), tz);
    const [ly, lm, ld] = local.day.split('-').map(Number);
    const localTs = Date.UTC(ly as number, (lm as number) - 1, ld as number, 0, local.minutes);
    ts += target - localTs;
  }
  return new Date(ts).toISOString();
}

/** Inclusive list of event days (local dates) between two UTC instants. */
export function eventDays(startsIso: string, endsIso: string, tz: string): string[] {
  const first = utcToLocal(startsIso, tz).day;
  const last = utcToLocal(endsIso, tz).day;
  const days: string[] = [];
  // Walk in UTC noon steps so DST shifts cannot skip or repeat a date.
  const [y, m, d] = first.split('-').map(Number);
  let cursor = Date.UTC(y as number, (m as number) - 1, d as number, 12);
  for (let i = 0; i < 60; i++) {
    const day = new Date(cursor).toISOString().slice(0, 10);
    days.push(day);
    if (day === last) break;
    cursor += 24 * 3600_000;
  }
  return days;
}

export function durationMinutes(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
}

export const snapTo = (minutes: number, step: number): number => Math.round(minutes / step) * step;

/** Default block length by format (docs/07 §3 "session's default duration"). */
const FORMAT_DURATION: Record<string, number> = {
  workshop: 90,
  keynote: 45,
  'featured keynote': 45,
  panel: 45,
  'lightning talk': 10,
};

/** "Lightning Talk (10 min)", "Deep Dive – 75 minutes", "45-min briefing"… */
const FORMAT_MINUTES_RE = /(\d+)\s*(?:-\s*)?min(?:ute)?s?\b/i;

/**
 * Minutes a session format implies, or null when the format says nothing.
 * An explicit "(N min)" in the format label wins (eval defect: a
 * "Lightning Talk (10 min)" was placed as a 30-minute block because the
 * lookup only knew the bare "Lightning Talk" key); otherwise known format
 * names match case-insensitively, including as a prefix ("Workshop — hands
 * on") so decorated labels still get their family's default.
 */
export function formatMinutes(format: string | null | undefined): number | null {
  if (!format) return null;
  const m = FORMAT_MINUTES_RE.exec(format);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const key = format.trim().toLowerCase();
  const exact = FORMAT_DURATION[key];
  if (exact !== undefined) return exact;
  for (const [name, minutes] of Object.entries(FORMAT_DURATION)) {
    if (key.startsWith(name)) return minutes;
  }
  return null;
}

/**
 * The schedulable local day (docs/07 §2: the grid renders 06:00–20:00) and the
 * drop granularity (§3: drops snap to 15 min). The admin grid and the
 * auto-schedule assistant must agree on these or the assistant would place
 * blocks the grid cannot render.
 */
export const AGENDA_DAY_START_MIN = 360;
export const AGENDA_DAY_END_MIN = 1200;
export const AGENDA_SLOT_STEP_MIN = 15;
