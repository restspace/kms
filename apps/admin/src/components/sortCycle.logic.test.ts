// Workplan 13 W2 + the 2026-08-12 eval fix: the Ratings header's cycle is
// score desc → score asc → review_count asc (coverage worklist) → cleared,
// and the default asc → desc → cleared cycle. The rating-asc step exists
// because a second click on a sorted column universally reads as "reverse
// it" — jumping straight to the coverage sort made the column look broken.

import { describe, expect, it } from 'vitest'
import { advanceSort } from './sortCycle'

const RATING_CYCLE = [
  { field: 'rating', direction: 'desc' as const },
  { field: 'rating', direction: 'asc' as const },
  { field: 'review_count', direction: 'asc' as const },
]

describe('advanceSort — default cycle', () => {
  it('walks asc → desc → cleared on the same column', () => {
    const first = advanceSort({ field: null, direction: null }, 'title')
    expect(first).toEqual({ field: 'title', direction: 'asc' })
    const second = advanceSort(first, 'title')
    expect(second).toEqual({ field: 'title', direction: 'desc' })
    expect(advanceSort(second, 'title')).toEqual({ field: null, direction: null })
  })

  it('starts ascending when switching columns', () => {
    expect(advanceSort({ field: 'title', direction: 'desc' }, 'code')).toEqual({ field: 'code', direction: 'asc' })
  })
})

describe('advanceSort — explicit sortCycle (the Ratings header)', () => {
  it('first click is the decision-meeting agenda: score descending', () => {
    expect(advanceSort({ field: null, direction: null }, 'rating', RATING_CYCLE)).toEqual({
      field: 'rating',
      direction: 'desc',
    })
  })

  it('second click reverses to score ascending — never the coverage sort', () => {
    expect(advanceSort({ field: 'rating', direction: 'desc' }, 'rating', RATING_CYCLE)).toEqual({
      field: 'rating',
      direction: 'asc',
    })
  })

  it('third click is the coverage worklist: fewest ratings first', () => {
    expect(advanceSort({ field: 'rating', direction: 'asc' }, 'rating', RATING_CYCLE)).toEqual({
      field: 'review_count',
      direction: 'asc',
    })
  })

  it('fourth click clears the sort', () => {
    expect(advanceSort({ field: 'review_count', direction: 'asc' }, 'rating', RATING_CYCLE)).toEqual({
      field: null,
      direction: null,
    })
  })

  it('re-enters at the top when the active sort is some other column', () => {
    expect(advanceSort({ field: 'created_at', direction: 'desc' }, 'rating', RATING_CYCLE)).toEqual({
      field: 'rating',
      direction: 'desc',
    })
  })
})
