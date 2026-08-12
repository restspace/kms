// Event-timezone time math for the agenda (docs/07 §2: all calendar views
// render in the event timezone). The DB stores UTC instants; the grid thinks
// in (local day, minutes-since-midnight) pairs.

export interface LocalTime {
  day: string // YYYY-MM-DD in the event timezone
  minutes: number // minutes since local midnight
}

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    dtfCache.set(tz, f)
  }
  return f
}

/**
 * A bare "YYYY-MM-DD" (no time component). `new Date(bareDate)` parses it as
 * UTC midnight, and shifting *that* into a timezone west of UTC lands one
 * calendar day early (docs/07: a May 12–14 event rendering as May 11–13) —
 * exactly the eval-reported day-list-off-by-one. A date-only value has no
 * instant to convert in the first place, so it is read as that literal
 * calendar day rather than run through `new Date()` at all.
 */
const BARE_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function utcToLocal(iso: string, tz: string): LocalTime {
  if (BARE_DATE_RE.test(iso)) return { day: iso, minutes: 0 }
  const parts = dtf(tz).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = Number(get('hour')) % 24 // en-CA can emit "24" at midnight
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  }
}

/** Wall clock (day, minutes) in `tz` → UTC ISO. Two-pass offset refinement. */
export function localToUtc(day: string, minutes: number, tz: string): string {
  const [y, m, d] = day.split('-').map(Number)
  const target = Date.UTC(y as number, (m as number) - 1, d as number, 0, minutes)
  let ts = target
  for (let i = 0; i < 2; i++) {
    const local = utcToLocal(new Date(ts).toISOString(), tz)
    const [ly, lm, ld] = local.day.split('-').map(Number)
    const localTs = Date.UTC(ly as number, (lm as number) - 1, ld as number, 0, local.minutes)
    ts += target - localTs
  }
  return new Date(ts).toISOString()
}

/** Inclusive list of event days (local dates) between two UTC instants. */
export function eventDays(startsIso: string, endsIso: string, tz: string): string[] {
  const first = utcToLocal(startsIso, tz).day
  const last = utcToLocal(endsIso, tz).day
  const days: string[] = []
  // Walk in UTC noon steps so DST shifts cannot skip or repeat a date.
  const [y, m, d] = first.split('-').map(Number)
  let cursor = Date.UTC(y as number, (m as number) - 1, d as number, 12)
  for (let i = 0; i < 60; i++) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    days.push(day)
    if (day === last) break
    cursor += 24 * 3600_000
  }
  return days
}

export function fmtMinutes(minutes: number): string {
  const h24 = Math.floor(minutes / 60)
  const mm = minutes % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const suffix = h24 < 12 ? 'AM' : 'PM'
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`
}

export function fmtRange(startIso: string, endIso: string, tz: string): string {
  return `${fmtMinutes(utcToLocal(startIso, tz).minutes)} – ${fmtMinutes(utcToLocal(endIso, tz).minutes)}`
}

export function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number, 12)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

export function tzAbbr(tz: string, atIso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(
    new Date(atIso),
  )
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz
}

export function durationMinutes(startIso: string, endIso: string): number {
  return Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000)
}

export const snapTo = (minutes: number, step: number): number => Math.round(minutes / step) * step

/** Default block length by format (docs/07 §3 "session's default duration"). */
const FORMAT_DURATION: Record<string, number> = {
  workshop: 90,
  keynote: 45,
  'featured keynote': 45,
  panel: 45,
  'lightning talk': 10,
}

/** "Lightning Talk (10 min)", "Deep Dive – 75 minutes", "45-min briefing"… */
const FORMAT_MINUTES_RE = /(\d+)\s*(?:-\s*)?min(?:ute)?s?\b/i

/**
 * Minutes a session format implies, or null when the format says nothing.
 * An explicit "(N min)" in the format label wins (eval defect: a
 * "Lightning Talk (10 min)" was placed as a 30-minute block because the
 * lookup only knew the bare "Lightning Talk" key); otherwise known format
 * names match case-insensitively, including as a prefix ("Workshop — hands
 * on") so decorated labels still get their family's default.
 */
export function formatMinutes(format: string | null | undefined): number | null {
  if (!format) return null
  const m = FORMAT_MINUTES_RE.exec(format)
  if (m) {
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) return n
  }
  const key = format.trim().toLowerCase()
  const exact = FORMAT_DURATION[key]
  if (exact !== undefined) return exact
  for (const [name, minutes] of Object.entries(FORMAT_DURATION)) {
    if (key.startsWith(name)) return minutes
  }
  return null
}

/**
 * Three schedule states (docs/13 W5, D8): Tray (nothing set), Pencilled
 * (time XOR room — "Tuesday morning, somewhere"), Placed (both). No
 * migration backs this; it is a read of the same two nullable columns the
 * server already accepts independently.
 */
export type ScheduleState = 'tray' | 'pencilled' | 'placed'

export function classifySchedule(s: { starts_at: string | null; room_id: string | null }): ScheduleState {
  const hasTime = s.starts_at !== null
  const hasRoom = s.room_id !== null
  if (hasTime && hasRoom) return 'placed'
  if (hasTime || hasRoom) return 'pencilled'
  return 'tray'
}

/**
 * Format an event's date range for display in the sidebar (e.g., "May 12 – May 14").
 * Handles the common case where ends_at is exclusive (midnight UTC of the next day)
 * by using eventDays to compute the inclusive day range in the event's timezone.
 */
export function formatEventDateRange(startsAt: string | null | undefined, endsAt: string | null | undefined, timezone: string): string {
  if (!startsAt || !endsAt) return ''
  try {
    const days = eventDays(startsAt, endsAt, timezone)
    if (days.length === 0) return ''
    if (days.length === 1) return fmtDay(days[0])
    return `${fmtDay(days[0])} – ${fmtDay(days[days.length - 1])}`
  } catch {
    return ''
  }
}
