/**
 * Workplan 15 W1b — "my top-ranked, not yet accepted", the reviewer's own
 * lobbying queue. Two surfaces over one endpoint: the panel on the review
 * screen and the collapsible rail on the Submissions tab.
 *
 * The order is the server's (the caller's own score, D3) and must be rendered
 * as given — sorting again client-side, by the mean sitting right beside it,
 * is exactly the mistake this feature exists to avoid.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/preact'

const api = vi.hoisted(() => ({ getReviewLobby: vi.fn() }))
const router = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  getReviewLobby: api.getReviewLobby,
}))
vi.mock('../router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../router')>()),
  navigate: router.navigate,
}))

import { LobbyPanel, LobbyRail } from './LobbyQueue'

const ROWS = [
  {
    id: 'sub-1',
    code: 'S-001',
    title: 'Designing for Doubt',
    status: 'pending',
    my_score: 5,
    submission_rating: 3,
    track_name: 'Agents',
    review_count: 3,
  },
  {
    id: 'sub-2',
    code: 'S-002',
    title: 'Evals in Anger',
    status: 'decline_queue',
    my_score: 2,
    submission_rating: 4.5,
    track_name: null,
    review_count: 2,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  api.getReviewLobby.mockResolvedValue({ items: ROWS })
})

describe('lobby queue (W1b)', () => {
  it('renders the server’s order — my score, not the mean beside it', async () => {
    render(<LobbyPanel />)
    await screen.findByText('My top-ranked, not yet accepted')
    const titles = Array.from(document.querySelectorAll('.lobby-title')).map((el) => el.textContent)
    expect(titles).toEqual(['S-001 — Designing for Doubt', 'S-002 — Evals in Anger'])
    expect(Array.from(document.querySelectorAll('.lobby-score')).map((el) => el.textContent)).toEqual(['5', '2'])
    expect(document.body.textContent).toContain('mean 3')
  })

  it('opens the record through the rec permalink', async () => {
    render(<LobbyPanel />)
    const row = await screen.findByText('S-001 — Designing for Doubt')
    ;(row.closest('button') as HTMLButtonElement).click()
    expect(router.navigate).toHaveBeenCalledWith({ v: 'workspace', tab: 'submissions', rec: 'sub-1' })
  })

  it('is a collapsed rail on the submissions tab, and absent for a non-reviewer', async () => {
    const { rerender } = render(<LobbyRail />)
    const summary = await screen.findByText('My top-ranked, not yet accepted (2)')
    expect((summary.closest('details') as HTMLDetailsElement).open).toBe(false)

    // Nobody with no scores of their own pays for any of this UI.
    api.getReviewLobby.mockResolvedValue({ items: [] })
    rerender(<LobbyRail key="empty" />)
    await vi.waitFor(() => expect(document.querySelectorAll('.lobby-rail')).toHaveLength(0))
  })
})
