// Workplan 14 Wave B: pins the pure field-picker resolution rules behind the
// Duplicates panel's side-by-side merge editor, without a full render — the
// same pattern as App.duplicateName.logic.test.ts.

import { describe, expect, it } from 'vitest'
import type { DuplicateContact } from '../api'
import { conflictingMergeFields, resolveMergedValues } from './contactMerge'

const contact = (overrides: Partial<DuplicateContact>): DuplicateContact => ({
  id: 'c-1',
  email: 'a@example.com',
  first_name: 'Priya',
  last_name: 'Raman',
  salutation: null,
  honorific: null,
  pronouns: null,
  gender: null,
  mobile_phone: null,
  links: null,
  created_at: '2026-01-01T00:00:00Z',
  company: null,
  job_title: null,
  biography: null,
  event_count: 1,
  ...overrides,
})

describe('conflictingMergeFields', () => {
  it('lists only fields where both records carry differing non-blank values', () => {
    const a = contact({ email: 'a@example.com', company: 'Oldco', job_title: 'CTO' })
    const b = contact({ id: 'c-2', email: 'b@example.com', company: 'Newco', job_title: null })
    const fields = conflictingMergeFields(a, b).map((f) => f.field)
    expect(fields).toContain('email')
    expect(fields).toContain('company')
    // job_title has one blank side: no pick needed (server fills blanks).
    expect(fields).not.toContain('job_title')
    // Identical names conflict with nothing.
    expect(fields).not.toContain('first_name')
    expect(fields).not.toContain('last_name')
  })

  it('treats whitespace-only and equal-after-trim values as non-conflicting', () => {
    const a = contact({ company: ' Oldco ' })
    const b = contact({ id: 'c-2', email: 'b@example.com', company: 'Oldco' })
    expect(conflictingMergeFields(a, b).map((f) => f.field)).not.toContain('company')
  })
})

describe('resolveMergedValues', () => {
  const winner = contact({ email: 'w@example.com', company: 'WinnerCo', biography: null })
  const loser = contact({
    id: 'c-2',
    email: 'l@example.com',
    company: 'LoserCo',
    biography: 'Loser bio',
    job_title: 'CTO',
  })

  it('keeps the winner\'s value by default and takes the loser\'s only when picked', () => {
    const merged = resolveMergedValues(winner, loser, { company: 'loser' })
    expect(merged.company).toBe('LoserCo')
    expect(merged.email).toBe('w@example.com')
  })

  it('fills the winner\'s blanks from the loser without a pick — the server\'s rule', () => {
    const merged = resolveMergedValues(winner, loser, {})
    expect(merged.biography).toBe('Loser bio')
    expect(merged.job_title).toBe('CTO')
    expect(merged.company).toBe('WinnerCo')
  })

  it('a winner pick keeps the winner\'s value even when the loser also has one', () => {
    const merged = resolveMergedValues(winner, loser, { company: 'winner' })
    expect(merged.company).toBe('WinnerCo')
  })
})
