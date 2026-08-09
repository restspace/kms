/**
 * Date formatting for admin surfaces. The DB stores UTC instants; NFR-12 says
 * every date is rendered in the event timezone, not the viewer's.
 */
export function fmtDateInTz(iso: string | null | undefined, tz: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' })
}
