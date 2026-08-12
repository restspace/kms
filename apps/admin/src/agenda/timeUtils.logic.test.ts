// Day-list computation for the agenda builder (docs/07 §2), pinned against
// the eval-reported off-by-one: an event configured for calendar days
// May 12–14 must show exactly those three days regardless of which side of
// UTC the event's timezone sits on. See AgendaSection.tsx (`days = useMemo`)
// and dialogs.tsx (Move dialog's date <select>), both of which consume
// `eventDays()` — fixing it here fixes those call sites too.

import { describe, expect, it } from 'vitest'
import { classifySchedule, eventDays, formatMinutes, localToUtc, utcToLocal, formatEventDateRange } from './timeUtils'

describe('eventDays', () => {
  it('a US-timezone (west of UTC) event spanning local May 12–14 yields exactly those three days', () => {
    // Local midnight May 12 in America/Los_Angeles (PDT, UTC-7) is
    // 2027-05-12T07:00:00Z; local end-of-day May 14 is one tick before the
    // next local midnight, 2027-05-15T06:59:59.999Z.
    const days = eventDays('2027-05-12T07:00:00.000Z', '2027-05-15T06:59:59.999Z', 'America/Los_Angeles')
    expect(days).toEqual(['2027-05-12', '2027-05-13', '2027-05-14'])
  })

  it('an east-of-UTC event (Asia/Tokyo, UTC+9) spanning local May 12–14 also yields exactly those three days', () => {
    // Local midnight May 12 in Tokyo is 2027-05-11T15:00:00Z; local
    // end-of-day May 14 is 2027-05-14T14:59:59.999Z.
    const days = eventDays('2027-05-11T15:00:00.000Z', '2027-05-14T14:59:59.999Z', 'Asia/Tokyo')
    expect(days).toEqual(['2027-05-12', '2027-05-13', '2027-05-14'])
  })

  it('handles a bare YYYY-MM-DD start/end (no time component) without shifting a day early', () => {
    // Regression for the exact eval repro: naively running a bare date
    // through `new Date()` parses it as UTC midnight, which lands one day
    // early once rendered in a timezone west of UTC (May 11/12/13 instead
    // of May 12/13/14).
    const days = eventDays('2027-05-12', '2027-05-14', 'America/Los_Angeles')
    expect(days).toEqual(['2027-05-12', '2027-05-13', '2027-05-14'])
  })

  it('a single-day event yields one day', () => {
    const days = eventDays('2027-05-12T07:00:00.000Z', '2027-05-13T06:59:59.999Z', 'America/Los_Angeles')
    expect(days).toEqual(['2027-05-12'])
  })

  it('round-trips through localToUtc/utcToLocal for the same event window', () => {
    // The default-selected-day + Move-dialog dropdown both key off the same
    // (day, minutes) pairs `localToUtc` produces — confirm the pairing is
    // internally consistent for a timezone on each side of UTC.
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
      const iso = localToUtc('2027-05-14', 9 * 60, tz)
      expect(utcToLocal(iso, tz)).toEqual({ day: '2027-05-14', minutes: 9 * 60 })
    }
  })
})

describe('formatEventDateRange', () => {
  it('formats a multi-day event with midnight-exclusive ends_at (typical case)', () => {
    // An event on May 12–14 (inclusive, in LA time) has ends_at at midnight
    // UTC of May 15 (exclusive). Should display as "May 12 – May 14".
    const range = formatEventDateRange(
      '2027-05-12T07:00:00.000Z',
      '2027-05-15T06:59:59.999Z',
      'America/Los_Angeles'
    )
    expect(range).toMatch(/May 12.*May 14/)
  })

  it('formats a multi-day event with mid-day ends_at', () => {
    // An event ending mid-day on Oct 14 at 10 PM UTC.
    const range = formatEventDateRange(
      '2026-10-12T13:00:00Z',
      '2026-10-14T22:00:00Z',
      'America/Los_Angeles'
    )
    expect(range).toMatch(/Oct 12.*Oct 14/)
  })

  it('formats a single-day event', () => {
    // An event on May 12 only (in LA time).
    const range = formatEventDateRange(
      '2027-05-12T07:00:00.000Z',
      '2027-05-13T06:59:59.999Z',
      'America/Los_Angeles'
    )
    expect(range).toMatch(/May 12/)
    expect(range).not.toMatch(/–/) // No range separator for single-day events
  })

  it('formats an event in a timezone east of UTC', () => {
    // Same event (May 12–14) but in Tokyo time.
    const range = formatEventDateRange(
      '2027-05-11T15:00:00.000Z',
      '2027-05-14T14:59:59.999Z',
      'Asia/Tokyo'
    )
    expect(range).toMatch(/May 12.*May 14/)
  })

  it('handles bare date format (no time component)', () => {
    // Bare dates like "2027-05-12" should work too.
    const range = formatEventDateRange(
      '2027-05-12',
      '2027-05-14',
      'America/Los_Angeles'
    )
    expect(range).toMatch(/May 12.*May 14/)
  })

  it('returns empty string when inputs are null or undefined', () => {
    // Edge case: handles null/undefined gracefully
    expect(formatEventDateRange(null, null, 'America/Los_Angeles')).toBe('')
    expect(formatEventDateRange(undefined, undefined, 'America/Los_Angeles')).toBe('')
    expect(formatEventDateRange('2027-05-12T07:00:00Z', null, 'America/Los_Angeles')).toBe('')
  })
})

describe('classifySchedule', () => {
  it('is "tray" when neither time nor room is set', () => {
    expect(classifySchedule({ starts_at: null, room_id: null })).toBe('tray')
  })

  it('is "pencilled" when time is set with no room', () => {
    expect(classifySchedule({ starts_at: '2027-05-12T09:00:00.000Z', room_id: null })).toBe('pencilled')
  })

  it('is "pencilled" when room is set with no time', () => {
    expect(classifySchedule({ starts_at: null, room_id: 'room-a' })).toBe('pencilled')
  })

  it('is "placed" when both time and room are set', () => {
    expect(classifySchedule({ starts_at: '2027-05-12T09:00:00.000Z', room_id: 'room-a' })).toBe('placed')
  })
})

describe('formatMinutes', () => {
  it('reads an explicit "(N min)" out of the format label (eval defect: Lightning Talk (10 min) placed as 30)', () => {
    expect(formatMinutes('Lightning Talk (10 min)')).toBe(10)
    expect(formatMinutes('Deep Dive – 75 minutes')).toBe(75)
    expect(formatMinutes('45-min briefing')).toBe(45)
  })

  it('falls back to the known format defaults, case-insensitively and as a prefix', () => {
    expect(formatMinutes('Workshop')).toBe(90)
    expect(formatMinutes('workshop — hands on')).toBe(90)
    expect(formatMinutes('Lightning Talk')).toBe(10)
    expect(formatMinutes('Featured Keynote')).toBe(45)
  })

  it('returns null when the format says nothing about duration', () => {
    expect(formatMinutes(null)).toBeNull()
    expect(formatMinutes(undefined)).toBeNull()
    expect(formatMinutes('Fireside Chat')).toBeNull()
  })

  it('prefers the explicit minutes over the family default', () => {
    expect(formatMinutes('Workshop (120 min)')).toBe(120)
  })
})
