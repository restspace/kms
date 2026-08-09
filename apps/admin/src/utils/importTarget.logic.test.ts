import { describe, expect, it } from 'vitest'
import { resolveTargetEventId } from './importTarget'

describe('resolveTargetEventId', () => {
  it('uses the sidebar event scope when the tab filters carry no event', () => {
    // D3 regression: the picker sets `eventFilterId` only — the grid's own
    // filter object never sees `event_id`, so the import guard used to fire
    // even with a single event selected.
    expect(resolveTargetEventId('evt_123', { status: 'pending' })).toBe('evt_123')
  })

  it('prefers an explicit event_id filter over the sidebar scope', () => {
    expect(resolveTargetEventId('evt_123', { event_id: 'evt_other' })).toBe('evt_other')
  })

  it('returns null on "All events" with no event filter', () => {
    expect(resolveTargetEventId(null, { status: '' })).toBeNull()
    expect(resolveTargetEventId(null, undefined)).toBeNull()
  })

  it('ignores blank and non-string values', () => {
    expect(resolveTargetEventId('  ', { event_id: '' })).toBeNull()
    expect(resolveTargetEventId(null, { event_id: 42 })).toBeNull()
  })
})
