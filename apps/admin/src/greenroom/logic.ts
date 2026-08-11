// Pure derivations for the green room (workplan 12). Comparisons happen on
// UTC instants (Date.parse vs a nowMs number) so the device's own timezone is
// irrelevant; the event timezone is display-only and every display conversion
// goes through agenda/timeUtils.ts, which owns the bare-date and hour-24
// traps. Unit-tested in greenroom.logic.test.ts.

import type { GreenRoomSession } from '../api'
import { utcToLocal } from '../agenda/timeUtils'

/** A scheduled session with no ends_at still occupies its slot for a bit. */
const DEFAULT_DURATION_MS = 60 * 60_000

export const sessionEndMs = (s: GreenRoomSession): number =>
  s.ends_at ? Date.parse(s.ends_at) : Date.parse(s.starts_at) + DEFAULT_DURATION_MS

/** Bucket scheduled sessions by their event-local calendar day, sorted by start. */
export function windowByDay(sessions: GreenRoomSession[], tz: string): Map<string, GreenRoomSession[]> {
  const byDay = new Map<string, GreenRoomSession[]>()
  const sorted = [...sessions].sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
  for (const s of sorted) {
    const day = utcToLocal(s.starts_at, tz).day
    const list = byDay.get(day)
    if (list) list.push(s)
    else byDay.set(day, [s])
  }
  return byDay
}

export interface RoomNowNext {
  /** On stage right now: starts ≤ now < ends; the latest start wins an overlap. */
  current: GreenRoomSession | null
  /** The next session to start after now. */
  next: GreenRoomSession | null
  /** Everything after `next`, still today in this room. */
  later: GreenRoomSession[]
}

/** Now/next for one room from one day's sessions (already event-local bucketed). */
export function deriveNowNext(daySessions: GreenRoomSession[], roomId: string, nowMs: number): RoomNowNext {
  const inRoom = daySessions.filter((s) => s.room_id === roomId)
  let current: GreenRoomSession | null = null
  for (const s of inRoom) {
    const starts = Date.parse(s.starts_at)
    if (starts <= nowMs && nowMs < sessionEndMs(s)) {
      if (!current || starts > Date.parse(current.starts_at)) current = s
    }
  }
  const upcoming = inRoom.filter((s) => Date.parse(s.starts_at) > nowMs)
  return { current, next: upcoming[0] ?? null, later: upcoming.slice(1) }
}

/**
 * Which day to show on open: today if it has sessions, else the first future
 * day with sessions (pre-conference prep), else the last day that had any
 * (post-conference). Null only when nothing is scheduled at all.
 */
export function pickDay(daysWithSessions: string[], todayLocalDay: string): string | null {
  if (daysWithSessions.length === 0) return null
  if (daysWithSessions.includes(todayLocalDay)) return todayLocalDay
  const future = daysWithSessions.filter((d) => d > todayLocalDay)
  return future[0] ?? daysWithSessions[daysWithSessions.length - 1]
}

/** `tel:` href from a stored phone, or null when there is nothing to dial. */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/[^\d+]/g, '')
  const normalised = digits.startsWith('+') ? `+${digits.slice(1).replace(/\+/g, '')}` : digits.replace(/\+/g, '')
  return normalised.replace(/\+/g, '').length >= 5 ? `tel:${normalised}` : null
}

/** "38 min left" / "ends in <1 min" for the on-now card. */
export function timeLeftLabel(session: GreenRoomSession, nowMs: number): string {
  const minutes = Math.floor((sessionEndMs(session) - nowMs) / 60_000)
  if (minutes < 1) return 'ending now'
  if (minutes === 1) return '1 min left'
  return `${minutes} min left`
}

/** "in 12 min" / "in 2 h 05" for the up-next card. */
export function startsInLabel(session: GreenRoomSession, nowMs: number): string {
  const minutes = Math.ceil((Date.parse(session.starts_at) - nowMs) / 60_000)
  if (minutes <= 1) return 'starting now'
  if (minutes < 60) return `in ${minutes} min`
  const h = Math.floor(minutes / 60)
  return `in ${h} h ${String(minutes % 60).padStart(2, '0')}`
}
