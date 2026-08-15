// The Submissions list's schedule cells. The point of interest is that every
// value renders in the EVENT timezone (NFR-12) and that a half-scheduled row
// ("pencilled" — a time but no room, or a room but no time) still reads.
import { describe, expect, it } from 'vitest'
import { fmtScheduleEnd, fmtScheduleStart, fmtScheduleSummary } from './dates'

// 2026-08-11 15:30 in Europe/London == 14:30Z; 16:30 local == 15:30Z.
const START = '2026-08-11T14:30:00.000Z'
const END = '2026-08-11T15:30:00.000Z'
const LON = 'Europe/London'

describe('schedule cell formatting', () => {
  it('renders the start as day, month and 24h time in the event timezone', () => {
    expect(fmtScheduleStart(START, LON)).toBe('11 Aug 15:30')
    expect(fmtScheduleStart(START, 'UTC')).toBe('11 Aug 14:30')
  })

  it('renders the end as a bare time — the date is already in the Starts cell', () => {
    expect(fmtScheduleEnd(END, LON)).toBe('16:30')
  })

  it('collapses the three columns into one mobile line', () => {
    expect(fmtScheduleSummary(START, END, 'Hall B', LON)).toBe('11th Aug 15:30 TO 16:30 Hall B')
  })

  it('says Unscheduled rather than going blank when nothing is set', () => {
    expect(fmtScheduleSummary(null, null, null, LON)).toBe('Unscheduled')
  })

  it('keeps partial schedules readable', () => {
    expect(fmtScheduleSummary(START, null, 'Hall B', LON)).toBe('11th Aug 15:30 Hall B')
    expect(fmtScheduleSummary(null, null, 'Hall B', LON)).toBe('Hall B')
    expect(fmtScheduleSummary(START, END, null, LON)).toBe('11th Aug 15:30 TO 16:30')
  })

  it('gets the awkward ordinals right', () => {
    const at = (iso: string) => fmtScheduleSummary(iso, null, null, 'UTC')
    expect(at('2026-08-01T09:00:00.000Z')).toBe('1st Aug 09:00')
    expect(at('2026-08-02T09:00:00.000Z')).toBe('2nd Aug 09:00')
    expect(at('2026-08-03T09:00:00.000Z')).toBe('3rd Aug 09:00')
    expect(at('2026-08-11T09:00:00.000Z')).toBe('11th Aug 09:00')
    expect(at('2026-08-12T09:00:00.000Z')).toBe('12th Aug 09:00')
    expect(at('2026-08-13T09:00:00.000Z')).toBe('13th Aug 09:00')
    expect(at('2026-08-21T09:00:00.000Z')).toBe('21st Aug 09:00')
  })

  it('does not throw on an unparseable instant', () => {
    expect(fmtScheduleStart('not-a-date', LON)).toBe('')
    expect(fmtScheduleSummary('not-a-date', null, 'Hall B', LON)).toBe('Hall B')
  })
})
