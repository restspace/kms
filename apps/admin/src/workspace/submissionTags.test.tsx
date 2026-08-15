/**
 * The detail panel's tag chips. Attaching a tag to an existing submission was
 * impossible from the app before this: `submission_tags` was written only by
 * the public form and the importer, so an organiser reading a proposal could
 * see its tags but never add "needs AV" to it.
 *
 * Pinned here: the write is the WHOLE set (so a removal cannot be mistaken for
 * an add), the picker offers only what is not already on, and inventing a tag
 * inline both creates it and attaches it in one gesture.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const pickOption = (select: HTMLSelectElement, value: string) => {
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

const api = vi.hoisted(() => ({
  getSubmissionDetail: vi.fn(),
  listTags: vi.fn(),
  createTag: vi.fn(),
  setSubmissionTags: vi.fn(),
  getMaterialsOwners: vi.fn(),
  getSubmissionFileComments: vi.fn(),
}))

vi.mock('../api', () => ({
  PARTICIPANT_ROLES: ['speaker'],
  getSubmissionDetail: api.getSubmissionDetail,
  listTags: api.listTags,
  createTag: api.createTag,
  setSubmissionTags: api.setSubmissionTags,
  getMaterialsOwners: api.getMaterialsOwners,
  getSubmissionFileComments: api.getSubmissionFileComments,
  updateSubmission: async () => ({ ok: true }),
  updateSubmissionStatus: async () => ({ ok: true }),
  updateSubmissionNotes: async () => ({ ok: true }),
  updateSubmissionIntroScript: async () => ({ ok: true }),
  updateSubmissionApproval: async () => ({ ok: true }),
  updateSubmissionCondition: async () => ({ ok: true }),
  updateSubmissionDecision: async () => ({ ok: true }),
  updateSubmissionMaterials: async () => ({ ok: true }),
  addSubmissionParticipant: async () => ({ ok: true }),
  removeSubmissionParticipant: async () => ({ ok: true }),
  updateSubmissionParticipantRole: async () => ({ ok: true }),
  setSubmissionParticipantConfirmed: async () => ({ ok: true }),
  addSubmissionComment: async () => ({ ok: true, comments: [] }),
  getSubmissionRevisions: async () => ({ items: [] }),
  queryResource: () => async () => ({ items: [], total: 0 }),
  listTracks: async () => ({ items: [] }),
  listRooms: async () => ({ items: [] }),
}))

vi.mock('./FilePanels', () => ({ SubmissionFilesPanel: () => <div /> }))
vi.mock('../components/dialogs', () => ({ appConfirm: async () => true, appAlert: async () => undefined }))

import { SubmissionDetailPanel } from './extras'

const AV = { id: 'tag-av', event_id: 'evt-1', name: 'needs AV', color: '#ff8800' }
const KEYNOTE = { id: 'tag-key', event_id: 'evt-1', name: 'keynote material', color: null }

const detail = (tags: Array<{ id: string; name: string; color: string | null }>) => ({
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
  },
  answers: [],
  participants: [],
  reviews: [],
  review_plan_means: [],
  comments: [],
  tags,
})

beforeEach(() => {
  vi.clearAllMocks()
  api.getSubmissionDetail.mockResolvedValue(detail([AV]))
  api.listTags.mockResolvedValue({ items: [AV, KEYNOTE] })
  api.setSubmissionTags.mockResolvedValue({ ok: true, tags: [] })
  api.getMaterialsOwners.mockResolvedValue({ items: [] })
  api.getSubmissionFileComments.mockResolvedValue({ items: [] })
})

describe('submission tag chips', () => {
  it('offers only the tags not already on, and attaches keeping the existing ones', async () => {
    render(<SubmissionDetailPanel id="sub-1" />)
    const select = (await screen.findByLabelText('Add a tag')) as HTMLSelectElement
    // The vocabulary arrives after the first paint.
    await screen.findByRole('option', { name: 'keynote material' })
    // "needs AV" is already on the submission, so it is not offered again.
    expect([...select.options].map((o) => o.textContent)).toEqual(['+ Add tag…', 'keynote material', 'New tag…'])

    pickOption(select, 'tag-key')
    // The whole set, not a delta — the tag already on rides along.
    await waitFor(() => expect(api.setSubmissionTags).toHaveBeenCalledWith('sub-1', ['tag-av', 'tag-key']))
  })

  it('removes one chip by writing the set without it', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail([AV, KEYNOTE]))
    render(<SubmissionDetailPanel id="sub-1" />)

    fireEvent.click(await screen.findByLabelText('Remove tag needs AV'))
    await waitFor(() => expect(api.setSubmissionTags).toHaveBeenCalledWith('sub-1', ['tag-key']))
  })

  it('creates a tag inline and attaches it in the same gesture', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail([]))
    api.createTag.mockResolvedValue({ id: 'tag-new', event_id: 'evt-1', name: 'first-timer', color: null })

    render(<SubmissionDetailPanel id="sub-1" />)
    pickOption((await screen.findByLabelText('Add a tag')) as HTMLSelectElement, '__new__')

    const input = await screen.findByLabelText('New tag name')
    fireEvent.input(input, { target: { value: '  first-timer  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.createTag).toHaveBeenCalledWith({ name: 'first-timer' }))
    await waitFor(() => expect(api.setSubmissionTags).toHaveBeenCalledWith('sub-1', ['tag-new']))
  })

  it('attaches an existing tag rather than reporting a collision when the typed name is already known', async () => {
    api.getSubmissionDetail.mockResolvedValue(detail([]))

    render(<SubmissionDetailPanel id="sub-1" />)
    pickOption((await screen.findByLabelText('Add a tag')) as HTMLSelectElement, '__new__')

    const input = await screen.findByLabelText('New tag name')
    fireEvent.input(input, { target: { value: 'NEEDS av' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(api.setSubmissionTags).toHaveBeenCalledWith('sub-1', ['tag-av']))
    expect(api.createTag).not.toHaveBeenCalled()
  })
})
