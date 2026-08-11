// Header-click sort advancement, extracted from DataList so the cycle logic
// is testable as pure logic (unit project). The default cycle for a sortable
// column is asc → desc → cleared. A column may instead declare an explicit
// `sortCycle` (workplan 13 W2: the Ratings header's first click sorts the
// score descending, the second sorts review_count ascending — the two sorts
// the doc calls the whole review UI), which advances entry by entry and then
// clears.

export interface SortStateLike {
  field: string | null
  direction: 'asc' | 'desc' | null
}

export interface SortCycleEntry {
  field: string
  direction: 'asc' | 'desc'
}

export function advanceSort(
  prev: SortStateLike,
  field: string,
  cycle?: SortCycleEntry[],
): SortStateLike {
  if (cycle && cycle.length > 0) {
    const index = cycle.findIndex((e) => e.field === prev.field && e.direction === prev.direction)
    if (index === -1) return { field: cycle[0].field, direction: cycle[0].direction }
    if (index === cycle.length - 1) return { field: null, direction: null }
    return { field: cycle[index + 1].field, direction: cycle[index + 1].direction }
  }
  if (prev.field !== field) return { field, direction: 'asc' }
  if (prev.direction === 'asc') return { field, direction: 'desc' }
  return { field: null, direction: null }
}
