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
