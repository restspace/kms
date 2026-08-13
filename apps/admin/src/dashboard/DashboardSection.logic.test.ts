// Org-board event date range (defect: the Events table listed "May 12 – May
// 15" for an event whose sidebar and public day tabs correctly covered May
// 12 – May 14). The range must be the inclusive local-day span in the event's
// timezone — the same `eventDays` derivation the agenda and sidebar use — not
// the literal UTC dates of the stored instants.

import { describe, expect, it } from 'vitest'
import { fmtEventRange } from './DashboardSection'

describe('fmtEventRange', () => {
  it('renders the local final day, not the next UTC date, for a US event', () => {
    // Wed May 12 00:00 – Fri May 14 23:59:59 in Los Angeles: the end instant
    // sits on May 15 in UTC, but the event's last day is May 14.
    expect(
      fmtEventRange('2027-05-12T07:00:00.000Z', '2027-05-15T06:59:59.999Z', 'America/Los_Angeles'),
    ).toBe('May 12, 2027 – May 14, 2027')
  })

  it('renders the local first day for a timezone east of UTC', () => {
    // May 12 00:00 – May 14 23:59:59 in Tokyo: the start instant is still
    // May 11 in UTC.
    expect(
      fmtEventRange('2027-05-11T15:00:00.000Z', '2027-05-14T14:59:59.999Z', 'Asia/Tokyo'),
    ).toBe('May 12, 2027 – May 14, 2027')
  })

  it('collapses a single-day event to one date', () => {
    expect(
      fmtEventRange('2027-05-12T07:00:00.000Z', '2027-05-13T06:59:59.999Z', 'America/Los_Angeles'),
    ).toBe('May 12, 2027')
  })

  it('falls back to UTC days when the timezone is missing (stale cached payload)', () => {
    expect(
      fmtEventRange('2026-04-01T08:00:00Z', '2026-04-02T18:00:00Z', '' as string),
    ).toBe('Apr 1, 2026 – Apr 2, 2026')
  })

  it('does not throw on an unknown timezone id', () => {
    expect(
      fmtEventRange('2026-04-01T08:00:00Z', '2026-04-02T18:00:00Z', 'Not/AZone'),
    ).toBe('Apr 1, 2026 – Apr 2, 2026')
  })
})
