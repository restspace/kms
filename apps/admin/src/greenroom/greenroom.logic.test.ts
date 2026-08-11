// Pure green-room derivations (workplan 12): now/next boundaries, event-local
// day bucketing across a timezone boundary, the opening-day pick, and phone
// href normalisation.

import { describe, expect, it } from 'vitest'
import type { GreenRoomSession } from '../api'
import { deriveNowNext, pickDay, telHref, timeLeftLabel, startsInLabel, windowByDay } from './logic'

const session = (over: Partial<GreenRoomSession>): GreenRoomSession => ({
  id: over.id ?? `s-${Math.random().toString(36).slice(2, 8)}`,
  code: 'SESS-1',
  title: 'A talk',
  format: null,
  track_name: null,
  room_id: 'room-a',
  starts_at: '2026-10-01T10:00:00Z',
  ends_at: '2026-10-01T11:00:00Z',
  speaker_ids: [],
  ...over,
})

const T = (iso: string) => Date.parse(iso)

describe('deriveNowNext', () => {
  const a = session({ id: 'a', starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T11:00:00Z' })
  const b = session({ id: 'b', starts_at: '2026-10-01T11:00:00Z', ends_at: '2026-10-01T12:00:00Z' })
  const c = session({ id: 'c', starts_at: '2026-10-01T14:00:00Z', ends_at: '2026-10-01T15:00:00Z' })
  const day = [a, b, c]

  it('is current from exactly its start', () => {
    const r = deriveNowNext(day, 'room-a', T('2026-10-01T10:00:00Z'))
    expect(r.current?.id).toBe('a')
    expect(r.next?.id).toBe('b')
    expect(r.later.map((s) => s.id)).toEqual(['c'])
  })

  it('hands over at the exact end: back-to-back sessions never overlap', () => {
    const r = deriveNowNext(day, 'room-a', T('2026-10-01T11:00:00Z'))
    expect(r.current?.id).toBe('b') // a has ended (now < ends is exclusive), b has begun
    expect(r.next?.id).toBe('c')
  })

  it('shows a gap as no current session', () => {
    const r = deriveNowNext(day, 'room-a', T('2026-10-01T13:00:00Z'))
    expect(r.current).toBeNull()
    expect(r.next?.id).toBe('c')
    expect(r.later).toEqual([])
  })

  it('the latest start wins an overlap (a lightning talk inside a block)', () => {
    const block = session({ id: 'block', starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T12:00:00Z' })
    const lightning = session({ id: 'l', starts_at: '2026-10-01T10:30:00Z', ends_at: '2026-10-01T10:40:00Z' })
    const r = deriveNowNext([block, lightning], 'room-a', T('2026-10-01T10:35:00Z'))
    expect(r.current?.id).toBe('l')
  })

  it('ignores other rooms and treats a missing ends_at as an hour', () => {
    const other = session({ id: 'o', room_id: 'room-b' })
    const openEnded = session({ id: 'open', ends_at: null })
    const r = deriveNowNext([other, openEnded], 'room-a', T('2026-10-01T10:59:00Z'))
    expect(r.current?.id).toBe('open')
    expect(deriveNowNext([openEnded], 'room-a', T('2026-10-01T11:01:00Z')).current).toBeNull()
  })
})

describe('windowByDay', () => {
  it('buckets by the EVENT-local day, not UTC', () => {
    // 02:00 UTC on Oct 2 is still Oct 1 in Los Angeles (UTC-7).
    const evening = session({ id: 'e', starts_at: '2026-10-02T02:00:00Z', ends_at: '2026-10-02T03:00:00Z' })
    const morning = session({ id: 'm', starts_at: '2026-10-02T16:00:00Z', ends_at: '2026-10-02T17:00:00Z' })
    const byDay = windowByDay([morning, evening], 'America/Los_Angeles')
    expect([...byDay.keys()]).toEqual(['2026-10-01', '2026-10-02'])
    expect(byDay.get('2026-10-01')?.map((s) => s.id)).toEqual(['e'])
    const utc = windowByDay([evening], 'UTC')
    expect([...utc.keys()]).toEqual(['2026-10-02'])
  })

  it('sorts each day by start time', () => {
    const late = session({ id: 'late', starts_at: '2026-10-01T15:00:00Z' })
    const early = session({ id: 'early', starts_at: '2026-10-01T09:00:00Z' })
    const byDay = windowByDay([late, early], 'UTC')
    expect(byDay.get('2026-10-01')?.map((s) => s.id)).toEqual(['early', 'late'])
  })
})

describe('pickDay', () => {
  const days = ['2026-10-01', '2026-10-02', '2026-10-03']
  it('prefers today when it has sessions', () => {
    expect(pickDay(days, '2026-10-02')).toBe('2026-10-02')
  })
  it('falls forward to the first future day before the event', () => {
    expect(pickDay(days, '2026-09-20')).toBe('2026-10-01')
  })
  it('falls back to the last day after the event', () => {
    expect(pickDay(days, '2026-10-09')).toBe('2026-10-03')
  })
  it('is null with nothing scheduled', () => {
    expect(pickDay([], '2026-10-01')).toBeNull()
  })
})

describe('telHref', () => {
  it('normalises formatted numbers', () => {
    expect(telHref('+1 (123)456-7891')).toBe('tel:+11234567891')
  })
  it('passes bare digits through', () => {
    expect(telHref('07700900123')).toBe('tel:07700900123')
  })
  it('rejects null, empty and junk-only values', () => {
    expect(telHref(null)).toBeNull()
    expect(telHref('')).toBeNull()
    expect(telHref('n/a')).toBeNull()
  })
})

describe('countdown labels', () => {
  const s = session({ starts_at: '2026-10-01T10:00:00Z', ends_at: '2026-10-01T11:00:00Z' })
  it('time left', () => {
    expect(timeLeftLabel(s, T('2026-10-01T10:22:00Z'))).toBe('38 min left')
    expect(timeLeftLabel(s, T('2026-10-01T10:59:30Z'))).toBe('ending now')
  })
  it('starts in', () => {
    expect(startsInLabel(s, T('2026-10-01T09:48:00Z'))).toBe('in 12 min')
    expect(startsInLabel(s, T('2026-10-01T07:55:00Z'))).toBe('in 2 h 05')
    expect(startsInLabel(s, T('2026-10-01T09:59:30Z'))).toBe('starting now')
  })
})
