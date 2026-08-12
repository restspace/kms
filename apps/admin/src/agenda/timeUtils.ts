// Event-timezone time math for the agenda (docs/07 §2: all calendar views
// render in the event timezone). The DB stores UTC instants; the grid thinks
// in (local day, minutes-since-midnight) pairs.
//
// The conversions themselves now live in @kms/core (`agendaTime.ts`): the
// Worker's auto-schedule assistant (AIA-08) places sessions at local wall
// clock times, so it needs the identical math — one implementation, no drift,
// exactly like the conflict engine. This module re-exports them so every
// admin call site (and this folder's tests) keeps importing from here.

import { eventDays, utcToLocal } from '@kms/core'

export {
  AGENDA_DAY_END_MIN,
  AGENDA_DAY_START_MIN,
  AGENDA_SLOT_STEP_MIN,
  durationMinutes,
  eventDays,
  formatMinutes,
  localToUtc,
  snapTo,
  utcToLocal,
  type LocalTime,
} from '@kms/core'

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

/**
 * Three schedule states (docs/13 W5, D8): Tray (nothing set), Pencilled
 * (time XOR room — "Tuesday morning, somewhere"), Placed (both).
 *
 * AIA-08 adds a second way to be pencilled: a session the auto-schedule
 * assistant placed carries `pencilled_at` until an organiser confirms it. It
 * has both a time and a room, but nobody has agreed to them yet — so it reads
 * as provisional here (and stays out of the public feeds server-side) until
 * Confirm placements, or any manual drag, clears the column.
 */
export type ScheduleState = 'tray' | 'pencilled' | 'placed'

export function classifySchedule(s: {
  starts_at: string | null
  room_id: string | null
  pencilled_at?: string | null
}): ScheduleState {
  const hasTime = s.starts_at !== null
  const hasRoom = s.room_id !== null
  if (hasTime && hasRoom) return s.pencilled_at != null ? 'pencilled' : 'placed'
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
