// CRM-09: pins the save-payload builder — curated when rows are checked,
// dynamic (empty filter values stripped) otherwise.

import { describe, expect, it } from 'vitest'
import { buildSegmentSavePayload, stripEmptyFilters } from './segments.logic'

describe('stripEmptyFilters', () => {
  it('drops null/undefined/empty-string values, keeps everything else', () => {
    expect(
      stripEmptyFilters({ confirmation: 'confirmed', q: '', missing_assets: null, track_id: undefined, x: false }),
    ).toEqual({ confirmation: 'confirmed', x: false })
  })
})

describe('buildSegmentSavePayload', () => {
  it('builds a curated segment (member_ids) when rows are checked, ignoring the live filters', () => {
    const payload = buildSegmentSavePayload('VIPs', { confirmation: 'confirmed' }, ['c-1', 'c-2'])
    expect(payload).toEqual({ name: 'VIPs', kind: 'curated', member_ids: ['c-1', 'c-2'] })
  })

  it('builds a dynamic segment (stripped filters) when nothing is checked', () => {
    const payload = buildSegmentSavePayload('Confirmed only', { confirmation: 'confirmed', q: '' }, [])
    expect(payload).toEqual({ name: 'Confirmed only', kind: 'dynamic', filters: { confirmation: 'confirmed' } })
  })

  it('trims the name', () => {
    const payload = buildSegmentSavePayload('  Spaced  ', {}, [])
    expect(payload.name).toBe('Spaced')
  })
})
