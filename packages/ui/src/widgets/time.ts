// Shared event-timezone time math for every public widget (Sessions, Speaker
// detail, Agenda, Schedule/itinerary, Gallery). One helper set so every
// widget renders a session's start/end the same way: wall-clock time in the
// EVENT's own timezone, with a short tz abbreviation ("10 AM – 10:30 AM
// PDT"), never the viewer's local offset and never a raw UTC-looking string.
//
// This mirrors apps/admin/src/agenda/timeUtils.ts — deliberately
// re-implemented rather than imported, since packages/ui must not depend on
// apps/admin (see AgendaWidget.tsx, which previously carried its own private
// copy of this same math; other widgets rolled their own `toLocaleTimeString`
// version that used the *viewer's* timezone instead of the event's, which is
// the EMB-16 bug this file fixes).

const dtfCache = new Map<string, Intl.DateTimeFormat>()

function dtf(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    } catch {
      // Unknown/blank tz on the event row: fall back to UTC rather than throw.
      f = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    }
    dtfCache.set(tz, f)
  }
  return f
}

export interface LocalTime {
  /** YYYY-MM-DD in the event timezone. */
  day: string
  /** Minutes since local midnight. */
  minutes: number
}

/** UTC ISO instant -> (event-local day, minutes-since-midnight). */
export function utcToLocal(iso: string, tz: string): LocalTime {
  const parts = dtf(tz).formatToParts(new Date(iso))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = Number(get('hour')) % 24 // en-CA can emit "24" at midnight
  return {
    day: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: hour * 60 + Number(get('minute')),
  }
}

export function fmtMinutes(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24
  const mm = Math.round(minutes % 60)
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  const suffix = h24 < 12 ? 'AM' : 'PM'
  return mm === 0 ? `${h12} ${suffix}` : `${h12}:${String(mm).padStart(2, '0')} ${suffix}`
}

export function fmtDayLong(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

export function fmtDayShort(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  if (!y || !m || !d) return day
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/** Short timezone label ("PDT", "GMT+2", …) for an instant, in `tz`. */
export function tzAbbr(tz: string, atIso: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(
      new Date(atIso),
    )
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz
  } catch {
    return tz
  }
}

/**
 * "10 AM – 10:30 AM PDT" — the one time-range string every session/agenda
 * card should show. `endsAt` is clamped to end-of-local-day if it lands on a
 * later local date than `startsAt` (mirrors AgendaWidget's grid clamping),
 * so an overnight block still reads as "10 PM – 11:59 PM PDT" on its own day
 * rather than wrapping to "10 PM – 1 AM".
 */
export function fmtTimeRange(startsAt: string, endsAt: string, tz: string): string {
  const start = utcToLocal(startsAt, tz)
  const end = utcToLocal(endsAt, tz)
  const endMinutes = end.day === start.day && end.minutes > start.minutes ? end.minutes : 24 * 60
  return `${fmtMinutes(start.minutes)} – ${fmtMinutes(endMinutes)} ${tzAbbr(tz, startsAt)}`
}

/**
 * Inclusive list of event days (event-local YYYY-MM-DD) between two UTC
 * instants (EMB-07: the day-tab strip should offer every day of the event,
 * not just days that happen to already have a session). Mirrors
 * apps/admin/src/agenda/timeUtils.ts eventDays. Capped at 60 days as a
 * defensive bound against a garbage date range.
 */
export function eventDays(startsIso: string, endsIso: string, tz: string): string[] {
  const first = utcToLocal(startsIso, tz).day
  const last = utcToLocal(endsIso, tz).day
  const days: string[] = []
  const [y, m, d] = first.split('-').map(Number)
  if (!y || !m || !d) return days
  let cursor = Date.UTC(y, m - 1, d, 12)
  for (let i = 0; i < 60; i++) {
    const day = new Date(cursor).toISOString().slice(0, 10)
    days.push(day)
    if (day === last) break
    cursor += 24 * 3600_000
  }
  return days
}
