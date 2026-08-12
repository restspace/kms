// Eval defect (no duplicate detection): pins the pure same-name matching rule
// behind the new-speaker form's advisory warning, without standing up a whole
// App render — same pattern as App.speakersHygiene.logic.test.ts.

import { describe, expect, it } from 'vitest'
import { hasSameNameContact } from './App'

describe('hasSameNameContact', () => {
  const rows = [
    { first_name: 'Priya', last_name: 'Raman' },
    { first_name: 'Marcus', last_name: 'Okafor' },
    { first_name: null, last_name: null },
  ]

  it('matches the same full name case-insensitively', () => {
    expect(hasSameNameContact(rows, 'Priya', 'Raman')).toBe(true)
    expect(hasSameNameContact(rows, 'priya', 'RAMAN')).toBe(true)
    expect(hasSameNameContact(rows, '  Priya ', ' Raman ')).toBe(true)
  })

  it('does not match a different or partial name', () => {
    expect(hasSameNameContact(rows, 'Priya', 'Okafor')).toBe(false)
    expect(hasSameNameContact(rows, 'Priya', '')).toBe(false)
    expect(hasSameNameContact(rows, '', 'Raman')).toBe(false)
  })

  it('never matches on an empty name (placeholder rows)', () => {
    expect(hasSameNameContact(rows, '', '')).toBe(false)
  })

  it('collapses whitespace runs inside names', () => {
    expect(hasSameNameContact([{ first_name: 'Priya  ', last_name: '  Raman' }], 'Priya', 'Raman')).toBe(true)
  })
})
