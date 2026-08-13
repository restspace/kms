/**
 * The Materials panel (workplan 15 W5c) — the Speaker Tracking board's answer
 * to the document's two questions: *whose deck have I not seen* and *who owes
 * me a v2*, plus the line in front of both (accepted, nothing uploaded).
 *
 * The claim under test is the one that makes the panel readable as a whole:
 * every accepted talk is in exactly one bucket, so the three worklists and the
 * settled remainder add up to the accepted total. A panel whose counts did not
 * partition would send an organiser hunting for the missing decks.
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/preact'
import { MaterialsPanel } from './DashboardSection'
import type { DashboardPayload, MaterialsRow } from '../api'

const row = (id: string, overrides: Partial<MaterialsRow> = {}): MaterialsRow => ({
  submission_id: id,
  code: id.toUpperCase(),
  title: `Talk ${id}`,
  contact_id: `c-${id}`,
  name: 'Priya Raman',
  owner_name: null,
  days_since_request: null,
  ...overrides,
})

const payload = (materials: DashboardPayload['tracking']['materials']) =>
  ({ tracking: { materials } } as unknown as DashboardPayload)

describe('MaterialsPanel (W5c)', () => {
  it('lists the three questions and partitions the accepted set', () => {
    const data = payload({
      accepted_total: 6,
      settled: 2,
      awaiting_upload: [row('a')],
      not_seen: [row('b'), row('c')],
      owes_v2: [row('d', { days_since_request: 11 })],
    })
    render(<MaterialsPanel data={data} onNavigate={vi.fn()} onSpeaker={vi.fn()} />)

    expect(screen.getByText('Deck not yet seen')).toBeTruthy()
    expect(screen.getByText('Owes a v2')).toBeTruthy()
    expect(screen.getByText('No deck at all')).toBeTruthy()

    // Days since the request is the "who owes me a v2" sort key, so it shows.
    expect(screen.getByText('11 days')).toBeTruthy()

    // 1 + 2 + 1 + 2 settled = the 6 accepted talks, stated on the panel.
    const summary = screen.getByText(/6 accepted talks/)
    expect(summary.textContent).toContain('1 with nothing on file')
    expect(summary.textContent).toContain('2 awaiting a first read')
    expect(summary.textContent).toContain('1 owing a revision')
    expect(summary.textContent).toContain('2 reviewed or final')
  })

  it('deep-links each count into the submissions grid on its own filter', () => {
    const onNavigate = vi.fn()
    const data = payload({
      accepted_total: 1,
      settled: 0,
      awaiting_upload: [],
      not_seen: [],
      owes_v2: [row('d', { days_since_request: 3 })],
    })
    render(<MaterialsPanel data={data} onNavigate={onNavigate} onSpeaker={vi.fn()} />)

    // The count beside "Owes a v2" is the click target; the seed it carries is
    // the panel's own filter, so the grid it opens cannot disagree with it.
    const heading = screen.getByText('Owes a v2').closest('.db-card-head') as HTMLElement
    ;(heading.querySelector('button') as HTMLButtonElement).click()

    expect(onNavigate).toHaveBeenCalledWith(
      expect.objectContaining({
        view: 'workspace',
        tab: 'submissions',
        seedFilters: { submissions: { status: 'accepted', materials_state: 'revision_requested' } },
      }),
    )
  })

  it('renders nothing for a payload from a deploy without the block', () => {
    const { container } = render(
      <MaterialsPanel data={{ tracking: {} } as unknown as DashboardPayload} onNavigate={vi.fn()} onSpeaker={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })
})
