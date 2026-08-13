/**
 * Workplan 15 W5d — one thread, not two.
 *
 * The document's complaint is that deck feedback and the discussion that got
 * the talk accepted live on two surfaces, so the organiser reading the record
 * sees half the history. The detail panel now renders `file_comments` inline
 * beneath the `submission_comments` thread, labelled by the version they were
 * left on: a v1 note keeps pointing at the deck it described after v2 lands,
 * which is exactly what makes the label worth showing.
 *
 * W5a's editors ride along here — the materials state and the deck reviewer,
 * beside the status editor for the same reason approval is.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const setValue = (el: HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  getMaterialsOwners: vi.fn(),
  getSubmissionFileComments: vi.fn(),
  updateSubmissionMaterials: vi.fn(),
}))

vi.mock('../api', () => ({
  PARTICIPANT_ROLES: ['speaker', 'co-speaker'],
  getSubmissionDetail: api.getSubmissionDetail,
  getMaterialsOwners: api.getMaterialsOwners,
  getSubmissionFileComments: api.getSubmissionFileComments,
  updateSubmissionMaterials: api.updateSubmissionMaterials,
  updateSubmission: vi.fn(),
  updateSubmissionStatus: vi.fn(),
  updateSubmissionNotes: vi.fn(),
  updateSubmissionApproval: vi.fn(),
  updateSubmissionIntroScript: vi.fn(),
  addSubmissionParticipant: vi.fn(),
  removeSubmissionParticipant: vi.fn(),
  updateSubmissionParticipantRole: vi.fn(),
  setSubmissionParticipantConfirmed: vi.fn(),
  addSubmissionComment: vi.fn(),
  queryResource: () => vi.fn().mockResolvedValue({ items: [], total: 0 }),
  listTracks: async () => ({ items: [] }),
  listRooms: async () => ({ items: [] }),
  getSubmissionRevisions: async () => ({ items: [] }),
}))

vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  appAlert: async () => undefined,
}))

import { SubmissionDetailPanel } from './extras'

const detail = (submission: Record<string, unknown> = {}) => ({
  submission: {
    id: 'sub-1',
    code: 'S-001',
    title: 'Designing for Doubt',
    status: 'accepted',
    content_approved: 1,
    created_at: '2026-01-05T10:00:00Z',
    notified_at: null,
    notes: null,
    form_name: 'Main CFP',
    ...submission,
  },
  answers: [],
  participants: [],
  reviews: [],
  review_plan_means: [],
  comments: [],
  tags: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  api.getSubmissionDetail.mockResolvedValue(detail())
  api.getMaterialsOwners.mockResolvedValue({ items: [] })
  api.getSubmissionFileComments.mockResolvedValue({ items: [] })
  api.updateSubmissionMaterials.mockResolvedValue({ ok: true })
})

describe('SubmissionDetailPanel — materials feedback thread (W5d)', () => {
  it('keeps a v1 comment visible and labelled v1 after v2 lands', async () => {
    api.getSubmissionFileComments.mockResolvedValue({
      items: [
        {
          id: 'fc-1',
          author_role: 'admin',
          author_name: 'Jordan Lee',
          body: 'Slide 12 is unreadable.',
          created_at: '2026-02-01T10:00:00Z',
          version: 1,
          filename: 'slides.pdf',
        },
        {
          id: 'fc-2',
          author_role: 'speaker',
          author_name: 'Priya Raman',
          body: 'Fixed — new deck attached.',
          created_at: '2026-02-04T10:00:00Z',
          version: 2,
          filename: 'slides.pdf',
        },
      ],
    })
    render(<SubmissionDetailPanel id="sub-1" />)

    const v1 = await screen.findByText('Slide 12 is unreadable.')
    // The older note survives the re-upload rather than being superseded…
    expect(v1).toBeTruthy()
    // …and still names the version it was written against (0007's anchoring).
    const head = (v1.closest('.file-comment') as HTMLElement).querySelector('.fc-head') as HTMLElement
    expect(head.textContent).toContain('slides.pdf v1')
    expect(head.textContent).toContain('Jordan Lee')

    const v2 = screen.getByText('Fixed — new deck attached.')
    const v2Head = (v2.closest('.file-comment') as HTMLElement).querySelector('.fc-head') as HTMLElement
    expect(v2Head.textContent).toContain('slides.pdf v2')
    expect(v2Head.textContent).toContain('Speaker')

    // One history: the deck feedback sits inside the same panel as the
    // discussion that got the talk accepted, not on another surface.
    expect(screen.getByText('Discussion')).toBeTruthy()
    expect(screen.getByText(/Materials feedback/)).toBeTruthy()
  })

  it('omits the section entirely when no deck comments exist', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    await screen.findByText('Designing for Doubt')
    expect(screen.queryByText(/Materials feedback/)).toBeNull()
  })
})

describe('SubmissionDetailPanel — materials state and deck reviewer (W5a)', () => {
  it('sets a human state and never offers "received" as a choice', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    const select = (await screen.findByLabelText('Materials')) as HTMLSelectElement
    // 'received' is what an upload sets; offering it would add a click to
    // every deck for a transition no human needs to make.
    const enabled = [...select.options].filter((o) => !o.disabled).map((o) => o.value)
    expect(enabled).toEqual(['', 'reviewed', 'revision_requested', 'final'])

    api.getSubmissionDetail.mockResolvedValue(detail({ materials_state: 'revision_requested' }))
    setValue(select, 'revision_requested')

    await waitFor(() =>
      expect(api.updateSubmissionMaterials).toHaveBeenCalledWith('sub-1', {
        materials_state: 'revision_requested',
      }),
    )
    await screen.findByText('Revision requested')
  })

  it('assigns the deck to one of the event\'s seats, on its own', async () => {
    api.getMaterialsOwners.mockResolvedValue({
      items: [{ id: 'c-9', email: 'ada@example.com', name: 'Ada Lovelace' }],
    })
    render(<SubmissionDetailPanel id="sub-1" />)

    const owner = (await screen.findByLabelText('Deck reviewer')) as HTMLSelectElement
    await waitFor(() => expect(owner.options.length).toBe(2))
    setValue(owner, 'c-9')

    // Owner and state are independent writes: reassigning must not restart
    // the second chase's clock.
    await waitFor(() =>
      expect(api.updateSubmissionMaterials).toHaveBeenCalledWith('sub-1', { materials_owner_id: 'c-9' }),
    )
  })
})
