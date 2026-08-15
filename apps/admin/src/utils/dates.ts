/**
 * Date handling for admin surfaces. The DB stores UTC instants; NFR-12 says
 * every date is rendered in the event timezone, not the viewer's — and, by the
 * same rule, a wall-clock time typed into the admin is read in the event
 * timezone, not the viewer's. The tz math lives in the agenda's timeUtils; the
 * two helpers below adapt it to `<input type="datetime-local">`.
 */
import { localToUtc, utcToLocal } from '../agenda/timeUtils'

export function fmtDateInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' })
}

/** UTC ISO → the `YYYY-MM-DDTHH:mm` an `<input type="datetime-local">` wants, in `tz`. */
export function isoToLocalInput(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const { day, minutes } = utcToLocal(d.toISOString(), tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${day}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`
}

/** `YYYY-MM-DDTHH:mm` typed by the admin, read as `tz` wall clock → UTC ISO. */
export function localInputToIso(value: string, tz: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  return localToUtc(m[1] as string, Number(m[2]) * 60 + Number(m[3]), tz)
}

/* --- Submission/session schedule rendering (workspace Submissions list) ---
 * A Session is the accepted Submission row itself (docs/02 §Session), so its
 * schedule lives on the same row: starts_at / ends_at / room. Times are UTC
 * instants rendered in the EVENT timezone, 24h — matching the agenda grid
 * rather than the viewer's locale.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** 1st, 2nd, 3rd, 4th … 11th/12th/13th are the exceptions the mod-10 rule gets wrong. */
function ordinal(day: number): string {
  const rem100 = day % 100
  if (rem100 >= 11 && rem100 <= 13) return `${day}th`
  switch (day % 10) {
    case 1: return `${day}st`
    case 2: return `${day}nd`
    case 3: return `${day}rd`
    default: return `${day}th`
  }
}

function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

function parts(iso: string, tz: string): { day: number; month: string; time: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const local = utcToLocal(iso, tz)
  const [, m, dd] = local.day.split('-').map(Number)
  return { day: dd as number, month: MONTHS[(m as number) - 1] as string, time: hhmm(local.minutes) }
}

/** Desktop Starts cell: "11 Aug 15:30". Empty for an unscheduled row. */
export function fmtScheduleStart(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  const p = parts(iso, tz)
  return p ? `${p.day} ${p.month} ${p.time}` : ''
}

/** Desktop Ends cell: the time alone — the date is already in the Starts cell. */
export function fmtScheduleEnd(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  return parts(iso, tz)?.time ?? ''
}

/**
 * Mobile one-liner: "11th Aug 15:30 TO 16:30 Hall B".
 *
 * Partial schedules are real states, not bugs — docs/13 calls a session with a
 * time but no room (or vice versa) "pencilled" — so each piece is appended
 * only when present. Nothing set at all reads "Unscheduled" rather than going
 * blank, so the line never collapses and the row height stays stable.
 */
export function fmtScheduleSummary(
  startsAt: string | null | undefined,
  endsAt: string | null | undefined,
  roomName: string | null | undefined,
  tz: string,
): string {
  const bits: string[] = []
  const start = fmtScheduleStart(startsAt, tz)
  if (start) {
    const p = parts(startsAt as string, tz)
    bits.push(p ? `${ordinal(p.day)} ${p.month} ${p.time}` : start)
    const end = fmtScheduleEnd(endsAt, tz)
    if (end) bits.push(`TO ${end}`)
  }
  if (roomName) bits.push(roomName)
  return bits.length ? bits.join(' ') : 'Unscheduled'
}
