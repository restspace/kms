// Contacts-hygiene item 4 (workplan-4 cluster 3): the Speakers tab's default
// view must not surface a nameless "account-step stub" contact (submit.tsx's
// bare-email upsert — see isPlaceholderContact's doc comment in App.tsx for
// the full story). Pins the pure predicate without standing up a whole App
// render, same pattern as App.tasksStatusFilter.logic.test.ts.

import { describe, expect, it } from 'vitest'
import { isPlaceholderContact } from './App'

describe('isPlaceholderContact', () => {
  it('flags a contact with no first or last name', () => {
    expect(isPlaceholderContact({ first_name: null, last_name: null })).toBe(true)
    expect(isPlaceholderContact({ first_name: '', last_name: '' })).toBe(true)
    expect(isPlaceholderContact({ first_name: '   ', last_name: '  ' })).toBe(true)
  })

  it('does not flag a contact with at least one name part', () => {
    expect(isPlaceholderContact({ first_name: 'Priya', last_name: null })).toBe(false)
    expect(isPlaceholderContact({ first_name: null, last_name: 'Okafor' })).toBe(false)
    expect(isPlaceholderContact({ first_name: 'Priya', last_name: 'Raman' })).toBe(false)
  })
})
