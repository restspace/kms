/**
 * The Submissions tab's tag filter. The `tag_id` filter has been on the
 * submissions resource since M3 with nothing in the UI setting it; this pins
 * the control that does, including that clearing it REMOVES the key rather
 * than setting it empty (an empty tag_id would be a filter the server ignores
 * but the URL and the Clear Filters comparison still carry).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'
import { useState } from 'react'

// @testing-library/preact rewrites fireEvent.change to an input event under
// preact/compat, which a <select>'s onChange never sees — dispatch directly
// (same idiom as App.speakerStatusControl.test.tsx).
const pickOption = (select: HTMLSelectElement, value: string) => {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

const api = vi.hoisted(() => ({
  listTracks: vi.fn(),
  listTags: vi.fn(),
  getReviewLobby: vi.fn(),
  query: vi.fn(),
  queryResource: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listTracks: api.listTracks,
  listTags: api.listTags,
  getReviewLobby: api.getReviewLobby,
  queryResource: api.queryResource,
}))

import { SubmissionsFilter } from './extras'

beforeEach(() => {
  vi.clearAllMocks()
  api.getReviewLobby.mockResolvedValue({ items: [] })
  api.listTracks.mockResolvedValue({ items: [] })
  api.query.mockResolvedValue({ items: [], total: 0 })
  api.queryResource.mockReturnValue(api.query)
  api.listTags.mockResolvedValue({
    items: [
      { id: 'tag-av', event_id: 'evt-1', name: 'needs AV', color: null },
      { id: 'tag-new', event_id: 'evt-1', name: 'first-timer', color: '#ff8800' },
    ],
  })
})

let latest: Record<string, unknown> = {}

function Harness({ initial = {} as Record<string, unknown> }) {
  const [filters, setFilters] = useState<Record<string, unknown>>({ status: '', ...initial })
  latest = filters
  return (
    <SubmissionsFilter
      filters={filters}
      setFilters={(next) =>
        setFilters((prev) =>
          typeof next === 'function' ? (next as (p: Record<string, unknown>) => Record<string, unknown>)(prev) : next,
        )
      }
      resetFilters={() => setFilters({ status: '' })}
    />
  )
}

describe('Submissions tag filter', () => {
  it('offers the event vocabulary and sets tag_id', async () => {
    render(<Harness />)
    const select = (await screen.findByLabelText('Tag filter')) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['All tags', 'needs AV', 'first-timer'])

    pickOption(select, 'tag-av')
    await waitFor(() => expect(latest.tag_id).toBe('tag-av'))
  })

  it('removes the key rather than emptying it when set back to All tags', async () => {
    render(<Harness initial={{ tag_id: 'tag-av' }} />)
    const select = (await screen.findByLabelText('Tag filter')) as HTMLSelectElement
    expect(select.value).toBe('tag-av')

    pickOption(select, '')
    await waitFor(() => expect('tag_id' in latest).toBe(false))
  })

  it('renders no control at all on an event with no tags', async () => {
    api.listTags.mockResolvedValue({ items: [] })
    render(<Harness />)
    // The status chips are the marker that the row itself did render.
    await screen.findByRole('group', { name: 'Review coverage filter' })
    expect(screen.queryByLabelText('Tag filter')).toBeNull()
  })
})
