/**
 * Workplan 15 W1a — the decision-meeting slot counter above the submissions
 * grid. One chip per track carrying a target, plus the untracked remainder.
 *
 * Two things this pins beyond the arithmetic: D1 (over target is a colour, not
 * a refusal — the strip renders it in the error tone and there is no gate
 * anywhere in the component) and the rule that every count goes through the
 * same query endpoint with the same filters the grid is showing, so the strip
 * and the list cannot disagree.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'
import { useState } from 'react'

const api = vi.hoisted(() => ({
  listTracks: vi.fn(),
  getReviewLobby: vi.fn(),
  query: vi.fn(),
  queryResource: vi.fn(),
}))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  listTracks: api.listTracks,
  getReviewLobby: api.getReviewLobby,
  queryResource: api.queryResource,
}))

import { SubmissionsFilter } from './extras'

const track = (id: string, name: string, target: number | null) => ({
  id,
  event_id: 'evt-1',
  name,
  color: null,
  target_slots: target,
  position: 0,
})

/** Accepted-count fixture: Agents at target, Evals over it, plus four accepts
 * the targeted tracks do not account for. */
const TOTALS: Record<string, number> = { 'trk-agents': 12, 'trk-evals': 16, __all__: 32 }

beforeEach(() => {
  vi.clearAllMocks()
  api.getReviewLobby.mockResolvedValue({ items: [] })
  api.listTracks.mockResolvedValue({
    items: [track('trk-agents', 'Agents', 15), track('trk-evals', 'Evals', 15), track('trk-rag', 'RAG', null)],
  })
  api.query.mockImplementation((params: { filters: Record<string, unknown> }) =>
    Promise.resolve({
      items: [],
      total: TOTALS[(params.filters.track_id as string) ?? '__all__'] ?? 0,
    }),
  )
  api.queryResource.mockReturnValue(api.query)
})

function Harness({ initial = {} as Record<string, unknown> }) {
  const [filters, setFilters] = useState<Record<string, unknown>>({ status: '', ...initial })
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

describe('slot counter strip (W1a)', () => {
  it('renders a chip per targeted track and the untracked remainder', async () => {
    render(<Harness />)
    await screen.findByText('Agents 12/15')
    // 32 accepted in scope, 12 + 16 of them on a targeted track.
    await screen.findByText('Untracked 4')
    // A track with no target gets no chip at all — NULL is untracked.
    expect(screen.queryByText(/^RAG/)).toBeNull()
  })

  it('renders an over-target track in the error tone and blocks nothing (D1)', async () => {
    render(<Harness />)
    const over = await screen.findByText('Evals 16/15')
    expect(over.className).toContain('status-declined')
    const atTarget = screen.getByText('Agents 12/15')
    expect(atTarget.className).not.toContain('status-declined')
    // Nothing to dismiss, nothing refused: the strip is a read-only status.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.slot-counter')?.getAttribute('role')).toBe('status')
  })

  it('counts through the grid’s own filters, with its own status and track scope', async () => {
    render(<Harness initial={{ q: 'agents', status: 'pending', track_id: 'trk-rag' }} />)
    await screen.findByText('Agents 12/15')

    // The coverage bar next door queries the same resource; the strip's calls
    // are the ones carrying its own count definition.
    const filters = api.query.mock.calls
      .map((c) => (c[0] as { filters: Record<string, unknown> }).filters)
      .filter((f) => f.decision_accepted === true)
    expect(filters).toHaveLength(3)
    // The grid's search text is carried through — the strip is scoped exactly
    // like the list it sits above.
    expect(filters.every((f) => f.q === 'agents')).toBe(true)
    // …but the status it counts is its own (D2), and so is the track,
    // otherwise every chip would read the same one filtered number.
    expect(filters.every((f) => f.status === undefined)).toBe(true)
    expect(filters.map((f) => f.track_id)).toEqual([undefined, 'trk-agents', 'trk-evals'])
  })

  it('renders nothing at all when no track carries a target', async () => {
    api.listTracks.mockResolvedValue({ items: [track('trk-rag', 'RAG', null)] })
    render(<Harness />)
    await waitFor(() => expect(api.listTracks).toHaveBeenCalled())
    expect(document.querySelector('.slot-counter')).toBeNull()
  })
})
