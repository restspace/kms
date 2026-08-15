/**
 * Workplan 15 W2/W3 in the submission detail panel.
 *
 * Both waves store a *flag alongside the status*, never a status value — a
 * speaker is accepted AND owes a co-presenter (D4), and a "revise and
 * resubmit" is a decline that reads differently (D5). What that buys is only
 * real if the panel shows both axes and if editing one never moves the other,
 * which is what these pin:
 *
 *  - the condition chip distinguishes outstanding from met;
 *  - "Mark condition met" writes the flag and never touches status;
 *  - a condition typed beside the status editor rides the accept itself;
 *  - the revise flag and its speaker-facing guidance save independently.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/preact'

const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  el.value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

/** preact/compat routes onBlur to the bubbling focusout event. */
const blur = (el: HTMLElement) => {
  el.dispatchEvent(new Event('blur', { bubbles: true }))
  el.dispatchEvent(new Event('focusout', { bubbles: true }))
}

/** Let preact flush the state update a handler just queued, so the next
 *  handler runs against the re-rendered closure. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  updateSubmission: vi.fn(),
  updateSubmissionStatus: vi.fn(),
  updateSubmissionNotes: vi.fn(),
  updateSubmissionCondition: vi.fn(),
  updateSubmissionDecision: vi.fn(),
  getMaterialsOwners: vi.fn(),
  getSubmissionFileComments: vi.fn(),
  updateSubmissionMaterials: vi.fn(),
  contactSearch: vi.fn(),
}))

vi.mock('../api', () => ({
  PARTICIPANT_ROLES: ['speaker', 'co-speaker'],
  getSubmissionDetail: api.getSubmissionDetail,
  updateSubmission: api.updateSubmission,
  updateSubmissionStatus: api.updateSubmissionStatus,
  updateSubmissionNotes: api.updateSubmissionNotes,
  updateSubmissionCondition: api.updateSubmissionCondition,
  updateSubmissionDecision: api.updateSubmissionDecision,
  updateSubmissionApproval: vi.fn(),
  updateSubmissionIntroScript: vi.fn(),
  addSubmissionParticipant: vi.fn(),
  removeSubmissionParticipant: vi.fn(),
  updateSubmissionParticipantRole: vi.fn(),
  setSubmissionParticipantConfirmed: vi.fn(),
  addSubmissionComment: vi.fn(),
  queryResource: () => api.contactSearch,
  listTracks: async () => ({ items: [] }),
  listRooms: async () => ({ items: [] }),
  // The detail panel's tag chips are an editor: it reads the vocabulary on
  // mount and writes the whole set. Not under test here.
  listTags: async () => ({ items: [] }),
  createTag: async () => ({ id: 't-1', event_id: 'evt-1', name: 'new', color: null }),
  setSubmissionTags: async () => ({ ok: true, tags: [] }),
  getSubmissionRevisions: async () => ({ items: [] }),
  getMaterialsOwners: api.getMaterialsOwners,
  getSubmissionFileComments: api.getSubmissionFileComments,
  updateSubmissionMaterials: api.updateSubmissionMaterials,
}))

vi.mock('./FilePanels', () => ({
  SubmissionFilesPanel: () => <div data-testid="files-panel" />,
}))

vi.mock('../components/dialogs', () => ({
  appConfirm: async () => true,
  appAlert: async () => undefined,
}))

import { SubmissionDetailPanel } from './extras'

const detail = (overrides: Record<string, unknown> = {}) => ({
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
    accept_condition: null,
    condition_met_at: null,
    decision_outcome: null,
    revise_guidance: null,
    ...overrides,
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
  api.updateSubmissionStatus.mockResolvedValue({ ok: true })
  api.updateSubmissionCondition.mockResolvedValue({ ok: true })
  api.updateSubmissionDecision.mockResolvedValue({ ok: true })
  api.contactSearch.mockResolvedValue({ items: [], total: 0 })
  api.getMaterialsOwners.mockResolvedValue({ items: [] })
  api.getSubmissionFileComments.mockResolvedValue({ items: [] })
})

describe('conditional accept in the detail panel (W2)', () => {
  it('chips an outstanding condition beside the status, and a met one differently', async () => {
    api.getSubmissionDetail.mockResolvedValue(
      detail({ accept_condition: 'Needs a business co-presenter' }),
    )
    const { rerender } = render(<SubmissionDetailPanel id="sub-1" />)
    await screen.findByText('Condition outstanding')

    api.getSubmissionDetail.mockResolvedValue(
      detail({ accept_condition: 'Needs a business co-presenter', condition_met_at: '2026-08-10T00:00:00Z' }),
    )
    rerender(<SubmissionDetailPanel id="sub-2" />)
    await screen.findByText('Condition met')
  })

  it('marks a condition met without changing the status', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail({ accept_condition: 'Needs a co-presenter' }))
    render(<SubmissionDetailPanel id="sub-1" />)

    const button = await screen.findByRole('button', { name: /mark condition met/i })
    button.click()

    await waitFor(() =>
      expect(api.updateSubmissionCondition).toHaveBeenCalledWith('sub-1', { condition_met: true }),
    )
    // D4: the two axes are independent. Signing off a condition is not a
    // re-decision, so nothing here may write status.
    expect(api.updateSubmissionStatus).not.toHaveBeenCalled()
  })

  it('sends a condition typed beside the status editor with the accept itself', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)

    const condition = (await screen.findByLabelText('Condition')) as HTMLInputElement
    setValue(condition, 'Needs a business co-presenter')
    await flush()
    const status = screen.getByLabelText('Status') as HTMLSelectElement
    setValue(status, 'accepted')

    await waitFor(() =>
      expect(api.updateSubmissionStatus).toHaveBeenCalledWith(
        'sub-1',
        'accepted',
        'Needs a business co-presenter',
      ),
    )
  })
})

describe('revise and resubmit in the detail panel (W3)', () => {
  it('flags the outcome without touching status, and shows the chip', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail({ status: 'declined' }))
    render(<SubmissionDetailPanel id="sub-1" />)

    const outcome = (await screen.findByLabelText('Outcome')) as HTMLSelectElement
    api.getSubmissionDetail.mockResolvedValue(detail({ status: 'declined', decision_outcome: 'revise' }))
    setValue(outcome, 'revise')

    await waitFor(() =>
      expect(api.updateSubmissionDecision).toHaveBeenCalledWith('sub-1', { decision_outcome: 'revise' }),
    )
    expect(api.updateSubmissionStatus).not.toHaveBeenCalled()
    // The flag is the only thing that says this is not a plain decline — the
    // status column cannot (D5). Matched on the chip, since the Outcome
    // select carries the same words as an option.
    await waitFor(() => {
      const chips = screen.getAllByText('Revise & resubmit')
      expect(chips.some((el) => el.className.includes('status-chip'))).toBe(true)
    })
  })

  it('saves the speaker-facing guidance on blur once the flag is set', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail({ status: 'declined', decision_outcome: 'revise' }))
    render(<SubmissionDetailPanel id="sub-1" />)

    const guidance = (await screen.findByLabelText('Revise guidance')) as HTMLInputElement
    setValue(guidance, 'Cut the vendor section.')
    await flush()
    blur(guidance)

    await waitFor(() =>
      expect(api.updateSubmissionDecision).toHaveBeenCalledWith('sub-1', {
        revise_guidance: 'Cut the vendor section.',
      }),
    )
  })
})
