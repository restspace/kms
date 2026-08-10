/**
 * The submission detail tab has to be actionable, not read-only (lane M1).
 *
 * A single row click is now the primary path into a submission, and it opens
 * `SubmissionDetailPanel`. Everything an organiser needs first used to live in
 * `SubmissionEditForm`, reachable only by a row *double*-click — which an
 * automated eval agent never found in a 150-turn budget, producing three
 * separate "the feature does not exist" defects:
 *
 *  - AIA-04: no UI anywhere to link a speaker/participant to a submission
 *    (the detail panel showed a bare "Participants" heading, no add control).
 *  - CNT-12: content_approved editable only on the creation form.
 *  - CNT-09: title/abstract editing never located at all.
 *
 * These tests pin the three fixes: the Edit button, the in-panel participant
 * add/remove, and the persisted public-visibility toggle.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

/**
 * preact/compat routes `onChange` to the native `input` event for text fields
 * and to `change` for selects; firing both keeps the helper indifferent.
 */
const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  updateSubmission: vi.fn(),
  updateSubmissionStatus: vi.fn(),
  updateSubmissionNotes: vi.fn(),
  addSubmissionParticipant: vi.fn(),
  removeSubmissionParticipant: vi.fn(),
  updateSubmissionParticipantRole: vi.fn(),
  setSubmissionParticipantConfirmed: vi.fn(),
  contactSearch: vi.fn(),
}))

vi.mock('../api', () => ({
  PARTICIPANT_ROLES: ['speaker', 'co-speaker', 'moderator', 'panelist', 'co-author', 'co-presenter'],
  getSubmissionDetail: api.getSubmissionDetail,
  updateSubmission: api.updateSubmission,
  updateSubmissionStatus: api.updateSubmissionStatus,
  updateSubmissionNotes: api.updateSubmissionNotes,
  addSubmissionParticipant: api.addSubmissionParticipant,
  removeSubmissionParticipant: api.removeSubmissionParticipant,
  updateSubmissionParticipantRole: api.updateSubmissionParticipantRole,
  setSubmissionParticipantConfirmed: api.setSubmissionParticipantConfirmed,
  queryResource: () => api.contactSearch,
  listTracks: async () => ({ items: [] }),
  listRooms: async () => ({ items: [] }),
}))

// The files sub-panel does its own fetching and is not under test here.
vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  appAlert: async () => undefined,
}))

import { SubmissionDetailPanel } from './extras'

const PARTICIPANT = {
  participant_id: 'sp-1',
  role: 'speaker',
  is_primary_contact: 1,
  confirmed_at: null,
  contact_id: 'c-1',
  first_name: 'Priya',
  last_name: 'Raman',
  email: 'priya@example.com',
  has_bio: 1,
  has_headshot: 0,
  headshot_asset_id: null,
}

const detail = (
  overrides: Record<string, unknown> = {},
  participants = [PARTICIPANT],
  reviews: Array<Record<string, unknown>> = [],
  review_plan_means: Array<{ plan_id: string; plan_name: string | null; mean: number; count: number }> = [],
) => ({
  submission: {
    id: 'sub-1',
    code: 'S-001',
    title: 'Designing for Doubt',
    status: 'pending',
    content_approved: 1,
    created_at: '2026-01-05T10:00:00Z',
    notified_at: null,
    notes: null,
    form_name: 'Main CFP',
    ...overrides,
  },
  answers: [],
  participants,
  reviews,
  review_plan_means,
  tags: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  api.getSubmissionDetail.mockResolvedValue(detail())
  api.updateSubmission.mockResolvedValue({ ok: true })
  api.updateSubmissionStatus.mockResolvedValue({ ok: true })
  api.addSubmissionParticipant.mockResolvedValue({ ok: true, id: 'sp-2' })
  api.removeSubmissionParticipant.mockResolvedValue({ ok: true })
  api.contactSearch.mockResolvedValue({ items: [], total: 0 })
})

describe('SubmissionDetailPanel — edit affordance (CNT-09)', () => {
  it('renders an Edit button that opens the edit form', async () => {
    const onEdit = vi.fn()
    render(<SubmissionDetailPanel id="sub-1" onEdit={onEdit} />)

    const button = await screen.findByRole('button', { name: /edit submission/i })
    button.click()

    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('omits the button in read-only hosts that pass no onEdit', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    await screen.findByText(/Designing for Doubt/)
    expect(screen.queryByRole('button', { name: /edit submission/i })).toBeNull()
  })
})

describe('SubmissionDetailPanel — participants (AIA-04)', () => {
  it('adds a searched contact to the submission and refreshes the list', async () => {
    api.contactSearch.mockResolvedValue({
      items: [{ id: 'c-2', first_name: 'Sam', last_name: 'Okafor', email: 'sam@example.com' }],
      total: 1,
    })
    render(<SubmissionDetailPanel id="sub-1" />)

    const search = (await screen.findByLabelText('Add participant')) as HTMLInputElement
    setValue(screen.getByLabelText('Role to add') as HTMLSelectElement, 'moderator')
    setValue(search, 'sam')

    const result = await screen.findByRole('button', { name: /Sam Okafor/ })

    // The refreshed read shows the new participant.
    api.getSubmissionDetail.mockResolvedValue(
      detail({}, [
        PARTICIPANT,
        { ...PARTICIPANT, participant_id: 'sp-2', contact_id: 'c-2', first_name: 'Sam', last_name: 'Okafor', email: 'sam@example.com', role: 'moderator', is_primary_contact: 0 },
      ]),
    )
    result.click()

    await waitFor(() =>
      expect(api.addSubmissionParticipant).toHaveBeenCalledWith('sub-1', {
        contact_id: 'c-2',
        role: 'moderator',
      }),
    )
    await screen.findByText('Sam Okafor')
  })

  it('removes a participant and refreshes the list', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    const remove = await screen.findByRole('button', { name: 'Remove' })

    api.getSubmissionDetail.mockResolvedValue(detail({}, []))
    remove.click()

    await waitFor(() => expect(api.removeSubmissionParticipant).toHaveBeenCalledWith('sub-1', 'sp-1'))
    await screen.findByText('No participants yet.')
  })
})

describe('SubmissionDetailPanel — reviews grouped by round (aggregate rating mixes independent rounds)', () => {
  it('groups reviews under a round heading with a per-round mean, alongside the pooled header rating', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detail(
        {},
        [PARTICIPANT],
        [
          { reviewer_name: 'Ada Lovelace', weighted_total: 5, comment: null, conflict_of_interest: 0, plan_id: 'plan-a', plan_name: 'Screening Round' },
          { reviewer_name: 'Grace Hopper', weighted_total: 4, comment: null, conflict_of_interest: 0, plan_id: 'plan-a', plan_name: 'Screening Round' },
          { reviewer_name: 'Alan Turing', weighted_total: 2, comment: null, conflict_of_interest: 0, plan_id: 'plan-b', plan_name: 'Final Round' },
        ],
        [
          { plan_id: 'plan-a', plan_name: 'Screening Round', mean: 4.5, count: 2 },
          { plan_id: 'plan-b', plan_name: 'Final Round', mean: 2, count: 1 },
        ],
      ),
    )
    render(<SubmissionDetailPanel id="sub-1" />)

    await screen.findByText('Screening Round')
    await screen.findByText('Final Round')

    // Each round shows its own reviewers under its own heading.
    const screeningHeading = screen.getByText('Screening Round').closest('.review-plan-heading') as HTMLElement
    const screeningGroup = screeningHeading.closest('.review-plan-group') as HTMLElement
    expect(screeningGroup.textContent).toContain('Ada Lovelace')
    expect(screeningGroup.textContent).toContain('Grace Hopper')
    expect(screeningGroup.textContent).not.toContain('Alan Turing')

    const finalHeading = screen.getByText('Final Round').closest('.review-plan-heading') as HTMLElement
    const finalGroup = finalHeading.closest('.review-plan-group') as HTMLElement
    expect(finalGroup.textContent).toContain('Alan Turing')

    // Per-round means are both visible (not just the pooled header ★).
    expect(screeningGroup.textContent).toContain('4.5')
    expect(finalGroup.textContent).toContain('★ 2')

    // The header still shows the pooled mean across all rounds (5+4+2)/3 = 3.67 —
    // the deliberate pooled aggregate this task must NOT undo.
    await screen.findByText('★ 3.67')
  })
})

describe('SubmissionDetailPanel — Title/Description/Format/Track dedup (stale-answer fix)', () => {
  it('shows the canonical column once and drops the frozen answer, including after an edit', async () => {
    // Answers as they'd be frozen at submit time — some now stale relative
    // to the columns above, one ("Audience") unrelated and still current.
    api.getSubmissionDetail.mockResolvedValue({
      ...detail({ format: 'Talk', track_name: 'Engineering', description: 'Fresh description' }, [PARTICIPANT]),
      answers: [
        { label: 'Title', value_json: JSON.stringify('Old Title') },
        { label: 'Description', value_json: JSON.stringify('Old description') },
        { label: 'Format', value_json: JSON.stringify('Workshop') },
        { label: 'Track', value_json: JSON.stringify('Old Track') },
        { label: 'Audience', value_json: JSON.stringify('Beginners') },
      ],
    })

    render(<SubmissionDetailPanel id="sub-1" />)

    await screen.findByText('Designing for Doubt')

    // Canonical values render, each exactly once.
    expect(screen.getAllByText('Talk')).toHaveLength(1)
    expect(screen.getAllByText('Engineering')).toHaveLength(1)
    expect(screen.getAllByText('Fresh description')).toHaveLength(1)

    // The frozen answer text for the deduped labels never appears.
    expect(screen.queryByText('Old Title')).toBeNull()
    expect(screen.queryByText('Old description')).toBeNull()
    expect(screen.queryByText('Workshop')).toBeNull()
    expect(screen.queryByText('Old Track')).toBeNull()

    // An unrelated answer still lists normally.
    expect(screen.getByText('Audience')).toBeTruthy()
    expect(screen.getByText('Beginners')).toBeTruthy()
  })

  it('reflects a post-edit refresh: the dl shows the new column value once, no stale duplicate', async () => {
    api.getSubmissionDetail.mockResolvedValue({
      submission: {
        id: 'sub-1', code: 'S-001', title: 'Designing for Doubt', status: 'pending',
        content_approved: 1, created_at: '2026-01-05T10:00:00Z', notified_at: null, notes: null,
        form_name: 'Main CFP', format: 'Talk', description: 'Original description',
      },
      answers: [
        { label: 'Description', value_json: JSON.stringify('Original description') },
      ],
      participants: [PARTICIPANT],
      reviews: [],
      tags: [],
    })

    render(<SubmissionDetailPanel id="sub-1" />)
    await screen.findByText('Original description')

    // Simulate a save that updated the column but left the frozen answer
    // text untouched — the defect this panel used to expose verbatim.
    api.getSubmissionDetail.mockResolvedValue({
      submission: {
        id: 'sub-1', code: 'S-001', title: 'Designing for Doubt', status: 'pending',
        content_approved: 1, created_at: '2026-01-05T10:00:00Z', notified_at: null, notes: null,
        form_name: 'Main CFP', format: 'Talk', description: 'Edited description',
      },
      answers: [
        { label: 'Description', value_json: JSON.stringify('Original description') },
      ],
      participants: [PARTICIPANT],
      reviews: [],
      tags: [],
    })
    const checkbox = await screen.findByLabelText('Visible in public agenda')
    checkbox.click()

    await screen.findByText('Edited description')
    expect(screen.queryByText('Original description')).toBeNull()
  })
})

describe('SubmissionDetailPanel — public visibility and status (CNT-12)', () => {
  it('persists the content_approved toggle and reports the save', async () => {
    const onItemSaved = vi.fn()
    render(<SubmissionDetailPanel id="sub-1" onItemSaved={onItemSaved} />)

    const checkbox = (await screen.findByLabelText('Visible in public agenda')) as HTMLInputElement
    expect(checkbox.checked).toBe(true)

    api.getSubmissionDetail.mockResolvedValue(detail({ content_approved: 0 }))
    checkbox.click()

    await waitFor(() =>
      expect(api.updateSubmission).toHaveBeenCalledWith('sub-1', { content_approved: false }),
    )
    await screen.findByText('Saved')
    await waitFor(() => {
      const refreshed = screen.getByLabelText('Visible in public agenda') as HTMLInputElement
      expect(refreshed.checked).toBe(false)
    })
    expect(onItemSaved).toHaveBeenCalledTimes(1)
  })

  it('changes the submission status in place', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    const select = (await screen.findByLabelText('Status')) as HTMLSelectElement
    api.getSubmissionDetail.mockResolvedValue(detail({ status: 'accepted' }))
    setValue(select, 'accepted')

    await waitFor(() => expect(api.updateSubmissionStatus).toHaveBeenCalledWith('sub-1', 'accepted'))
    await waitFor(() =>
      expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('accepted'),
    )
  })

  it('surfaces a failed save without losing the panel', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    const checkbox = await screen.findByLabelText('Visible in public agenda')
    api.updateSubmission.mockRejectedValue(new Error('forbidden'))
    checkbox.click()

    await screen.findByText('forbidden')
    expect(screen.getByText(/Designing for Doubt/)).toBeTruthy()
  })
})
