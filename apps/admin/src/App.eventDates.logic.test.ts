/**
 * Replay defect #6's workspace sibling: the Events tab rendered
 * `fmtDate(starts_at) – fmtDate(ends_at)` in the VIEWER's timezone with no
 * event timezone, so an event ending late on its final local day (ends_at is
 * an instant, often 23:59 local = next day UTC) displayed as ending a day
 * later. `fmtEventListRange` derives the same event-local inclusive day span
 * the dashboard's fmtEventRange and the sidebar use via eventDays.
 */
import { describe, expect, it } from 'vitest'
import { fmtEventListRange } from './App'

describe('fmtEventListRange', () => {
  it('renders the event-local final day, not the UTC date of the ends_at instant', () => {
    // May 12 09:00 – May 14 23:59 in Los Angeles: ends_at lands on May 15 UTC.
    const text = fmtEventListRange({
      starts_at: '2027-05-12T16:00:00Z',
      ends_at: '2027-05-15T06:59:00Z',
      timezone: 'America/Los_Angeles',
    })
    expect(text).toBe('May 12, 2027 – May 14, 2027')
  })

  it('collapses a one-day event to a single date', () => {
    const text = fmtEventListRange({
      starts_at: '2027-05-12T16:00:00Z',
      ends_at: '2027-05-13T02:00:00Z',
      timezone: 'America/Los_Angeles',
    })
    expect(text).toBe('May 12, 2027')
  })

  it('treats a missing timezone as UTC rather than the viewer clock', () => {
    const text = fmtEventListRange({
      starts_at: '2027-05-12T00:00:00Z',
      ends_at: '2027-05-14T23:00:00Z',
      timezone: null,
    })
    expect(text).toBe('May 12, 2027 – May 14, 2027')
  })

  it('falls back to the literal instants when the timezone id is unusable', () => {
    const text = fmtEventListRange({
      starts_at: '2027-05-12T16:00:00Z',
      ends_at: '2027-05-15T06:59:00Z',
      timezone: 'Not/AZone',
    })
    // Viewer-timezone fallback — only pin that it produced a range at all.
    expect(text).toContain('–')
    expect(text).toContain('2027')
  })
})
