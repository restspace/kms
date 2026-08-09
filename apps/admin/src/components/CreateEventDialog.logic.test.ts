import { describe, expect, it } from 'vitest'
import { slugify } from './CreateEventDialog'

/**
 * Pure half of the Create Event dialog (FR-EVT-1/2): the name → slug
 * auto-suggest. Runs in the `unit` project — no DOM, no dialog mount.
 */
describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('DevOps Summit 2026')).toBe('devops-summit-2026')
  })

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(slugify('Foo & Bar / Baz!!')).toBe('foo-bar-baz')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --Launch Day--  ')).toBe('launch-day')
  })

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(80)
    expect(slugify(long)).toHaveLength(64)
  })

  it('returns an empty string for input with no alphanumeric characters', () => {
    expect(slugify('*** ///')).toBe('')
  })
})
