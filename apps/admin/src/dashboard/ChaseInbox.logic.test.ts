import { describe, expect, it } from 'vitest'
import { daysAgo, groupDraftsByContact } from './ChaseInbox'
import type { ChaseDraftRow } from '../api'

const draft = (over: Partial<ChaseDraftRow>): ChaseDraftRow => ({
  id: 'd-1',
  contact_id: 'c-1',
  contact_email: 'a@example.com',
  contact_name: 'Ada Speaker',
  subject_of: 'task',
  subject_id: null,
  rung: 'tool_email',
  status: 'staged',
  subject: 'subj',
  body: 'body',
  staged_at: new Date().toISOString(),
  acted_at: null,
  acted_by: null,
  ...over,
})

describe('daysAgo', () => {
  it('floors whole days elapsed since staging', () => {
    const now = Date.parse('2026-08-11T12:00:00Z')
    expect(daysAgo('2026-08-08T12:00:00Z', now)).toBe(3)
    expect(daysAgo('2026-08-11T06:00:00Z', now)).toBe(0)
  })

  it('never goes negative for a clock skewed staged_at', () => {
    const now = Date.parse('2026-08-11T12:00:00Z')
    expect(daysAgo('2026-08-12T12:00:00Z', now)).toBe(0)
  })
})

describe('groupDraftsByContact', () => {
  it('groups drafts under their contact, preserving first-seen order', () => {
    const items = [
      draft({ id: 'd-1', contact_id: 'c-1', contact_name: 'Ada' }),
      draft({ id: 'd-2', contact_id: 'c-2', contact_name: 'Bo' }),
      draft({ id: 'd-3', contact_id: 'c-1', contact_name: 'Ada' }),
    ]
    const groups = groupDraftsByContact(items)
    expect(groups.map((g) => g.contact_id)).toEqual(['c-1', 'c-2'])
    expect(groups[0].drafts.map((d) => d.id)).toEqual(['d-1', 'd-3'])
    expect(groups[1].drafts.map((d) => d.id)).toEqual(['d-2'])
  })

  it('returns an empty array for no drafts', () => {
    expect(groupDraftsByContact([])).toEqual([])
  })
})
